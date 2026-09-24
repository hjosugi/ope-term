//! Headless reliability soak driver.
//!
//! Drives the production SSH session code (`ssh::run`) without a WebView so a
//! long soak with network fault injection can run unattended (systemd timer,
//! scheduled CI). It applies the same reconnect policy as the UI
//! (`src/reconnect.ts`), proves liveness with shell heartbeats, and writes an
//! aggregate JSON report: counts, causes, and latencies only — never terminal
//! content, credentials, or environment values.
//!
//! The driver is strictly non-interactive: an unknown or changed host key is
//! rejected and any password / keyboard-interactive prompt is cancelled, so it
//! only works with keys already in `known_hosts` and agent / unencrypted keys.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody, Response};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::mpsc;

use crate::ssh::{
    self, AuthAnswer, CloseReason, ConnectRequest, HostKeyAnswer, HostKeyDecision, SessionCommand,
    SessionEnd,
};

/// Mirrors `MAX_AUTO_RETRIES` in `src/reconnect.ts`.
pub const MAX_AUTO_RETRIES: u32 = 5;
const BASE_RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);
const ACK_MARKER: &[u8] = b"ope-term-soak-ack-";
const MAX_PENDING_OUTPUT: usize = 4 * 1024;
const MAX_RECORDED_ERRORS: usize = 50;
const MAX_LATENCY_SAMPLES: usize = 100_000;
const READY_TIMEOUT: Duration = Duration::from_secs(90);

/// Exponential backoff shared with the UI: 1, 2, 4, 8, 16 s, capped at 30 s.
pub fn retry_delay(attempt: u32) -> Duration {
    let exponent = attempt.saturating_sub(1).min(16);
    BASE_RETRY_DELAY
        .saturating_mul(1_u32 << exponent)
        .min(MAX_RETRY_DELAY)
}

/// Mirrors `shouldAutoRetry` in `src/reconnect.ts`.
pub fn should_auto_retry(end: &SessionEnd, attempt: u32, reconnecting: bool) -> bool {
    if attempt > MAX_AUTO_RETRIES {
        return false;
    }
    match end.reason {
        CloseReason::Transport => true,
        CloseReason::Failed => {
            reconnecting
                && matches!(
                    end.cause,
                    Some(ssh::DisconnectCause::Timeout | ssh::DisconnectCause::Network)
                )
        }
        CloseReason::Local | CloseReason::Remote => false,
    }
}

/// The shell command for one heartbeat. The echoed command line contains
/// `ope-term-soak-ack-%s`, so only the command's own output matches the marker.
pub fn heartbeat_command(sequence: u64) -> String {
    format!("printf 'ope-term-soak-ack-%s\\n' {sequence}\r")
}

/// Finds heartbeat acknowledgements in terminal output split across frames.
#[derive(Default)]
pub struct AckScanner {
    pending: Vec<u8>,
}

impl AckScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u64> {
        self.pending.extend_from_slice(bytes);
        let mut acks = Vec::new();
        let mut cursor = 0;
        let mut incomplete = None;
        while let Some(offset) = find(&self.pending[cursor..], ACK_MARKER) {
            let start = cursor + offset;
            let digits_start = start + ACK_MARKER.len();
            let digits = self.pending[digits_start..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            let end = digits_start + digits;
            if end == self.pending.len() {
                incomplete = Some(start);
                break;
            }
            if (1..=19).contains(&digits)
                && matches!(self.pending[end], b'\r' | b'\n')
                && let Some(sequence) = std::str::from_utf8(&self.pending[digits_start..end])
                    .ok()
                    .and_then(|text| text.parse::<u64>().ok())
            {
                acks.push(sequence);
            }
            cursor = end;
        }
        let keep_from = incomplete.unwrap_or_else(|| {
            self.pending
                .len()
                .saturating_sub(ACK_MARKER.len() - 1)
                .max(cursor)
        });
        self.pending.drain(..keep_from);
        if self.pending.len() > MAX_PENDING_OUTPUT {
            let excess = self.pending.len() - (ACK_MARKER.len() - 1);
            self.pending.drain(..excess);
        }
        acks
    }
}

/// Primary Device Attributes response of xterm.js, which the app sends too.
pub const PRIMARY_DEVICE_ATTRIBUTES: &str = "\x1b[?1;2c";

