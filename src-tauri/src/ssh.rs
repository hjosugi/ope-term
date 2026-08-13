use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use russh::client;
use russh::keys::PrivateKeyWithHashAlg;
use russh::keys::ssh_key;
use russh::{ChannelMsg, Disconnect, MethodKind, MethodSet};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tokio::sync::{Mutex, mpsc, oneshot};
use zeroize::{Zeroize, Zeroizing};

use crate::host_keys::{self, KnownHostStatus};
use crate::session_log::{LogInput, LogSink};
use crate::sftp::{SftpListing, SftpProgress, SftpTransferRequest, SftpTransferResult};
use crate::ssh_config::{self, Endpoint};

static HOST_KEY_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static AUTH_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
const HOST_KEY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);
const AUTH_RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECTION_SETUP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_AUTH_PROMPTS: usize = 32;
const MAX_AUTH_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_AUTH_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ACTIVE_SFTP_TRANSFERS: usize = 8;
#[cfg(unix)]
const MAX_AGENT_IDENTITIES: usize = 64;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub session_id: String,
    pub route: Vec<String>,
    pub cols: u32,
    pub rows: u32,
    pub log: Option<LogInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HopStatus {
    index: usize,
    alias: String,
    state: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    request_id: String,
    hop: String,
    hostname: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthField {
    label: String,
    echo: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthPrompt {
    request_id: String,
    hop: String,
    username: String,
    kind: &'static str,
    title: String,
    instructions: String,
    fields: Vec<AuthField>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Chain { hops: Vec<HopStatus> },
    Hop { hop: HopStatus },
    HostKeyPrompt { prompt: HostKeyPrompt },
    AuthPrompt { prompt: AuthPrompt },
    Ready,
    Error { message: String },
    Closed { reason: CloseReason },
}

/// Why a session ended, so the UI can retry a lost link without retrying a
/// rejected credential or an intentional exit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// The operator closed the tab, or the app dropped the command channel.
    Local,
    /// The remote shell exited and the peer closed the channel.
    Remote,
    /// The link died without a channel close: keepalive timeout, network
    /// change, or an I/O failure while the shell was running.
    Transport,
    /// The session never reached a shell: config, host key, or authentication.
    Failed,
}

pub enum SessionCommand {
    Input(String),
    Resize {
        cols: u32,
        rows: u32,
    },
    SftpList {
        path: String,
        reply: oneshot::Sender<Result<SftpListing, String>>,
    },
    SftpTransfer {
        request: SftpTransferRequest,
        progress: Channel<SftpProgress>,
        reply: oneshot::Sender<Result<SftpTransferResult, String>>,
    },
    SftpCancel {
        transfer_id: String,
        reply: oneshot::Sender<bool>,
    },
    Close,
}

#[derive(Debug, Clone, Copy)]
pub enum HostKeyDecision {
    Reject,
    TrustOnce,
    TrustAndSave,
}

impl HostKeyDecision {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "reject" => Ok(Self::Reject),
            "trust_once" => Ok(Self::TrustOnce),
            "trust_and_save" => Ok(Self::TrustAndSave),
            _ => Err("不明なホスト鍵の応答です".to_owned()),
        }
    }
}

#[derive(Debug)]
pub struct HostKeyAnswer {
    pub request_id: Option<String>,
    pub decision: HostKeyDecision,
}

pub struct AuthAnswer {
    pub request_id: Option<String>,
    pub responses: Vec<String>,
    pub cancelled: bool,
}

impl std::fmt::Debug for AuthAnswer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthAnswer")
            .field("request_id", &self.request_id)
            .field("response_count", &self.responses.len())
            .field("cancelled", &self.cancelled)
            .finish()
    }
}

impl Drop for AuthAnswer {
    fn drop(&mut self) {
        self.responses.zeroize();
    }
}

#[derive(Clone)]
pub struct SessionControl {
    pub commands: mpsc::Sender<SessionCommand>,
    pub host_keys: mpsc::Sender<HostKeyAnswer>,
    pub authentication: mpsc::Sender<AuthAnswer>,
}

