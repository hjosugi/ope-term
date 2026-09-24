use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use portable_pty::{ChildKiller, CommandBuilder, ExitStatus, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tokio::sync::mpsc;

use crate::session_log::LogInput;
use crate::ssh::{CloseReason, SessionEvent};

pub(crate) const MAX_INPUT_BYTES: usize = 256 * 1024;
const PTY_WRITE_QUEUE_CAPACITY: usize = 64;
/// How long a shell gets to exit after SIGHUP before its process group is killed.
const SHELL_EXIT_GRACE: Duration = Duration::from_secs(2);
/// Upper bound for reaping after SIGKILL, so a close can never hang forever.
const SHELL_REAP_LIMIT: Duration = Duration::from_secs(5);

type ExitTask = tokio::task::JoinHandle<std::io::Result<ExitStatus>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub program: String,
    pub is_default: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConnectRequest {
    pub session_id: String,
    pub profile_id: String,
    pub working_directory_token: Option<String>,
    pub shell_integration: bool,
    pub cols: u32,
    pub rows: u32,
    pub log: Option<LogInput>,
}

pub enum LocalCommand {
    Input(String),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub fn profiles() -> Vec<ShellProfile> {
    let default = default_shell();
    let mut candidates = vec![(
        "default".to_owned(),
        "Default shell".to_owned(),
        default,
        true,
    )];

    #[cfg(unix)]
    for (id, label, paths) in [
        ("bash", "Bash", ["/bin/bash", "/usr/bin/bash"]),
        ("zsh", "Zsh", ["/bin/zsh", "/usr/bin/zsh"]),
        ("fish", "Fish", ["/usr/bin/fish", "/bin/fish"]),
    ] {
        if let Some(path) = paths.iter().map(PathBuf::from).find(|path| path.is_file()) {
            candidates.push((id.to_owned(), label.to_owned(), path, false));
        }
    }

    #[cfg(windows)]
    for (id, label, program) in [
        ("powershell", "PowerShell", "powershell.exe"),
        ("cmd", "Command Prompt", "cmd.exe"),
    ] {
        candidates.push((
            id.to_owned(),
            label.to_owned(),
            PathBuf::from(program),
            false,
        ));
    }

    let mut result = Vec::new();
    for (id, label, program, is_default) in candidates {
        if result
            .iter()
            .any(|profile: &ShellProfile| profile.program == program.display().to_string())
        {
            continue;
        }
        result.push(ShellProfile {
            id,
            label,
            program: program.display().to_string(),
            is_default,
        });
    }
    result
}

pub async fn run(
    request: LocalConnectRequest,
    working_directory: Option<PathBuf>,
    log_directory: Option<PathBuf>,
    events: Channel<SessionEvent>,
    data: Channel<Response>,
    mut commands: mpsc::Receiver<LocalCommand>,
) -> Result<CloseReason> {
    let profile = profiles()
        .into_iter()
        .find(|profile| profile.id == request.profile_id)
        .ok_or_else(|| anyhow!("shell profile が見つかりません"))?;
    let size = pty_size(request.cols, request.rows);
    let log = match (request.log.clone(), log_directory) {
        (Some(input), Some(directory)) if input.enabled => Some(
            crate::session_log::start(crate::session_log::configure(
                input,
                directory,
                "local",
                &local_user(),
            )?)
            .await?,
        ),
        _ => None,
    };
    let pair = native_pty_system()
        .openpty(size)
        .context("local PTY を作成できません")?;
    let mut command = CommandBuilder::new(&profile.program);
    if let Some(directory) = working_directory {
        command.cwd(directory);
    }
    command.env("TERM", "xterm-256color");
    command.env("TERM_PROGRAM", "ope-term");
    if request.shell_integration {
        command.env("OPE_TERM_SHELL_INTEGRATION", "1");
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .with_context(|| format!("{} を PTY で起動できません", profile.program))?;
    drop(pair.slave);
    let mut killer = child.clone_killer();
    // portable-pty starts the shell with setsid(), so its pid also names the
    // process group that holds its foreground jobs.
    let process_group = child.process_id();
    let master = pair.master;
    let mut reader = master.try_clone_reader()?;
    let mut writer = master.take_writer()?;

    let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(PTY_WRITE_QUEUE_CAPACITY);
    if let Err(error) = std::thread::Builder::new()
        .name("ope-term-local-pty-writer".to_owned())
        .spawn(move || {
            while let Some(bytes) = writer_rx.blocking_recv() {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        })
    {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error).context("local PTY writer thread を開始できません");
    }
    let output = data.clone();
    let output_events = events.clone();
    let mut output_log = log.clone();
    if let Err(error) = std::thread::Builder::new()
        .name("ope-term-local-pty-reader".to_owned())
        .spawn(move || {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if let Some(sink) = &output_log
                            && let Err(error) = sink.blocking_write(&buffer[..read])
                        {
                            crate::ssh::event_error(
                                &output_events,
                                &error.context("session logへの書き込みを停止しました"),
                            );
                            output_log = None;
                        }
                        let _ = output.send(Response::new(buffer[..read].to_vec()));
                    }
                }
            }
        })
    {
        drop(writer_tx);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error).context("local PTY reader thread を開始できません");
    }

    let mut exit_task: ExitTask = tokio::task::spawn_blocking(move || child.wait());
    let _ = events.send(SessionEvent::Ready);

    loop {
        tokio::select! {
            status = &mut exit_task => {
                match status {
                    Ok(Ok(_)) => return Ok(CloseReason::Remote),
                    Ok(Err(error)) => return Err(error).context("local shell の終了状態を取得できません"),
                    Err(error) => bail!("local shell の監視 task が終了しました: {error}"),
                }
            }
            command = commands.recv() => match command {
                Some(LocalCommand::Input(input)) => {
                    if input.len() > MAX_INPUT_BYTES {
                        drop(writer_tx);
                        terminate_shell(killer.as_mut(), process_group, &mut exit_task, SHELL_EXIT_GRACE).await;
                        drop(master);
                        bail!("local terminal input が大きすぎます");
                    }
                    if writer_tx.send(input.into_bytes()).await.is_err() {
                        drop(writer_tx);
                        terminate_shell(killer.as_mut(), process_group, &mut exit_task, SHELL_EXIT_GRACE).await;
                        drop(master);
                        bail!("local PTY input は終了しています");
                    }
                }
                Some(LocalCommand::Resize { cols, rows }) => {
                    if let Err(error) = master.resize(pty_size(cols, rows)) {
                        drop(writer_tx);
                        terminate_shell(killer.as_mut(), process_group, &mut exit_task, SHELL_EXIT_GRACE).await;
                        drop(master);
                        return Err(error).context("local PTY のサイズを変更できません");
                    }
                }
                Some(LocalCommand::Close) | None => {
                    drop(writer_tx);
                    terminate_shell(killer.as_mut(), process_group, &mut exit_task, SHELL_EXIT_GRACE).await;
                    // Closing the master also closes a Windows pseudoconsole,
                    // which terminates every client still attached to it.
                    drop(master);
                    return Ok(CloseReason::Local);
                }
            }
        }
    }
}