/// Detects Primary Device Attributes queries (`CSI c` / `CSI 0 c`).
///
/// Shells such as fish 4 query the terminal at startup and block until DA1 is
/// answered. xterm.js answers it in the app; the headless driver must as well,
/// or the shell never reads the heartbeat commands.
#[derive(Default)]
pub struct DeviceAttributesQueries {
    tail: Vec<u8>,
}

impl DeviceAttributesQueries {
    pub fn feed(&mut self, bytes: &[u8]) -> usize {
        const QUERIES: [&[u8]; 2] = [b"\x1b[c", b"\x1b[0c"];
        self.tail.extend_from_slice(bytes);
        let mut count = 0;
        let mut index = 0;
        let mut consumed = 0;
        while index < self.tail.len() {
            if let Some(query) = QUERIES
                .iter()
                .find(|query| self.tail[index..].starts_with(query))
            {
                count += 1;
                index += query.len();
                consumed = index;
            } else {
                index += 1;
            }
        }
        // Keep only a possible query prefix that a later frame may complete.
        let keep_from = self.tail.len().saturating_sub(3).max(consumed);
        self.tail.drain(..keep_from);
        count
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, Clone)]
pub struct SoakOptions {
    pub route: Vec<String>,
    pub duration: Duration,
    pub heartbeat_interval: Duration,
    pub heartbeat_timeout: Duration,
    /// Delay before the "operator" retries after the automatic budget ran out.
    pub manual_retry_delay: Duration,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub samples: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatSummary {
    pub sent: u64,
    pub acknowledged: u64,
    /// Not acknowledged within the timeout on a link that later answered again
    /// or that ended without a transport fault: the shell itself stalled.
    pub missed: u64,
    /// Acknowledged more than once: evidence of a replayed command.
    pub duplicates: u64,
    /// Lost to an injected fault: in flight or timed out on a link that then
    /// died of a transport loss. Dropped, never resent on the next shell.
    pub dropped_by_disconnect: u64,
    pub round_trip: LatencySummary,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoakReport {
    pub schema_version: u32,
    pub kind: &'static str,
    pub started_at: String,
    pub ended_at: String,
    pub duration_seconds: f64,
    pub route: Vec<String>,
    pub connection_attempts: u64,
    pub ready_sessions: u64,
    /// Shells that became ready again after a transport loss.
    pub auto_reconnects: u64,
    /// Times the automatic budget ran out and a manual retry was needed.
    pub exhausted_retry_budgets: u64,
    /// Closes that the soak cannot explain as an injected fault, e.g. a
    /// rejected host key, an authentication failure, or a remote shell exit.
    pub unexpected_closes: u64,
    /// `reason` or `reason:cause`, e.g. `transport:timeout`.
    pub closes: BTreeMap<String, u64>,
    pub reconnect_latency: LatencySummary,
    pub heartbeats: HeartbeatSummary,
    pub errors: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireEvent {
    HostKeyPrompt {
        prompt: WirePrompt,
    },
    AuthPrompt {
        prompt: WirePrompt,
    },
    Ready,
    Error {
        message: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePrompt {
    request_id: String,
}

enum DriverEvent {
    Ready,
    Output(Vec<u8>),
    Error(String),
}

struct Collector {
    report: SoakReport,
    round_trips: Vec<f64>,
    reconnects: Vec<f64>,
}

impl Collector {
    fn error(&mut self, message: impl Into<String>) {
        if self.report.errors.len() < MAX_RECORDED_ERRORS {
            self.report.errors.push(message.into());
        }
    }

    fn close(&mut self, end: &SessionEnd) {
        let reason = serde_plain(&end.reason);
        let key = match end.cause {
            Some(cause) => format!("{reason}:{}", serde_plain(&cause)),
            None => reason,
        };
        *self.report.closes.entry(key).or_default() += 1;
    }
}

fn serde_plain<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".to_owned())
}

fn summarize(samples: &mut [f64]) -> LatencySummary {
    if samples.is_empty() {
        return LatencySummary::default();
    }
    samples.sort_by(f64::total_cmp);
    let at = |fraction: f64| {
        let index = ((fraction * samples.len() as f64).ceil() as usize).saturating_sub(1);
        samples[index.min(samples.len() - 1)]
    };
    LatencySummary {
        samples: samples.len(),
        p50_ms: round(at(0.5)),
        p95_ms: round(at(0.95)),
        max_ms: round(samples[samples.len() - 1]),
    }
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "unknown".to_owned())
}

/// Runs one soak and returns its report. Never panics on connection failure:
/// every failure is counted, and the loop keeps reconnecting until `duration`.
pub async fn run_soak(options: SoakOptions) -> Result<SoakReport> {
    if options.route.is_empty() {
        bail!("soak route が空です");
    }
    if options.heartbeat_interval.is_zero() || options.heartbeat_timeout.is_zero() {
        bail!("heartbeat interval / timeout は 0 より大きくしてください");
    }
    let started = Instant::now();
    let deadline = started + options.duration;
    let mut collector = Collector {
        report: SoakReport {
            schema_version: 1,
            kind: "ope-term-soak-client",
            started_at: now_rfc3339(),
            route: options.route.clone(),
            ..SoakReport::default()
        },
        round_trips: Vec::new(),
        reconnects: Vec::new(),
    };
    let mut sequence = 0_u64;
    let mut acknowledged = HashSet::<u64>::new();
    let mut attempt = 0_u32;
    let mut lost_at: Option<Instant> = None;

    while Instant::now() < deadline {
        collector.report.connection_attempts += 1;
        let (end, ready) = run_connection(
            &options,
            deadline,
            &mut sequence,
            &mut acknowledged,
            &mut collector,
            lost_at,
        )
        .await;
        if ready {
            attempt = 0;
            lost_at = None;
        }
        collector.close(&end);
        if Instant::now() >= deadline {
            break;
        }
        let transport_like = matches!(end.reason, CloseReason::Transport | CloseReason::Failed)
            && matches!(
                end.cause,
                Some(ssh::DisconnectCause::Timeout | ssh::DisconnectCause::Network)
            );
        // The outage starts at the first loss; failed attempts do not move it.
        if transport_like {
            lost_at.get_or_insert_with(Instant::now);
        } else {
            lost_at = None;
        }
        let reconnecting = attempt > 0 || (ready && end.reason == CloseReason::Transport);
        attempt += 1;
        if should_auto_retry(&end, attempt, reconnecting) {
            sleep_until(Instant::now() + retry_delay(attempt), deadline).await;
            continue;
        }
        if transport_like {
            collector.report.exhausted_retry_budgets += 1;
        } else {
            collector.report.unexpected_closes += 1;
        }
        // Model the operator pressing "reconnect" after looking at the tab.
        attempt = 0;
        sleep_until(Instant::now() + options.manual_retry_delay, deadline).await;
    }

    collector.report.ended_at = now_rfc3339();
    collector.report.duration_seconds = round(started.elapsed().as_secs_f64());
    collector.report.heartbeats.round_trip = summarize(&mut collector.round_trips);
    collector.report.reconnect_latency = summarize(&mut collector.reconnects);
    Ok(collector.report)
}

async fn sleep_until(target: Instant, deadline: Instant) {
    let until = target.min(deadline);
    tokio::time::sleep(until.saturating_duration_since(Instant::now())).await;
}

/// Runs one connection until it closes or the soak deadline passes, returning
/// how it ended and whether its shell became ready.
async fn run_connection(
    options: &SoakOptions,
    deadline: Instant,
    sequence: &mut u64,
    acknowledged: &mut HashSet<u64>,
    collector: &mut Collector,
    lost_at: Option<Instant>,
) -> (SessionEnd, bool) {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<DriverEvent>();
    let (command_tx, command_rx) = mpsc::channel::<SessionCommand>(64);
    let (host_key_tx, host_key_rx) = mpsc::channel::<HostKeyAnswer>(8);
    let (auth_tx, auth_rx) = mpsc::channel::<AuthAnswer>(8);

    let events = {
        let event_tx = event_tx.clone();
        let host_key_tx = host_key_tx.clone();
        let auth_tx = auth_tx.clone();
        Channel::<ssh::SessionEvent>::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                return Ok(());
            };
            match serde_json::from_str::<WireEvent>(&json) {
                Ok(WireEvent::Ready) => {
                    let _ = event_tx.send(DriverEvent::Ready);
                }
                Ok(WireEvent::HostKeyPrompt { prompt }) => {
                    let _ = host_key_tx.try_send(HostKeyAnswer {
                        request_id: Some(prompt.request_id),
                        decision: HostKeyDecision::Reject,
                    });
                    let _ = event_tx.send(DriverEvent::Error(
                        "host key が known_hosts に無いか変更されたため拒否しました".to_owned(),
                    ));
                }
                Ok(WireEvent::AuthPrompt { prompt }) => {
                    let _ = auth_tx.try_send(AuthAnswer {
                        request_id: Some(prompt.request_id),
                        responses: Vec::new(),
                        cancelled: true,
                    });
                    let _ = event_tx.send(DriverEvent::Error(
                        "対話認証が必要なため中止しました（agent か passphrase 無し鍵を使用）"
                            .to_owned(),
                    ));
                }
                Ok(WireEvent::Error { message }) => {
                    let _ = event_tx.send(DriverEvent::Error(message));
                }
                Ok(WireEvent::Other) | Err(_) => {}
            }
            Ok(())
        })
    };
    let data = {
        let event_tx = event_tx.clone();
        Channel::<Response>::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                let _ = event_tx.send(DriverEvent::Output(bytes));
            }
            Ok(())
        })
    };
    drop(event_tx);

    let request = ConnectRequest {
        session_id: uuid::Uuid::new_v4().hyphenated().to_string(),
        route: options.route.clone(),
        cols: 120,
        rows: 40,
        log: None,
    };
    let mut session = tokio::spawn(ssh::run(
        request,
        None,
        events,
        data,
        command_rx,
        host_key_rx,
        auth_rx,
    ));

    let mut scanner = AckScanner::default();
    let mut queries = DeviceAttributesQueries::default();
    let mut in_flight = HashMap::<u64, Instant>::new();
    // Timed-out heartbeats since the last acknowledgement. If the link then
    // dies of a transport loss they were the fault's, otherwise the shell's.
    let mut unanswered = 0_u64;
    let mut ready = false;
    let ready_deadline = Instant::now() + READY_TIMEOUT;
    let mut next_heartbeat = Instant::now();
    let mut closing = false;

    let end = loop {
        let wake = if ready {
            next_heartbeat.min(deadline)
        } else {
            ready_deadline.min(deadline)
        };
        tokio::select! {
            joined = &mut session => {
                break match joined {
                    Ok(Ok(end)) => end,
                    Ok(Err(failure)) => {
                        collector.error(format!("{:#}", failure.error));
                        failure.end()
                    }
                    Err(error) => {
                        collector.error(format!("session task: {error}"));
                        CloseReason::Failed.into()
                    }
                };
            }
            event = event_rx.recv(), if !closing => match event {
                Some(DriverEvent::Ready) => {
                    ready = true;
                    collector.report.ready_sessions += 1;
                    if let Some(lost) = lost_at {
                        collector.report.auto_reconnects += 1;
                        if collector.reconnects.len() < MAX_LATENCY_SAMPLES {
                            collector.reconnects.push(lost.elapsed().as_secs_f64() * 1000.0);
                        }
                    }
                    next_heartbeat = Instant::now();
                }
                Some(DriverEvent::Output(bytes)) => {
                    for _ in 0..queries.feed(&bytes) {
                        let _ = command_tx
                            .send(SessionCommand::Input(PRIMARY_DEVICE_ATTRIBUTES.to_owned()))
                            .await;
                    }
                    for ack in scanner.feed(&bytes) {
                        if !acknowledged.insert(ack) {
                            collector.report.heartbeats.duplicates += 1;
                        } else if let Some(sent) = in_flight.remove(&ack) {
                            collector.report.heartbeats.acknowledged += 1;
                            collector.report.heartbeats.missed += std::mem::take(&mut unanswered);
                            if collector.round_trips.len() < MAX_LATENCY_SAMPLES {
                                collector.round_trips.push(sent.elapsed().as_secs_f64() * 1000.0);
                            }
                        }
                    }
                }
                Some(DriverEvent::Error(message)) => collector.error(message),
                None => {}
            },
            () = tokio::time::sleep_until(wake.into()), if !closing => {
                let now = Instant::now();
                if now >= deadline || (!ready && now >= ready_deadline) {
                    if !ready {
                        collector.error("shell が準備完了になりませんでした");
                    }
                    closing = true;
                    let _ = command_tx.send(SessionCommand::Close).await;
                    continue;
                }
                if ready && now >= next_heartbeat {
                    let timeout = options.heartbeat_timeout;
                    let expired = in_flight
                        .iter()
                        .filter(|(_, sent)| now.duration_since(**sent) > timeout)
                        .map(|(sequence, _)| *sequence)
                        .collect::<Vec<_>>();
                    for sequence in expired {
                        in_flight.remove(&sequence);
                        unanswered += 1;
                    }
                    *sequence += 1;
                    if command_tx
                        .send(SessionCommand::Input(heartbeat_command(*sequence)))
                        .await
                        .is_ok()
                    {
                        collector.report.heartbeats.sent += 1;
                        in_flight.insert(*sequence, now);
                    }
                    next_heartbeat = now + options.heartbeat_interval;
                }
            }
        }
    };
    // Heartbeats in flight on a dead link are dropped, never replayed.
    collector.report.heartbeats.dropped_by_disconnect += in_flight.len() as u64;
    if is_transport_loss(&end) {
        collector.report.heartbeats.dropped_by_disconnect += unanswered;
    } else {
        collector.report.heartbeats.missed += unanswered;
    }
    (end, ready)
}