pub async fn run(
    request: ConnectRequest,
    log_directory: Option<PathBuf>,
    events: Channel<SessionEvent>,
    data: Channel<Response>,
    commands: mpsc::Receiver<SessionCommand>,
    host_key_answers: mpsc::Receiver<HostKeyAnswer>,
    auth_answers: mpsc::Receiver<AuthAnswer>,
) -> Result<CloseReason> {
    let route = request.route.clone();
    let chain = tokio::task::spawn_blocking(move || {
        let blocks = ssh_config::load_default()?;
        ssh_config::chain_for_route(&route, &blocks)
    })
    .await
    .context("SSH config parse task が失敗しました")??;
    let log = match (request.log.clone(), log_directory) {
        (Some(input), Some(directory)) if input.enabled => {
            let target = chain
                .last()
                .ok_or_else(|| anyhow!("SSH hop がありません"))?;
            Some(
                crate::session_log::start(crate::session_log::configure(
                    input,
                    directory,
                    &target.alias,
                    target.user.as_deref().unwrap_or("unknown"),
                )?)
                .await?,
            )
        }
        _ => None,
    };
    send(
        &events,
        SessionEvent::Chain {
            hops: chain
                .iter()
                .enumerate()
                .map(|(index, endpoint)| HopStatus {
                    index,
                    alias: endpoint.alias.clone(),
                    state: "pending",
                })
                .collect(),
        },
    );

    let mut handles = Vec::with_capacity(chain.len());
    let mut tunnel = None;
    let known_hosts_path = host_keys::default_path()?;
    let host_key_answers = Arc::new(Mutex::new(host_key_answers));
    let auth_prompter = UiAuthPrompter {
        events: events.clone(),
        answers: Arc::new(Mutex::new(auth_answers)),
    };

    for (index, endpoint) in chain.iter().enumerate() {
        send(
            &events,
            SessionEvent::Hop {
                hop: HopStatus {
                    index,
                    alias: endpoint.alias.clone(),
                    state: "connecting",
                },
            },
        );
        let handler = HostVerifier {
            hop: endpoint.alias.clone(),
            hostname: endpoint.hostname.clone(),
            known_hosts_hostname: endpoint
                .host_key_alias
                .clone()
                .unwrap_or_else(|| endpoint.hostname.clone()),
            port: endpoint.port,
            known_hosts_path: known_hosts_path.clone(),
            events: events.clone(),
            answers: Arc::clone(&host_key_answers),
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(30)),
            keepalive_interval: Some(Duration::from_secs(15)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let mut handle = if let Some(stream) = tunnel.take() {
            tokio::time::timeout(
                CONNECTION_SETUP_TIMEOUT,
                client::connect_stream(config, stream, handler),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "{} へのSSH handshakeが30秒でtimeoutしました",
                    endpoint.alias
                )
            })??
        } else {
            tokio::time::timeout(
                CONNECTION_SETUP_TIMEOUT,
                client::connect(config, (endpoint.hostname.as_str(), endpoint.port), handler),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "{}:{} への接続が30秒でtimeoutしました",
                    endpoint.hostname,
                    endpoint.port
                )
            })?
            .with_context(|| format!("{}:{} へ接続できません", endpoint.hostname, endpoint.port))?
        };
        authenticate(&mut handle, endpoint, &auth_prompter).await?;
        send(
            &events,
            SessionEvent::Hop {
                hop: HopStatus {
                    index,
                    alias: endpoint.alias.clone(),
                    state: "connected",
                },
            },
        );

        if let Some(next) = chain.get(index + 1) {
            let channel = tokio::time::timeout(
                CONNECTION_SETUP_TIMEOUT,
                handle.channel_open_direct_tcpip(&next.hostname, next.port.into(), "127.0.0.1", 0),
            )
            .await
            .map_err(|_| anyhow!("{} へのtunnel openが30秒でtimeoutしました", next.alias))?
            .with_context(|| {
                format!(
                    "{} から {} へのトンネルを開けません",
                    endpoint.alias, next.alias
                )
            })?;
            tunnel = Some(channel.into_stream());
        }
        handles.push(handle);
    }

    let final_handle = handles
        .last_mut()
        .ok_or_else(|| anyhow!("SSH hop がありません"))?;
    let mut channel = final_handle.channel_open_session().await?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            request.cols.max(1),
            request.rows.max(1),
            0,
            0,
            &[],
        )
        .await?;
    channel.request_shell(true).await?;
    send(&events, SessionEvent::Ready);

    let outcome = session_loop(&mut channel, final_handle, commands, &events, &data, log).await;
    for handle in handles.iter_mut().rev() {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "ope-term closed", "en")
            .await;
    }
    match outcome {
        Ok(reason) => Ok(reason),
        Err(error) => {
            // The shell was already running, so a failure here is a lost link
            // rather than a rejected connection. Report it and let the UI retry.
            event_error(&events, &error);
            Ok(CloseReason::Transport)
        }
    }
}

