//! Automated performance measurement mode.
//!
//! When `OPE_TERM_PERFORMANCE_REPORT` names an absolute `.json` path, the app
//! runs one scripted measurement (see `src/performance-autorun.ts` and
//! `scripts/performance-autorun.mjs`): it opens a local terminal, measures
//! memory and input latency, streams the 100 MiB fixture through the real PTY
//! → IPC Channel → xterm path, writes the report, and exits. Nothing here runs
//! in normal use, and the WebView can never choose the report path.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::Serialize;

const REPORT_ENV: &str = "OPE_TERM_PERFORMANCE_REPORT";
const MAX_REPORT_BYTES: usize = 64 * 1024;
const MAX_ENVIRONMENT_VALUE_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AutorunConfig {
    /// `webgl`, `fallback`, or `auto`.
    pub renderer: String,
    /// Shell command typed into the local terminal to stream the fixture.
    pub fixture_command: String,
    pub operating_system: String,
    pub webview: String,
    pub machine: String,
    pub commit: String,
    pub notes: String,
    pub input_samples: u32,
}

fn bounded(value: String) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(MAX_ENVIRONMENT_VALUE_CHARS)
        .collect()
}

/// The report path, only when it is an absolute `.json` path.
pub fn report_path() -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(REPORT_ENV)?);
    (path.is_absolute()
        && path
            .extension()
            .is_some_and(|extension| extension == "json"))
    .then_some(path)
}

/// Reads the autorun settings from the environment, or `None` in normal use.
pub fn autorun_config(lookup: impl Fn(&str) -> Option<String>) -> Option<AutorunConfig> {
    lookup(REPORT_ENV)?;
    let renderer = match lookup("OPE_TERM_PERFORMANCE_RENDERER").as_deref() {
        Some("webgl") => "webgl",
        Some("fallback") => "fallback",
        _ => "auto",
    };
    let input_samples = lookup("OPE_TERM_PERFORMANCE_INPUT_SAMPLES")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|samples| (1..=10_000).contains(samples))
        .unwrap_or(120);
    let webview = lookup("OPE_TERM_PERFORMANCE_WEBVIEW").unwrap_or_else(default_webview);
    Some(AutorunConfig {
        renderer: renderer.to_owned(),
        fixture_command: bounded(
            lookup("OPE_TERM_PERFORMANCE_FIXTURE")
                .unwrap_or_else(|| "node scripts/performance-fixture.mjs".to_owned()),
        ),
        operating_system: bounded(
            lookup("OPE_TERM_PERFORMANCE_OS").unwrap_or_else(|| std::env::consts::OS.to_owned()),
        ),
        webview: bounded(webview),
        machine: bounded(lookup("OPE_TERM_PERFORMANCE_MACHINE").unwrap_or_else(|| {
            format!(
                "{} / {} CPUs",
                std::env::consts::ARCH,
                std::thread::available_parallelism().map_or(0, usize::from)
            )
        })),
        commit: bounded(lookup("OPE_TERM_COMMIT").unwrap_or_else(|| "unknown".to_owned())),
        notes: bounded(lookup("OPE_TERM_PERFORMANCE_NOTES").unwrap_or_default()),
        input_samples,
    })
}

fn default_webview() -> String {
    let engine = if cfg!(target_os = "linux") {
        "WebKitGTK"
    } else if cfg!(target_os = "windows") {
        "WebView2"
    } else {
        "WKWebView"
    };
    match tauri::webview_version() {
        Ok(version) => format!("{engine} {version}"),
        Err(_) => engine.to_owned(),
    }
}

/// Accepts only a bounded performance report object before writing it.
pub fn write_report(path: &Path, contents: &str) -> Result<()> {
    if contents.len() > MAX_REPORT_BYTES {
        bail!("performance report は 64 KiB 以下にしてください");
    }
    let value: serde_json::Value =
        serde_json::from_str(contents).context("performance report が JSON ではありません")?;
    if value
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
        || !value
            .get("environment")
            .is_some_and(serde_json::Value::is_object)
    {
        bail!("performance report schema が不正です");
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("report directory を作成できません")?;
    }
    std::fs::write(path, format!("{contents}\n"))
        .with_context(|| format!("{} へ report を書けません", path.display()))
}

/// Resident memory of this process and every descendant (WebKit web / network
/// processes and PTY children), in MiB. Linux only; `None` elsewhere.
pub fn memory_mib() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let processes = read_linux_processes()?;
        Some(tree_rss_kib(std::process::id(), &processes) as f64 / 1024.0)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Parent pid and resident kB for each process.