fn is_transport_loss(end: &SessionEnd) -> bool {
    end.reason == CloseReason::Transport
}

/// Parses `--flag value` arguments for the soak example binary.
pub fn parse_arguments(args: &[String]) -> Result<(SoakOptions, PathBuf)> {
    let mut route = Vec::new();
    let mut duration = Duration::from_secs(24 * 60 * 60);
    let mut heartbeat_interval = Duration::from_secs(10);
    let mut heartbeat_timeout = Duration::from_secs(30);
    let mut manual_retry_delay = Duration::from_secs(60);
    let mut report = PathBuf::from("artifacts/reliability/client.json");
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = args
            .get(index + 1)
            .ok_or_else(|| anyhow!("{flag} の値がありません"))?;
        let seconds = || -> Result<Duration> {
            let parsed = value
                .parse::<u64>()
                .with_context(|| format!("{flag} は正の整数秒にしてください"))?;
            if parsed == 0 {
                bail!("{flag} は正の整数秒にしてください");
            }
            Ok(Duration::from_secs(parsed))
        };
        match flag {
            "--route" => {
                route = value
                    .split(',')
                    .map(str::trim)
                    .filter(|alias| !alias.is_empty())
                    .map(str::to_owned)
                    .collect();
            }
            "--duration-seconds" => duration = seconds()?,
            "--heartbeat-seconds" => heartbeat_interval = seconds()?,
            "--heartbeat-timeout-seconds" => heartbeat_timeout = seconds()?,
            "--manual-retry-seconds" => manual_retry_delay = seconds()?,
            "--report" => report = PathBuf::from(value),
            _ => bail!("不明な option です: {flag}"),
        }
        index += 2;
    }
    if route.is_empty() {
        bail!(
            "Usage: reliability_soak --route <alias[,alias...]> [--duration-seconds 86400] [--heartbeat-seconds 10] [--heartbeat-timeout-seconds 30] [--manual-retry-seconds 60] [--report path]"
        );
    }
    Ok((
        SoakOptions {
            route,
            duration,
            heartbeat_interval,
            heartbeat_timeout,
            manual_retry_delay,
        },
        report,
    ))
}