async fn session_loop(
    channel: &mut russh::Channel<client::Msg>,
    handle: &mut client::Handle<HostVerifier>,
    mut commands: mpsc::Receiver<SessionCommand>,
    events: &Channel<SessionEvent>,
    data_channel: &Channel<Response>,
    mut log: Option<LogSink>,
) -> Result<CloseReason> {
    let mut sftp_session: Option<Arc<SftpSession>> = None;
    let transfers = Arc::new(Mutex::new(HashMap::<String, Arc<AtomicBool>>::new()));
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Input(data)) => channel.data_bytes(Bytes::from(data)).await?,
                    Some(SessionCommand::Resize { cols, rows }) => {
                        channel.window_change(cols.max(1), rows.max(1), 0, 0).await?;
                    }
                    Some(SessionCommand::SftpList { path, reply }) => {
                        let result = match open_sftp(handle, &mut sftp_session).await {
                            Ok(session) => crate::sftp::list(&session, &path)
                                .await
                                .map_err(|error| format!("{error:#}")),
                            Err(error) => Err(format!("{error:#}")),
                        };
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::SftpTransfer { request, progress, reply }) => {
                        let transfer_id = request.transfer_id.clone();
                        if let Err(error) = crate::sftp::validate_transfer_id(&transfer_id) {
                            let _ = reply.send(Err(format!("{error:#}")));
                            continue;
                        }
                        let session = match open_sftp(handle, &mut sftp_session).await {
                            Ok(session) => session,
                            Err(error) => {
                                let _ = reply.send(Err(format!("{error:#}")));
                                continue;
                            }
                        };
                        let cancelled = Arc::new(AtomicBool::new(false));
                        let registered = {
                            let mut registry = transfers.lock().await;
                            register_transfer(
                                &mut registry,
                                transfer_id.clone(),
                                Arc::clone(&cancelled),
                            )
                        };
                        if let Err(error) = registered {
                            let _ = reply.send(Err(error));
                            continue;
                        }
                        let registry = Arc::clone(&transfers);
                        tokio::spawn(async move {
                            let result = crate::sftp::transfer(session, request, progress, cancelled)
                                .await
                                .map_err(|error| format!("{error:#}"));
                            registry.lock().await.remove(&transfer_id);
                            let _ = reply.send(result);
                        });
                    }
                    Some(SessionCommand::SftpCancel { transfer_id, reply }) => {
                        if crate::sftp::validate_transfer_id(&transfer_id).is_err() {
                            let _ = reply.send(false);
                            continue;
                        }
                        let cancelled = transfers.lock().await.get(&transfer_id).cloned();
                        let found = cancelled.is_some();
                        if let Some(cancelled) = cancelled {
                            cancelled.store(true, Ordering::Relaxed);
                        }
                        let _ = reply.send(found);
                    }
                    Some(SessionCommand::Close) | None => {
                        for cancelled in transfers.lock().await.values() {
                            cancelled.store(true, Ordering::Relaxed);
                        }
                        if let Some(session) = &sftp_session {
                            let _ = session.close().await;
                        }
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        return Ok(CloseReason::Local);
                    }
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if let Some(sink) = &log
                            && let Err(error) = sink.write(&data).await
                        {
                            event_error(
                                events,
                                &error.context("session logへの書き込みを停止しました"),
                            );
                            log = None;
                        }
                        let _ = data_channel.send(Response::new(data.to_vec()));
                    }
                    // The peer closed the shell: an exit, a kill, or a logout.
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        return Ok(CloseReason::Remote);
                    }
                    // The channel ended without a close, so the session below it
                    // is gone: keepalive timeout, network change, or reset.
                    None => return Ok(CloseReason::Transport),
                    _ => {}
                }
            }
        }
    }
}

fn register_transfer(
    registry: &mut HashMap<String, Arc<AtomicBool>>,
    transfer_id: String,
    cancelled: Arc<AtomicBool>,
) -> Result<(), String> {
    if registry.contains_key(&transfer_id) {
        return Err("同じ transfer id が既に存在します".to_owned());
    }
    if registry.len() >= MAX_ACTIVE_SFTP_TRANSFERS {
        return Err(format!(
            "同時 SFTP transfer 数は session ごとに {MAX_ACTIVE_SFTP_TRANSFERS} 件までです"
        ));
    }
    registry.insert(transfer_id, cancelled);
    Ok(())
}

async fn open_sftp(
    handle: &mut client::Handle<HostVerifier>,
    current: &mut Option<Arc<SftpSession>>,
) -> Result<Arc<SftpSession>> {
    if let Some(session) = current {
        return Ok(Arc::clone(session));
    }
    let channel = handle
        .channel_open_session()
        .await
        .context("SFTP 用 SSH channel を開けません")?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .context("SFTP subsystem を開始できません")?;
    let session = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .context("SFTP protocol を初期化できません")?,
    );
    *current = Some(Arc::clone(&session));
    Ok(session)
}

fn send(channel: &Channel<SessionEvent>, event: SessionEvent) {
    let _ = channel.send(event);
}

struct HostVerifier {
    hop: String,
    hostname: String,
    known_hosts_hostname: String,
    port: u16,
    known_hosts_path: PathBuf,
    events: Channel<SessionEvent>,
    answers: Arc<Mutex<mpsc::Receiver<HostKeyAnswer>>>,
}