#[cfg(target_os = "linux")]
fn read_linux_processes() -> Option<HashMap<u32, (u32, u64)>> {
    let mut processes = HashMap::new();
    for entry in std::fs::read_dir("/proc").ok()? {
        let Ok(entry) = entry else { continue };
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        if let Some(parsed) = parse_status(&status) {
            processes.insert(pid, parsed);
        }
    }
    Some(processes)
}

/// Extracts `PPid` and `VmRSS` (kB) from `/proc/<pid>/status`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_status(status: &str) -> Option<(u32, u64)> {
    let mut parent = None;
    let mut rss = 0;
    for line in status.lines() {
        if let Some(value) = line.strip_prefix("PPid:") {
            parent = value.trim().parse().ok();
        } else if let Some(value) = line.strip_prefix("VmRSS:") {
            rss = value
                .split_whitespace()
                .next()
                .and_then(|kib| kib.parse().ok())
                .unwrap_or(0);
        }
    }
    parent.map(|parent| (parent, rss))
}

/// Sums resident kB over `root` and all of its descendants.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn tree_rss_kib(root: u32, processes: &HashMap<u32, (u32, u64)>) -> u64 {
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for (pid, (parent, _)) in processes {
        children.entry(*parent).or_default().push(*pid);
    }
    let mut total = 0;
    let mut stack = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        total += processes.get(&pid).map_or(0, |(_, rss)| *rss);
        stack.extend(children.get(&pid).into_iter().flatten().copied());
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup(values: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let values = values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect::<HashMap<_, _>>();
        move |key| values.get(key).cloned()
    }

    #[test]
    fn autorun_is_off_unless_a_report_path_is_given() {
        assert_eq!(autorun_config(lookup(&[])), None);
        let config = autorun_config(lookup(&[
            (REPORT_ENV, "/tmp/report.json"),
            ("OPE_TERM_PERFORMANCE_RENDERER", "fallback"),
            ("OPE_TERM_PERFORMANCE_INPUT_SAMPLES", "150"),
            ("OPE_TERM_PERFORMANCE_WEBVIEW", "WebKitGTK 2.52"),
            ("OPE_TERM_PERFORMANCE_OS", "CachyOS Wayland\n"),
            ("OPE_TERM_COMMIT", "abc123"),
        ]))
        .expect("config");
        assert_eq!(config.renderer, "fallback");
        assert_eq!(config.input_samples, 150);
        assert_eq!(config.webview, "WebKitGTK 2.52");
        assert_eq!(config.operating_system, "CachyOS Wayland");
        assert_eq!(config.commit, "abc123");
    }

    #[test]
    fn unknown_renderers_and_sample_counts_fall_back_to_safe_defaults() {
        let config = autorun_config(lookup(&[
            (REPORT_ENV, "/tmp/report.json"),
            ("OPE_TERM_PERFORMANCE_RENDERER", "canvas"),
            ("OPE_TERM_PERFORMANCE_INPUT_SAMPLES", "0"),
            ("OPE_TERM_PERFORMANCE_WEBVIEW", "WebKitGTK"),
        ]))
        .expect("config");
        assert_eq!(config.renderer, "auto");
        assert_eq!(config.input_samples, 120);
    }

    #[test]
    fn writes_only_bounded_report_objects() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("nested").join("report.json");
        write_report(&path, r#"{"schemaVersion":1,"environment":{}}"#).expect("report");
        assert!(
            std::fs::read_to_string(&path)
                .expect("read")
                .contains("schemaVersion")
        );
        assert!(write_report(&path, "[]").is_err());
        assert!(write_report(&path, r#"{"schemaVersion":2,"environment":{}}"#).is_err());
        assert!(write_report(&path, &"x".repeat(MAX_REPORT_BYTES + 1)).is_err());
    }

    #[test]
    fn sums_resident_memory_over_the_process_tree() {
        assert_eq!(
            parse_status("Name:\tx\nPPid:\t7\nVmRSS:\t  2048 kB\n"),
            Some((7, 2048))
        );
        assert_eq!(parse_status("Name:\tkthread\n"), None);
        let processes = HashMap::from([
            (10, (1, 1000)),
            (11, (10, 200)),
            (12, (11, 30)),
            (20, (1, 5000)),
        ]);
        assert_eq!(tree_rss_kib(10, &processes), 1230);
        assert_eq!(tree_rss_kib(99, &processes), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn measures_this_process_on_linux() {
        assert!(memory_mib().expect("procfs") > 0.0);
    }
}