/// Entry point for `cargo run --example reliability_soak`.
pub fn main_with_args(args: Vec<String>) -> Result<()> {
    let (options, report_path) = parse_arguments(&args)?;
    let report = tauri::async_runtime::block_on(run_soak(options))?;
    if let Some(parent) = report_path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).context("report directory を作成できません")?;
    }
    let json = serde_json::to_string_pretty(&report)?;
    std::fs::write(&report_path, format!("{json}\n"))
        .with_context(|| format!("{} へ report を書けません", report_path.display()))?;
    println!("{json}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_matches_the_ui_schedule() {
        let delays = (1..=6).map(retry_delay).collect::<Vec<_>>();
        assert_eq!(
            delays,
            [1, 2, 4, 8, 16, 30].map(Duration::from_secs).to_vec()
        );
        assert_eq!(retry_delay(0), Duration::from_secs(1));
        assert_eq!(retry_delay(u32::MAX), MAX_RETRY_DELAY);
    }

    #[test]
    fn retries_like_the_ui_policy() {
        let end = |reason, cause| SessionEnd {
            reason,
            cause,
            hop: None,
        };
        let transport = end(CloseReason::Transport, Some(ssh::DisconnectCause::Timeout));
        assert!(should_auto_retry(&transport, 1, false));
        assert!(!should_auto_retry(&transport, MAX_AUTO_RETRIES + 1, true));
        let unreachable = end(CloseReason::Failed, Some(ssh::DisconnectCause::Network));
        assert!(should_auto_retry(&unreachable, 2, true));
        assert!(!should_auto_retry(&unreachable, 1, false));
        assert!(!should_auto_retry(&end(CloseReason::Failed, None), 2, true));
        assert!(!should_auto_retry(
            &end(
                CloseReason::Remote,
                Some(ssh::DisconnectCause::ServerDisconnect)
            ),
            1,
            true
        ));
    }

    #[test]
    fn heartbeat_output_matches_but_the_echoed_command_does_not() {
        let command = heartbeat_command(42);
        let mut scanner = AckScanner::default();
        // The terminal echoes the command line before its output.
        assert!(scanner.feed(command.as_bytes()).is_empty());
        assert_eq!(scanner.feed(b"\r\nope-term-soak-ack-42\r\n$ "), [42]);
    }

    #[test]
    fn acknowledgements_split_across_frames_are_found_once() {
        let mut scanner = AckScanner::default();
        assert!(scanner.feed(b"noise ope-term-so").is_empty());
        assert!(scanner.feed(b"ak-ack-12").is_empty());
        assert_eq!(
            scanner.feed(b"3\r\nope-term-soak-ack-124\nope-term-soak-ack-"),
            [123, 124]
        );
        assert_eq!(scanner.feed(b"125\r"), [125]);
        assert!(scanner.feed(b"trailing output\r\n").is_empty());
    }

    #[test]
    fn pending_output_stays_bounded_without_newlines() {
        let mut scanner = AckScanner::default();
        for _ in 0..100 {
            scanner.feed(&[b'x'; 1024]);
        }
        assert!(scanner.pending.len() <= MAX_PENDING_OUTPUT);
        assert_eq!(scanner.feed(b"ope-term-soak-ack-7\n"), [7]);
    }

    #[test]
    fn answers_primary_device_attribute_queries_only() {
        let mut queries = DeviceAttributesQueries::default();
        // fish 4 startup: several queries, DA1 last.
        assert_eq!(
            queries.feed(b"\x1b[?u\x1b[>0q\x1b]11;?\x1b\\\x1b[?1049h\x1b[?1049l\x1b[0c"),
            1
        );
        assert_eq!(queries.feed(b"\x1b[>c"), 0, "DA2 is not DA1");
        assert_eq!(queries.feed(b"\x1b["), 0);
        assert_eq!(queries.feed(b"c and \x1b[c"), 2, "split across frames");
        assert_eq!(queries.feed(b"plain output c"), 0);
    }

    #[test]
    fn parses_soak_arguments() {
        let args = [
            "--route",
            "bastion, ope-term-soak",
            "--duration-seconds",
            "600",
            "--heartbeat-seconds",
            "5",
            "--report",
            "out/client.json",
        ]
        .map(str::to_owned);
        let (options, report) = parse_arguments(&args).expect("arguments");
        assert_eq!(options.route, ["bastion", "ope-term-soak"]);
        assert_eq!(options.duration, Duration::from_secs(600));
        assert_eq!(options.heartbeat_interval, Duration::from_secs(5));
        assert_eq!(report, PathBuf::from("out/client.json"));
        assert!(parse_arguments(&[]).is_err());
        assert!(parse_arguments(&["--route".to_owned()]).is_err());
        assert!(
            parse_arguments(&["--route", "a", "--duration-seconds", "0"].map(str::to_owned))
                .is_err()
        );
        assert!(parse_arguments(&["--bogus", "1"].map(str::to_owned)).is_err());
    }

    #[test]
    fn reports_percentiles_and_serializes_camel_case() {
        let mut samples = vec![5.0, 1.0, 3.0, 2.0, 4.0];
        let summary = summarize(&mut samples);
        assert_eq!(summary.samples, 5);
        assert_eq!(summary.p50_ms, 3.0);
        assert_eq!(summary.max_ms, 5.0);
        let report = SoakReport {
            schema_version: 1,
            kind: "ope-term-soak-client",
            ..SoakReport::default()
        };
        let value = serde_json::to_value(report).expect("json");
        assert!(value.get("autoReconnects").is_some());
        assert!(value["heartbeats"].get("droppedByDisconnect").is_some());
    }
}