impl client::Handler for HostVerifier {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let path = self.known_hosts_path.clone();
        let hostname = self.known_hosts_hostname.clone();
        let port = self.port;
        let key = server_public_key.clone();
        let status =
            tokio::task::spawn_blocking(move || host_keys::check(&path, &hostname, port, &key))
                .await
                .context("known_hosts check task が失敗しました")??;
        match status {
            KnownHostStatus::Trusted => Ok(true),
            KnownHostStatus::Changed { line } => {
                self.prompt(server_public_key, "changed", Some(line));
                bail!(
                    "警告: {}:{} のホスト鍵が known_hosts {} 行目から変更されています。接続を拒否しました",
                    self.hostname,
                    self.port,
                    line
                )
            }
            KnownHostStatus::Unknown => {
                let request_id = self.prompt(server_public_key, "unknown", None);
                match self.wait_for_answer(&request_id).await? {
                    HostKeyDecision::Reject => bail!(
                        "{}:{} の未知のホスト鍵を信頼しなかったため、接続を中止しました",
                        self.hostname,
                        self.port
                    ),
                    HostKeyDecision::TrustOnce => Ok(true),
                    HostKeyDecision::TrustAndSave => {
                        let path = self.known_hosts_path.clone();
                        let hostname = self.known_hosts_hostname.clone();
                        let port = self.port;
                        let key = server_public_key.clone();
                        tokio::task::spawn_blocking(move || {
                            host_keys::save(&path, &hostname, port, &key)
                        })
                        .await
                        .context("known_hosts save task が失敗しました")??;
                        Ok(true)
                    }
                }
            }
        }
    }
}

