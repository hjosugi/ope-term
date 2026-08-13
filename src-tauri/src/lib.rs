#![cfg_attr(feature = "fuzzing", allow(dead_code))]

#[cfg(feature = "app")]
mod host_keys;
#[cfg(feature = "app")]
mod local_files;
#[cfg(feature = "app")]
mod local_terminal;
#[cfg(feature = "app")]
mod session_log;
#[cfg(feature = "app")]
mod sftp;
#[cfg(feature = "app")]
mod ssh;
mod ssh_config;
#[cfg(feature = "app")]
mod transport;

/// Exercises the in-memory OpenSSH config parser without touching the filesystem.
///
/// This entry point is intentionally available only to the cargo-fuzz package.
#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub fn fuzz_ssh_config_parser(text: &str) {
    let _ = ssh_config::parse(text);
}

/// Exercises config parsing, endpoint resolution, and ProxyJump expansion.
///
/// This entry point is intentionally available only to the cargo-fuzz package.
#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub fn fuzz_route_expansion(text: &str, route: &[String]) {
    let blocks = ssh_config::parse(text);
    let _ = ssh_config::chain_for_route(route, &blocks);
    for alias in route {
        let _ = ssh_config::resolve(alias, &blocks);
    }
}

#[cfg(feature = "app")]
mod application {
    use std::collections::HashMap;
    use std::sync::Arc;

    use tauri::ipc::{Channel, Response};
    use tauri::{AppHandle, State};
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::{mpsc, oneshot};
    use uuid::Uuid;
    use zeroize::Zeroize;

    use crate::local_files::{LocalListing, LocalScopes, SelectedDirectory};
    use crate::local_terminal::{LocalConnectRequest, ShellProfile};
    use crate::sftp::{
        SftpListing, SftpProgress, SftpTransferInput, SftpTransferResult, TransferDirection,
    };
    use crate::ssh::{
        self, AuthAnswer, CloseReason, ConnectRequest, HostKeyAnswer, HostKeyDecision,
        SessionCommand, SessionControl, SessionEvent,
    };
    use crate::ssh_config::{self, HostProfile};
    use crate::transport::{TerminalControl, TerminalRequest};

    type TerminalMap = Arc<tokio::sync::Mutex<HashMap<String, TerminalControl>>>;
    const MAX_ACTIVE_TERMINALS: usize = 64;
    const TERMINAL_COMMAND_QUEUE_CAPACITY: usize = 64;

    #[derive(Default)]
    struct AppState {
        terminals: TerminalMap,
        local_scopes: LocalScopes,
    }

    fn validate_session_id(value: &str) -> Result<String, String> {
        let parsed = Uuid::parse_str(value).map_err(|_| "session id が不正です".to_owned())?;
        let canonical = parsed.hyphenated().to_string();
        if canonical != value {
            return Err("session id は canonical UUID でなければなりません".to_owned());
        }
        Ok(canonical)
    }

    fn validate_request_id(value: &str, prefix: &str) -> Result<(), String> {
        let Some(counter) = value.strip_prefix(prefix) else {
            return Err("request id が不正です".to_owned());
        };
        let parsed = counter
            .parse::<u64>()
            .map_err(|_| "request id が不正です".to_owned())?;
        if parsed == 0 || parsed.to_string() != counter {
            return Err("request id が不正です".to_owned());
        }
        Ok(())
    }

    fn register_terminal(
        terminals: &mut HashMap<String, TerminalControl>,
        session_id: String,
        control: TerminalControl,
    ) -> Result<(), String> {
        if terminals.contains_key(&session_id) {
            return Err("同じ session id が既に存在します".to_owned());
        }
        if terminals.len() >= MAX_ACTIVE_TERMINALS {
            return Err(format!(
                "同時 terminal 数は {MAX_ACTIVE_TERMINALS} 件までです"
            ));
        }
        terminals.insert(session_id, control);
        Ok(())
    }