/// Ends a shell the way closing a terminal window does, then makes sure.
///
/// SIGHUP goes to the shell's whole process group so foreground jobs hang up
/// with it (on Windows the killer terminates the shell). A shell or job that
/// ignores the hangup is killed with SIGKILL after `grace`, and reaping is
/// bounded so a close request can never wait forever. Jobs a user explicitly
/// detached into another session (`nohup`, `setsid`, `disown`) are theirs.
async fn terminate_shell(
    killer: &mut (dyn ChildKiller + Send + Sync),
    process_group: Option<u32>,
    exit_task: &mut ExitTask,
    grace: Duration,
) {
    if exit_task.is_finished() {
        let _ = exit_task.await;
        return;
    }
    #[cfg(unix)]
    signal_process_group(process_group, libc::SIGHUP);
    #[cfg(not(unix))]
    let _ = process_group;
    let _ = killer.kill();
    if tokio::time::timeout(grace, &mut *exit_task).await.is_ok() {
        return;
    }
    #[cfg(unix)]
    signal_process_group(process_group, libc::SIGKILL);
    let _ = killer.kill();
    let _ = tokio::time::timeout(SHELL_REAP_LIMIT, &mut *exit_task).await;
}

/// Signals the process group led by the shell. The caller only does this
/// before the shell is reaped, so the group id cannot have been reused.
#[cfg(unix)]
fn signal_process_group(process_group: Option<u32>, signal: libc::c_int) {
    let Some(group) = process_group.and_then(|pid| libc::pid_t::try_from(pid).ok()) else {
        return;
    };
    // Never signal init, our own group, or "every process" (0 / 1 / negative).
    if group <= 1 {
        return;
    }
    // SAFETY: killpg only reads its two integer arguments.
    unsafe {
        libc::killpg(group, signal);
    }
}