impl HostVerifier {
    fn prompt(
        &self,
        server_public_key: &ssh_key::PublicKey,
        status: &'static str,
        existing_line: Option<usize>,
    ) -> String {
        let request_id = format!(
            "host-key-{}",
            HOST_KEY_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        send(
            &self.events,
            SessionEvent::HostKeyPrompt {
                prompt: HostKeyPrompt {
                    request_id: request_id.clone(),
                    hop: self.hop.clone(),
                    hostname: self.hostname.clone(),
                    port: self.port,
                    algorithm: server_public_key.algorithm().to_string(),
                    fingerprint: server_public_key
                        .fingerprint(ssh_key::HashAlg::Sha256)
                        .to_string(),
                    status,
                    existing_line,
                },
            },
        );
        request_id
    }

    async fn wait_for_answer(&self, request_id: &str) -> Result<HostKeyDecision> {
        let answer = tokio::time::timeout(HOST_KEY_RESPONSE_TIMEOUT, async {
            let mut answers = self.answers.lock().await;
            loop {
                let answer = answers
                    .recv()
                    .await
                    .ok_or_else(|| anyhow!("ホスト鍵確認の応答チャネルが閉じました"))?;
                if answer.request_id.as_deref() == Some(request_id) || answer.request_id.is_none() {
                    return Ok::<_, anyhow::Error>(answer.decision);
                }
            }
        })
        .await
        .map_err(|_| anyhow!("ホスト鍵の確認が5分以内に完了しませんでした"))??;
        Ok(answer)
    }
}

struct UiAuthPrompter {
    events: Channel<SessionEvent>,
    answers: Arc<Mutex<mpsc::Receiver<AuthAnswer>>>,
}

trait AuthPromptProvider {
    async fn prompt(&self, prompt: AuthPrompt) -> Result<Vec<String>>;
}

impl AuthPromptProvider for UiAuthPrompter {
    async fn prompt(&self, prompt: AuthPrompt) -> Result<Vec<String>> {
        let request_id = prompt.request_id.clone();
        send(&self.events, SessionEvent::AuthPrompt { prompt });
        let mut answer = tokio::time::timeout(AUTH_RESPONSE_TIMEOUT, async {
            let mut answers = self.answers.lock().await;
            loop {
                let answer = answers
                    .recv()
                    .await
                    .ok_or_else(|| anyhow!("認証応答チャネルが閉じました"))?;
                if answer.request_id.as_deref() == Some(&request_id) || answer.request_id.is_none()
                {
                    return Ok::<_, anyhow::Error>(answer);
                }
            }
        })
        .await
        .map_err(|_| anyhow!("認証入力が5分以内に完了しませんでした"))??;

        if answer.cancelled {
            bail!("認証入力がキャンセルされました")
        }
        Ok(std::mem::take(&mut answer.responses))
    }
}

enum AuthProgress {
    Success,
    Continue(MethodSet),
}

fn auth_progress(result: client::AuthResult) -> AuthProgress {
    match result {
        client::AuthResult::Success => AuthProgress::Success,
        client::AuthResult::Failure {
            remaining_methods, ..
        } => AuthProgress::Continue(remaining_methods),
    }
}

fn auth_prompt(
    endpoint: &Endpoint,
    username: &str,
    kind: &'static str,
    title: impl Into<String>,
    instructions: impl Into<String>,
    fields: Vec<AuthField>,
) -> AuthPrompt {
    AuthPrompt {
        request_id: format!("auth-{}", AUTH_REQUEST_ID.fetch_add(1, Ordering::Relaxed)),
        hop: endpoint.alias.clone(),
        username: username.to_owned(),
        kind,
        title: title.into(),
        instructions: instructions.into(),
        fields,
    }
}

pub fn validate_auth_responses(expected: Option<usize>, responses: &[String]) -> Result<()> {
    if responses.len() > MAX_AUTH_PROMPTS {
        bail!("認証応答の項目数が上限を超えています")
    }
    if let Some(expected) = expected
        && responses.len() != expected
    {
        bail!(
            "認証応答の項目数が一致しません（expected {expected}, received {}）",
            responses.len()
        )
    }
    if responses
        .iter()
        .any(|response| response.len() > MAX_AUTH_RESPONSE_BYTES)
    {
        bail!("認証応答がサイズ上限を超えています")
    }
    Ok(())
}

async fn ask_for_auth<P: AuthPromptProvider>(
    prompter: &P,
    prompt: AuthPrompt,
) -> Result<Vec<String>> {
    let expected = prompt.fields.len();
    let mut responses = prompter.prompt(prompt).await?;
    if let Err(error) = validate_auth_responses(Some(expected), &responses) {
        responses.zeroize();
        return Err(error);
    }
    Ok(responses)
}

async fn authenticate<H: client::Handler, P: AuthPromptProvider>(
    handle: &mut client::Handle<H>,
    endpoint: &Endpoint,
    prompter: &P,
) -> Result<()> {
    let username = endpoint.user.clone().unwrap_or_else(default_username);
    let mut methods = match auth_progress(handle.authenticate_none(username.clone()).await?) {
        AuthProgress::Success => return Ok(()),
        AuthProgress::Continue(methods) => methods,
    };

    #[cfg(unix)]
    if !endpoint.identities_only
        && methods.contains(&MethodKind::PublicKey)
        && let Ok(progress) = authenticate_with_agent(handle, &username, methods.clone()).await
    {
        match progress {
            AuthProgress::Success => return Ok(()),
            AuthProgress::Continue(next) => methods = next,
        }
    }

    let explicit_certificates = !endpoint.certificate_files.is_empty();
    let mut candidates = endpoint.identity_files.clone();
    if let Some(home) = dirs::home_dir() {
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let path = home.join(".ssh").join(name);
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    let certificate_candidates = if explicit_certificates {
        endpoint.certificate_files.clone()
    } else {
        candidates
            .iter()
            .map(|path| {
                let mut certificate = path.as_os_str().to_os_string();
                certificate.push("-cert.pub");
                PathBuf::from(certificate)
            })
            .collect()
    };
    let certificates = tokio::task::spawn_blocking(move || {
        certificate_candidates
            .iter()
            .filter(|path| is_bounded_auth_file(path))
            .filter_map(|path| ssh_key::Certificate::read_file(path).ok())
            .collect::<Vec<_>>()
    })
    .await
    .context("SSH certificate load task が失敗しました")?;

    let mut attempted_keys = Vec::new();
    for path in candidates {
        if !methods.contains(&MethodKind::PublicKey) {
            break;
        }
        let load_path = path.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            is_bounded_auth_file(&load_path).then(|| russh::keys::load_secret_key(&load_path, None))
        })
        .await
        .context("SSH private key load task が失敗しました")?;
        let Some(loaded) = loaded else { continue };
        attempted_keys.push(path.display().to_string());
        let key = match loaded {
            Ok(key) => Some(key),
            Err(russh::keys::Error::KeyIsEncrypted) => {
                let mut decrypted = None;
                for attempt in 1..=3 {
                    let mut responses = ask_for_auth(
                        prompter,
                        auth_prompt(
                            endpoint,
                            &username,
                            "key_passphrase",
                            "秘密鍵のパスフレーズ",
                            format!(
                                "{} を復号します（{attempt}/3）。値は保存されません。",
                                path.display()
                            ),
                            vec![AuthField {
                                label: "Passphrase".to_owned(),
                                echo: false,
                            }],
                        ),
                    )
                    .await?;
                    let passphrase = Zeroizing::new(responses.pop().unwrap_or_default());
                    responses.zeroize();
                    let load_path = path.clone();
                    let loaded = tokio::task::spawn_blocking(move || {
                        is_bounded_auth_file(&load_path).then(|| {
                            russh::keys::load_secret_key(&load_path, Some(passphrase.as_str()))
                        })
                    })
                    .await
                    .context("encrypted SSH private key load task が失敗しました")?;
                    if let Some(Ok(key)) = loaded {
                        decrypted = Some(key);
                        break;
                    }
                }
                decrypted
            }
            Err(_) => None,
        };
        let Some(key) = key else { continue };
        let key = Arc::new(key);
        if let Some(certificate) = certificates
            .iter()
            .find(|certificate| certificate.public_key() == key.public_key().key_data())
        {
            match auth_progress(
                handle
                    .authenticate_openssh_cert(
                        username.clone(),
                        Arc::clone(&key),
                        certificate.clone(),
                    )
                    .await?,
            ) {
                AuthProgress::Success => return Ok(()),
                AuthProgress::Continue(next) => methods = next,
            }
        }
        if !methods.contains(&MethodKind::PublicKey) {
            break;
        }
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        match auth_progress(
            handle
                .authenticate_publickey(username.clone(), PrivateKeyWithHashAlg::new(key, hash))
                .await?,
        ) {
            AuthProgress::Success => return Ok(()),
            AuthProgress::Continue(next) => methods = next,
        }
    }