    #[tauri::command]
    fn list_hosts() -> Result<Vec<HostProfile>, String> {
        ssh_config::load_default()
            .and_then(|blocks| ssh_config::profiles(&blocks))
            .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    fn ssh_config_path() -> Result<String, String> {
        ssh_config::default_config_path()
            .map(|path| path.display().to_string())
            .map_err(|error| error.to_string())
    }

    #[tauri::command]
    async fn connect_session(
        request: ConnectRequest,
        on_event: Channel<SessionEvent>,
        on_data: Channel<Response>,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let session_id = validate_session_id(&request.session_id)?;
        let log_directory = resolve_log_directory(&request.log, &state.local_scopes).await?;
        let (command_sender, command_receiver) = mpsc::channel(TERMINAL_COMMAND_QUEUE_CAPACITY);
        let (host_key_sender, host_key_receiver) = mpsc::channel(8);
        let (auth_sender, auth_receiver) = mpsc::channel(8);
        {
            let mut terminals = state.terminals.lock().await;
            register_terminal(
                &mut terminals,
                session_id.clone(),
                TerminalControl::Ssh(SessionControl {
                    commands: command_sender,
                    host_keys: host_key_sender,
                    authentication: auth_sender,
                }),
            )?;
        }

        let registry = Arc::clone(&state.terminals);
        tauri::async_runtime::spawn(async move {
            let reason = match ssh::run(
                request,
                log_directory,
                on_event.clone(),
                on_data,
                command_receiver,
                host_key_receiver,
                auth_receiver,
            )
            .await
            {
                Ok(reason) => reason,
                Err(error) => {
                    // Nothing reached a shell, so retrying would only repeat a
                    // config, host key, or authentication failure.
                    ssh::event_error(&on_event, &error);
                    CloseReason::Failed
                }
            };
            ssh::event_closed(&on_event, reason);
            registry.lock().await.remove(&session_id);
        });
        Ok(())
    }

    async fn terminal_control(
        state: &State<'_, AppState>,
        session_id: &str,
    ) -> Result<TerminalControl, String> {
        let session_id = validate_session_id(session_id)?;
        state
            .terminals
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "terminal session が見つかりません".to_owned())
    }

    async fn ssh_control(
        state: &State<'_, AppState>,
        session_id: &str,
    ) -> Result<SessionControl, String> {
        terminal_control(state, session_id)
            .await?
            .ssh()
            .cloned()
            .ok_or_else(|| "SSH session が見つかりません".to_owned())
    }

    async fn send_ssh_command(
        state: State<'_, AppState>,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<(), String> {
        ssh_control(&state, session_id)
            .await?
            .commands
            .send(command)
            .await
            .map_err(|_| "セッションは終了しています".to_owned())
    }

    #[tauri::command]
    async fn session_input(
        session_id: String,
        data: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        terminal_control(&state, &session_id)
            .await?
            .send(TerminalRequest::Input(data))
            .await
    }

    #[tauri::command]
    async fn session_resize(
        session_id: String,
        cols: u32,
        rows: u32,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        terminal_control(&state, &session_id)
            .await?
            .send(TerminalRequest::Resize { cols, rows })
            .await
    }

    #[tauri::command]
    fn list_shell_profiles() -> Vec<ShellProfile> {
        crate::local_terminal::profiles()
    }

    #[tauri::command]
    async fn connect_local_session(
        request: LocalConnectRequest,
        on_event: Channel<SessionEvent>,
        on_data: Channel<Response>,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let session_id = validate_session_id(&request.session_id)?;
        let log_directory = resolve_log_directory(&request.log, &state.local_scopes).await?;
        let working_directory = match &request.working_directory_token {
            Some(token) => Some(
                crate::local_files::resolve_directory(&state.local_scopes, token)
                    .await
                    .map_err(|error| format!("{error:#}"))?,
            ),
            None => None,
        };
        let (sender, receiver) = mpsc::channel(TERMINAL_COMMAND_QUEUE_CAPACITY);
        {
            let mut terminals = state.terminals.lock().await;
            register_terminal(
                &mut terminals,
                session_id.clone(),
                TerminalControl::Local(sender),
            )?;
        }
        let registry = Arc::clone(&state.terminals);
        tauri::async_runtime::spawn(async move {
            let reason = match crate::local_terminal::run(
                request,
                working_directory,
                log_directory,
                on_event.clone(),
                on_data,
                receiver,
            )
            .await
            {
                Ok(reason) => reason,
                Err(error) => {
                    ssh::event_error(&on_event, &error);
                    CloseReason::Failed
                }
            };
            ssh::event_closed(&on_event, reason);
            registry.lock().await.remove(&session_id);
        });
        Ok(())
    }