fn pty_size(cols: u32, rows: u32) -> PtySize {
    PtySize {
        rows: rows.clamp(1, u16::MAX.into()) as u16,
        cols: cols.clamp(1, u16::MAX.into()) as u16,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(unix)]
fn default_shell() -> PathBuf {
    env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

fn local_user() -> String {
    #[cfg(unix)]
    let value = env::var("USER");
    #[cfg(windows)]
    let value = env::var("USERNAME");
    value.unwrap_or_else(|_| "unknown".to_owned())
}

#[cfg(windows)]
fn default_shell() -> PathBuf {
    env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"))
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn dimensions_are_bounded_for_the_native_pty_api() {
        assert_eq!(pty_size(0, 0).cols, 1);
        assert_eq!(pty_size(u32::MAX, u32::MAX).rows, u16::MAX);
    }

    #[test]
    fn profiles_have_one_default_and_unique_programs() {
        let profiles = profiles();
        assert_eq!(
            profiles.iter().filter(|profile| profile.is_default).count(),
            1
        );
        let mut programs = profiles
            .iter()
            .map(|profile| &profile.program)
            .collect::<Vec<_>>();
        programs.sort();
        programs.dedup();
        assert_eq!(programs.len(), profiles.len());
    }

    #[test]
    fn native_pty_spawns_and_reaps_a_platform_process() {
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .expect("native PTY");
        let mut command = smoke_command();
        command.env("TERM", "xterm-256color");
        let mut child = pair.slave.spawn_command(command).expect("spawn shell");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (output_tx, output_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            const MARKER: &[u8] = b"ope-term-local-pty-smoke";
            let mut output = Vec::new();
            let mut buffer = [0_u8; 4 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        output.extend_from_slice(&buffer[..read]);
                        if output.windows(MARKER.len()).any(|window| window == MARKER) {
                            break;
                        }
                        if output.len() > 64 * 1024 {
                            let _ =
                                output_tx.send(Err("PTY smoke output exceeded 64 KiB".to_owned()));
                            return;
                        }
                    }
                    Err(error) => {
                        let _ = output_tx.send(Err(error.to_string()));
                        return;
                    }
                }
            }
            let _ = output_tx.send(Ok(output));
        });
        // portable-pty requires taking and dropping the input writer even for
        // a one-shot command so that ConPTY can observe EOF and drain output.
        // macOS needs a short grace period before that EOF for short-lived
        // children; this mirrors portable-pty's cross-platform example.
        let writer = pair.master.take_writer().expect("writer");
        #[cfg(target_os = "macos")]
        std::thread::sleep(Duration::from_millis(20));
        drop(writer);

        // Follow portable-pty's one-shot command ordering: finish the child,
        // close the master, and only then collect reader output. ConPTY may
        // retain its output until the process has exited, so waiting for the
        // marker first creates a reader/child deadlock on Windows.
        let deadline = Instant::now() + Duration::from_secs(10);
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll child") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                drop(pair.master);
                panic!("PTY smoke child did not exit within 10 seconds");
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        drop(pair.master);
        let output = output_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("PTY smoke output timed out")
            .expect("read output");
        assert!(smoke_output_is_valid(&output));
        // Closing ConPTY input to guarantee EOF can produce a non-zero child
        // status even after output was delivered and the child was reaped.
        // portable-pty's Windows example likewise does not require success.
        #[cfg(not(windows))]
        assert!(status.success());
        #[cfg(windows)]
        let _ = status;
    }

    /// A shell whose whole process group ignores SIGHUP must still be gone,
    /// grandchildren included, after a close: nothing is left orphaned.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn closing_kills_a_hangup_ignoring_process_group() {
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .expect("native PTY");
        let mut command = CommandBuilder::new("/bin/sh");
        command.args([
            "-c",
            "trap '' HUP; sleep 1000 & echo \"ope-term-grandchild=$!\"; wait",
        ]);
        let mut child = pair.slave.spawn_command(command).expect("spawn shell");
        drop(pair.slave);
        let mut killer = child.clone_killer();
        let process_group = child.process_id();
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let (pid_tx, pid_rx) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut buffer = [0_u8; 1024];
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                output.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&output);
                if let Some(rest) = text.split("ope-term-grandchild=").nth(1)
                    && let Some(pid) = rest.split_whitespace().next()
                    && rest.contains('\n')
                {
                    let _ = pid_tx.send(pid.parse::<i32>().ok());
                    return;
                }
            }
            let _ = pid_tx.send(None);
        });
        let grandchild =
            tokio::task::spawn_blocking(move || pid_rx.recv_timeout(Duration::from_secs(20)))
                .await
                .expect("join")
                .expect("grandchild pid")
                .expect("parse pid");
        let mut exit_task: ExitTask = tokio::task::spawn_blocking(move || child.wait());

        terminate_shell(
            killer.as_mut(),
            process_group,
            &mut exit_task,
            Duration::from_millis(200),
        )
        .await;
        assert!(exit_task.is_finished(), "shell was not reaped");
        drop(pair.master);

        // The grandchild is killed too; its zombie may linger until init reaps it.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state = std::fs::read_to_string(format!("/proc/{grandchild}/stat"))
                .ok()
                .and_then(|stat| {
                    stat.rsplit(')')
                        .next()
                        .map(|rest| rest.trim().chars().next())
                })
                .flatten();
            if matches!(state, None | Some('Z')) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "grandchild {grandchild} survived: {state:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[cfg(unix)]
    fn smoke_command() -> CommandBuilder {
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf 'ope-term-local-pty-smoke\\n'"]);
        command
    }

    #[cfg(windows)]
    fn smoke_command() -> CommandBuilder {
        // Match portable-pty's Windows example: use a process that does not
        // inspect stdin, because closing ConPTY input can race cmd.exe startup.
        CommandBuilder::new("whoami.exe")
    }

    #[cfg(not(windows))]
    fn smoke_output_is_valid(output: &[u8]) -> bool {
        String::from_utf8_lossy(output).contains("ope-term-local-pty-smoke")
    }

    #[cfg(windows)]
    fn smoke_output_is_valid(output: &[u8]) -> bool {
        !String::from_utf8_lossy(output).trim().is_empty()
    }
}