    if methods.contains(&MethodKind::KeyboardInteractive) {
        match authenticate_keyboard_interactive(handle, endpoint, &username, prompter).await? {
            AuthProgress::Success => return Ok(()),
            AuthProgress::Continue(next) => methods = next,
        }
    }

    if methods.contains(&MethodKind::Password) {
        for attempt in 1..=3 {
            let mut responses = ask_for_auth(
                prompter,
                auth_prompt(
                    endpoint,
                    &username,
                    "password",
                    "SSH パスワード",
                    format!("{username}@{} のパスワード（{attempt}/3）", endpoint.alias),
                    vec![AuthField {
                        label: "Password".to_owned(),
                        echo: false,
                    }],
                ),
            )
            .await?;
            let mut password = responses.pop().unwrap_or_default();
            let result = handle
                .authenticate_password(username.clone(), password.clone())
                .await;
            password.zeroize();
            responses.zeroize();
            match auth_progress(result?) {
                AuthProgress::Success => return Ok(()),
                AuthProgress::Continue(next) => {
                    methods = next;
                    if !methods.contains(&MethodKind::Password) {
                        break;
                    }
                }
            }
        }
    }

    let detail = if attempted_keys.is_empty() {
        "利用可能な認証方法をすべて試行しました".to_owned()
    } else {
        format!("試行した鍵: {}", attempted_keys.join(", "))
    };
    bail!(
        "{}@{} のSSH認証に失敗しました。{detail}",
        username,
        endpoint.alias
    )
}

fn is_bounded_auth_file(path: &std::path::Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_AUTH_FILE_BYTES)
}

async fn authenticate_keyboard_interactive<H: client::Handler, P: AuthPromptProvider>(
    handle: &mut client::Handle<H>,
    endpoint: &Endpoint,
    username: &str,
    prompter: &P,
) -> Result<AuthProgress> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username.to_owned(), None)
        .await?;
    for _round in 0..16 {
        match response {
            client::KeyboardInteractiveAuthResponse::Success => {
                return Ok(AuthProgress::Success);
            }
            client::KeyboardInteractiveAuthResponse::Failure {
                remaining_methods, ..
            } => return Ok(AuthProgress::Continue(remaining_methods)),
            client::KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                if prompts.len() > MAX_AUTH_PROMPTS {
                    bail!("keyboard-interactive の質問数が上限を超えています")
                }
                let fields = prompts
                    .into_iter()
                    .map(|prompt| AuthField {
                        label: bounded_text(&prompt.prompt, 4096),
                        echo: prompt.echo,
                    })
                    .collect();
                let answers = ask_for_auth(
                    prompter,
                    auth_prompt(
                        endpoint,
                        username,
                        "keyboard_interactive",
                        bounded_text(&name, 4096),
                        bounded_text(&instructions, 4096),
                        fields,
                    ),
                )
                .await?;
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }
    bail!("keyboard-interactive の認証ラウンド数が上限を超えています")
}

fn bounded_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(unix)]
async fn authenticate_with_agent<H: client::Handler>(
    handle: &mut client::Handle<H>,
    username: &str,
    mut methods: MethodSet,
) -> Result<AuthProgress> {
    use russh::keys::agent::{AgentIdentity, client::AgentClient};

    let mut agent = AgentClient::connect_env().await?;
    let identities = agent.request_identities().await?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in bounded_agent_identities(identities) {
        if let AgentIdentity::PublicKey { key, .. } = identity {
            let result = handle
                .authenticate_publickey_with(username, key, hash, &mut agent)
                .await?;
            match auth_progress(result) {
                AuthProgress::Success => return Ok(AuthProgress::Success),
                AuthProgress::Continue(next) => {
                    methods = next;
                    if !methods.contains(&MethodKind::PublicKey) {
                        break;
                    }
                }
            }
        }
    }
    Ok(AuthProgress::Continue(methods))
}

#[cfg(unix)]
fn bounded_agent_identities<T>(identities: Vec<T>) -> impl Iterator<Item = T> {
    identities.into_iter().take(MAX_AGENT_IDENTITIES)
}

fn default_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".into())
}

pub fn event_error(channel: &Channel<SessionEvent>, error: &anyhow::Error) {
    send(
        channel,
        SessionEvent::Error {
            message: format!("{error:#}"),
        },
    );
}

pub fn event_closed(channel: &Channel<SessionEvent>, reason: CloseReason) {
    send(channel, SessionEvent::Closed { reason });
}