    async fn resolve_log_directory(
        input: &Option<crate::session_log::LogInput>,
        scopes: &LocalScopes,
    ) -> Result<Option<std::path::PathBuf>, String> {
        let Some(input) = input.as_ref().filter(|input| input.enabled) else {
            return Ok(None);
        };
        let token = input
            .directory_token
            .as_deref()
            .ok_or_else(|| "session log の保存先を選択してください".to_owned())?;
        crate::local_files::resolve_directory(scopes, token)
            .await
            .map(Some)
            .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    async fn sftp_list(
        session_id: String,
        path: String,
        state: State<'_, AppState>,
    ) -> Result<SftpListing, String> {
        crate::sftp::validate_list_path(&path).map_err(|error| format!("{error:#}"))?;
        let (reply, result) = oneshot::channel();
        send_ssh_command(state, &session_id, SessionCommand::SftpList { path, reply }).await?;
        result
            .await
            .map_err(|_| "SFTP session は終了しています".to_owned())?
    }

    #[tauri::command]
    async fn sftp_transfer(
        session_id: String,
        request: SftpTransferInput,
        on_progress: Channel<SftpProgress>,
        state: State<'_, AppState>,
    ) -> Result<SftpTransferResult, String> {
        request.validate().map_err(|error| format!("{error:#}"))?;
        let local_path = crate::local_files::resolve(
            &state.local_scopes,
            &request.local_token,
            &request.local_relative_path,
            request.direction == TransferDirection::Upload,
        )
        .await
        .map_err(|error| format!("{error:#}"))?;
        let request = request.resolve(local_path);
        let (reply, result) = oneshot::channel();
        send_ssh_command(
            state,
            &session_id,
            SessionCommand::SftpTransfer {
                request,
                progress: on_progress,
                reply,
            },
        )
        .await?;
        result
            .await
            .map_err(|_| "SFTP transfer は終了しています".to_owned())?
    }

    #[tauri::command]
    async fn sftp_cancel(
        session_id: String,
        transfer_id: String,
        state: State<'_, AppState>,
    ) -> Result<bool, String> {
        crate::sftp::validate_transfer_id(&transfer_id).map_err(|error| format!("{error:#}"))?;
        let (reply, result) = oneshot::channel();
        send_ssh_command(
            state,
            &session_id,
            SessionCommand::SftpCancel { transfer_id, reply },
        )
        .await?;
        result
            .await
            .map_err(|_| "SFTP session は終了しています".to_owned())
    }

    #[tauri::command]
    async fn pick_local_directory(
        app: AppHandle,
        state: State<'_, AppState>,
    ) -> Result<Option<SelectedDirectory>, String> {
        let (selected_sender, selected_receiver) = oneshot::channel();
        app.dialog()
            .file()
            .set_title("SFTP で使用する local directory")
            .pick_folder(move |selected| {
                let _ = selected_sender.send(selected);
            });
        let selected = selected_receiver
            .await
            .map_err(|_| "local directory picker が応答せず終了しました".to_owned())?;
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected
            .into_path()
            .map_err(|error| format!("local directory を path に変換できません: {error}"))?;
        crate::local_files::register(&state.local_scopes, path)
            .await
            .map(Some)
            .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    async fn local_list(
        token: String,
        relative_path: String,
        state: State<'_, AppState>,
    ) -> Result<LocalListing, String> {
        crate::local_files::list(&state.local_scopes, &token, &relative_path)
            .await
            .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    async fn log_list(
        token: String,
        state: State<'_, AppState>,
    ) -> Result<Vec<crate::session_log::LogFile>, String> {
        let directory = crate::local_files::resolve_directory(&state.local_scopes, &token)
            .await
            .map_err(|error| format!("{error:#}"))?;
        tauri::async_runtime::spawn_blocking(move || crate::session_log::list(&directory))
            .await
            .map_err(|error| format!("log list task が失敗しました: {error}"))?
            .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    async fn log_search(
        token: String,
        name: String,
        query: String,
        mode: crate::session_log::SearchMode,
        state: State<'_, AppState>,
    ) -> Result<Vec<crate::session_log::LogMatch>, String> {
        let directory = crate::local_files::resolve_directory(&state.local_scopes, &token)
            .await
            .map_err(|error| format!("{error:#}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            crate::session_log::search(&directory, &name, &query, mode)
        })
        .await
        .map_err(|error| format!("log search task が失敗しました: {error}"))?
        .map_err(|error| format!("{error:#}"))
    }

    #[tauri::command]
    async fn close_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
        terminal_control(&state, &session_id).await?.close().await
    }

    #[tauri::command]
    async fn answer_host_key(
        session_id: String,
        request_id: String,
        decision: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        validate_request_id(&request_id, "host-key-")?;
        let decision = HostKeyDecision::parse(&decision)?;
        ssh_control(&state, &session_id)
            .await?
            .host_keys
            .send(HostKeyAnswer {
                request_id: Some(request_id),
                decision,
            })
            .await
            .map_err(|_| "ホスト鍵の確認は終了しています".to_owned())
    }

    #[tauri::command]
    async fn answer_auth(
        session_id: String,
        request_id: String,
        mut responses: Vec<String>,
        cancelled: bool,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        if let Err(error) = validate_request_id(&request_id, "auth-") {
            responses.zeroize();
            return Err(error);
        }
        if let Err(error) = ssh::validate_auth_responses(None, &responses) {
            responses.zeroize();
            return Err(error.to_string());
        }
        let sender = ssh_control(&state, &session_id)
            .await
            .map(|session| session.authentication);
        let sender = match sender {
            Ok(sender) => sender,
            Err(error) => {
                responses.zeroize();
                return Err(error);
            }
        };
        if cancelled {
            responses.zeroize();
        }
        sender
            .send(AuthAnswer {
                request_id: Some(request_id),
                responses,
                cancelled,
            })
            .await
            .map_err(|_| "認証入力は終了しています".to_owned())
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        tauri::Builder::default()
            .plugin(tauri_plugin_dialog::init())
            .manage(AppState::default())
            .invoke_handler(tauri::generate_handler![
                list_hosts,
                ssh_config_path,
                connect_session,
                session_input,
                session_resize,
                list_shell_profiles,
                connect_local_session,
                sftp_list,
                sftp_transfer,
                sftp_cancel,
                pick_local_directory,
                local_list,
                log_list,
                log_search,
                close_session,
                answer_host_key,
                answer_auth,
            ])
            .run(tauri::generate_context!())
            .expect("failed to run ope-term");
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn accepts_only_canonical_session_uuids() {
            let canonical = "19b4f21c-233f-4a72-9e36-caac6f4e87ca";
            assert_eq!(validate_session_id(canonical).as_deref(), Ok(canonical));
            assert!(validate_session_id("not-a-uuid").is_err());
            assert!(validate_session_id("19B4F21C-233F-4A72-9E36-CAAC6F4E87CA").is_err());
            assert!(validate_session_id("19b4f21c233f4a729e36caac6f4e87ca").is_err());
        }

        #[test]
        fn accepts_only_generated_prompt_request_ids() {
            assert!(validate_request_id("host-key-1", "host-key-").is_ok());
            assert!(validate_request_id("auth-18446744073709551615", "auth-").is_ok());
            for invalid in ["", "auth-0", "auth-01", "auth--1", "host-key-1"] {
                assert!(validate_request_id(invalid, "auth-").is_err());
            }
        }

        #[test]
        fn bounds_the_terminal_registry_and_rejects_duplicates() {
            let mut terminals = HashMap::new();
            for _ in 0..MAX_ACTIVE_TERMINALS {
                let (sender, _receiver) = mpsc::channel(1);
                register_terminal(
                    &mut terminals,
                    Uuid::new_v4().hyphenated().to_string(),
                    TerminalControl::Local(sender),
                )
                .expect("terminal slot");
            }
            let duplicate = terminals.keys().next().expect("session id").clone();
            let (sender, _receiver) = mpsc::channel(1);
            assert!(
                register_terminal(&mut terminals, duplicate, TerminalControl::Local(sender))
                    .unwrap_err()
                    .contains("既に存在")
            );

            let (sender, _receiver) = mpsc::channel(1);
            assert!(
                register_terminal(
                    &mut terminals,
                    Uuid::new_v4().hyphenated().to_string(),
                    TerminalControl::Local(sender)
                )
                .unwrap_err()
                .contains(&MAX_ACTIVE_TERMINALS.to_string())
            );
        }
    }
}

#[cfg(feature = "app")]
pub use application::run;