#[cfg(test)]
mod tests {
    use std::borrow::Cow;
    use std::collections::VecDeque;

    use russh::server;

    use super::*;

    const ENCRYPTED_ED25519_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD1phlku5
A2G7Q9iP+DcOc9AAAAEAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHeLC1lWiCYrXsf/
85O/pkbUFZ6OGIt49PX3nw8iRoXEAAAAkKRF0st5ZI7xxo9g6A4m4l6NarkQre3mycqNXQ
dP3jryYgvsCIBAA5jMWSjrmnOTXhidqcOy4xYCrAttzSnZ/cUadfBenL+DQq6neffw7j8r
0tbCxVGp6yCQlKrgSZf6c0Hy7dNEIU2bJFGxLe6/kWChcUAt/5Ll5rI7DVQPJdLgehLzvv
sJWR7W+cGvJ/vLsw==
-----END OPENSSH PRIVATE KEY-----";

    struct ScriptedPrompter {
        answers: Mutex<VecDeque<Vec<String>>>,
        prompts: Mutex<Vec<AuthPrompt>>,
    }

    impl ScriptedPrompter {
        fn new(answers: Vec<Vec<&str>>) -> Self {
            Self {
                answers: Mutex::new(
                    answers
                        .into_iter()
                        .map(|answer| answer.into_iter().map(str::to_owned).collect())
                        .collect(),
                ),
                prompts: Mutex::new(Vec::new()),
            }
        }
    }

    impl AuthPromptProvider for ScriptedPrompter {
        async fn prompt(&self, prompt: AuthPrompt) -> Result<Vec<String>> {
            self.prompts.lock().await.push(prompt);
            self.answers
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| anyhow!("scripted authentication answer is missing"))
        }
    }

    struct AcceptServerKey;

    impl client::Handler for AcceptServerKey {
        type Error = anyhow::Error;

        async fn check_server_key(
            &mut self,
            _server_public_key: &ssh_key::PublicKey,
        ) -> Result<bool, Self::Error> {
            Ok(true)
        }
    }

    #[derive(Clone, Copy)]
    enum ServerAuthMode {
        Password,
        KeyboardInteractive,
        PublicKey,
    }

    struct TestAuthServer {
        mode: ServerAuthMode,
    }

    impl server::Handler for TestAuthServer {
        type Error = anyhow::Error;

        async fn auth_none(&mut self, _user: &str) -> Result<server::Auth, Self::Error> {
            let method = match self.mode {
                ServerAuthMode::Password => MethodKind::Password,
                ServerAuthMode::KeyboardInteractive => MethodKind::KeyboardInteractive,
                ServerAuthMode::PublicKey => MethodKind::PublicKey,
            };
            Ok(server::Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[method][..])),
                partial_success: false,
            })
        }

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<server::Auth, Self::Error> {
            if matches!(self.mode, ServerAuthMode::Password)
                && user == "operator"
                && password == "password-value"
            {
                Ok(server::Auth::Accept)
            } else {
                Ok(server::Auth::reject())
            }
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            public_key: &ssh_key::PublicKey,
        ) -> Result<server::Auth, Self::Error> {
            let expected =
                russh::keys::decode_secret_key(ENCRYPTED_ED25519_KEY, Some("test")).unwrap();
            if matches!(self.mode, ServerAuthMode::PublicKey)
                && user == "operator"
                && public_key == expected.public_key()
            {
                Ok(server::Auth::Accept)
            } else {
                Ok(server::Auth::reject())
            }
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            user: &str,
            _submethods: &str,
            response: Option<server::Response<'a>>,
        ) -> Result<server::Auth, Self::Error> {
            if !matches!(self.mode, ServerAuthMode::KeyboardInteractive) || user != "operator" {
                return Ok(server::Auth::reject());
            }
            let Some(response) = response else {
                return Ok(server::Auth::Partial {
                    name: Cow::Borrowed("Operations MFA"),
                    instructions: Cow::Borrowed("Enter both account password and OTP"),
                    prompts: Cow::Owned(vec![
                        (Cow::Borrowed("Password"), false),
                        (Cow::Borrowed("One-time code"), false),
                    ]),
                });
            };
            let answers = response
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .collect::<Vec<_>>();
            if answers == ["password-value", "123456"] {
                Ok(server::Auth::Accept)
            } else {
                Ok(server::Auth::reject())
            }
        }
    }

    async fn test_client(
        mode: ServerAuthMode,
    ) -> (
        client::Handle<AcceptServerKey>,
        tokio::task::JoinHandle<Result<(), anyhow::Error>>,
    ) {
        let server_config = server::Config {
            inactivity_timeout: None,
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(1)),
            keys: vec![
                russh::keys::decode_secret_key(ENCRYPTED_ED25519_KEY, Some("test")).unwrap(),
            ],
            ..Default::default()
        };
        let server_config = Arc::new(server_config);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await?;
            let running =
                server::run_stream(server_config, socket, TestAuthServer { mode }).await?;
            running.await
        });
        let client = client::connect(
            Arc::new(client::Config::default()),
            address,
            AcceptServerKey,
        )
        .await
        .unwrap();
        (client, server)
    }

    fn endpoint(identity_files: Vec<PathBuf>) -> Endpoint {
        Endpoint {
            alias: "maintenance-hop".to_owned(),
            hostname: "127.0.0.1".to_owned(),
            user: Some("operator".to_owned()),
            port: 22,
            identity_files,
            certificate_files: Vec::new(),
            host_key_alias: None,
            identities_only: false,
            proxy_jump: None,
        }
    }

    #[tokio::test]
    async fn authenticates_with_password_prompt() {
        let (mut client, server) = test_client(ServerAuthMode::Password).await;
        let prompter = ScriptedPrompter::new(vec![vec!["password-value"]]);

        authenticate(&mut client, &endpoint(Vec::new()), &prompter)
            .await
            .unwrap();

        let prompts = prompter.prompts.lock().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].kind, "password");
        assert_eq!(prompts[0].hop, "maintenance-hop");
        server.abort();
    }

    #[tokio::test]
    async fn authenticates_multiple_keyboard_interactive_prompts() {
        let (mut client, server) = test_client(ServerAuthMode::KeyboardInteractive).await;
        let prompter = ScriptedPrompter::new(vec![vec!["password-value", "123456"]]);

        authenticate(&mut client, &endpoint(Vec::new()), &prompter)
            .await
            .unwrap();

        let prompts = prompter.prompts.lock().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].kind, "keyboard_interactive");
        assert_eq!(prompts[0].fields.len(), 2);
        assert!(prompts[0].fields.iter().all(|field| !field.echo));
        server.abort();
    }

    #[tokio::test]
    async fn decrypts_openssh_key_with_one_time_passphrase() {
        let directory = tempfile::tempdir().unwrap();
        let key_path = directory.path().join("id_ed25519");
        std::fs::write(&key_path, ENCRYPTED_ED25519_KEY).unwrap();
        let (mut client, server) = test_client(ServerAuthMode::PublicKey).await;
        let prompter = ScriptedPrompter::new(vec![vec!["test"]]);

        authenticate(&mut client, &endpoint(vec![key_path]), &prompter)
            .await
            .unwrap();

        let prompts = prompter.prompts.lock().await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].kind, "key_passphrase");
        server.abort();
    }

    #[test]
    fn auth_files_must_be_regular_and_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_AUTH_FILE_BYTES).unwrap();
        assert!(is_bounded_auth_file(&path));

        file.set_len(MAX_AUTH_FILE_BYTES + 1).unwrap();
        assert!(!is_bounded_auth_file(&path));
        assert!(!is_bounded_auth_file(directory.path()));
        assert!(!is_bounded_auth_file(&directory.path().join("missing")));
    }

    #[test]
    fn bounds_active_sftp_transfers_and_rejects_duplicates() {
        let mut registry = HashMap::new();
        for index in 0..MAX_ACTIVE_SFTP_TRANSFERS {
            register_transfer(
                &mut registry,
                format!("transfer-{index}"),
                Arc::new(AtomicBool::new(false)),
            )
            .expect("transfer slot");
        }
        assert!(
            register_transfer(
                &mut registry,
                "transfer-0".to_owned(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap_err()
            .contains("既に存在")
        );
        assert!(
            register_transfer(
                &mut registry,
                "overflow".to_owned(),
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap_err()
            .contains(&MAX_ACTIVE_SFTP_TRANSFERS.to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn bounds_agent_authentication_attempts() {
        let identities = (0..MAX_AGENT_IDENTITIES + 10).collect();
        assert_eq!(
            bounded_agent_identities(identities).count(),
            MAX_AGENT_IDENTITIES
        );
    }

    #[test]
    fn authentication_answers_redact_secrets_from_debug_and_errors() {
        let answer = AuthAnswer {
            request_id: Some("auth-test".to_owned()),
            responses: vec!["never-print-this-secret".to_owned()],
            cancelled: false,
        };

        assert!(!format!("{answer:?}").contains("never-print-this-secret"));
        let error = validate_auth_responses(Some(2), &answer.responses).unwrap_err();
        assert!(!error.to_string().contains("never-print-this-secret"));
    }

    #[test]
    fn close_reasons_keep_the_wire_names_the_ui_switches_on() {
        for (reason, expected) in [
            (CloseReason::Local, "local"),
            (CloseReason::Remote, "remote"),
            (CloseReason::Transport, "transport"),
            (CloseReason::Failed, "failed"),
        ] {
            let event = serde_json::to_value(SessionEvent::Closed { reason }).unwrap();
            assert_eq!(event["type"], "closed");
            assert_eq!(event["reason"], expected);
        }
    }
}
