#![cfg_attr(feature = "fuzzing", allow(dead_code))]

#[cfg(feature = "app")]
mod host_keys;
#[cfg(feature = "app")]
mod ssh;
mod ssh_config;

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
    use std::sync::Arc;

    use tauri::State;
    use tauri::ipc::{Channel, Response};
    use tokio::sync::mpsc;
    use zeroize::Zeroize;

    use crate::ssh::{
        self, AuthAnswer, ConnectRequest, HostKeyAnswer, HostKeyDecision, SessionCommand,
        SessionControl, SessionEvent, SessionMap,
    };
    use crate::ssh_config::{self, HostProfile};

    #[derive(Default)]
    struct AppState {
        sessions: SessionMap,
    }

    #[tauri::command]
    fn list_hosts() -> Result<Vec<HostProfile>, String> {
        ssh_config::load_default()
            .map(|blocks| ssh_config::profiles(&blocks))
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
        let session_id = request.session_id.clone();
        let (command_sender, command_receiver) = mpsc::channel(256);
        let (host_key_sender, host_key_receiver) = mpsc::channel(8);
        let (auth_sender, auth_receiver) = mpsc::channel(8);
        {
            let mut sessions = state.sessions.lock().await;
            if sessions.contains_key(&session_id) {
                return Err("同じ session id が既に存在します".into());
            }
            sessions.insert(
                session_id.clone(),
                SessionControl {
                    commands: command_sender,
                    host_keys: host_key_sender,
                    authentication: auth_sender,
                },
            );
        }

        let registry = Arc::clone(&state.sessions);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = ssh::run(
                request,
                on_event.clone(),
                on_data,
                command_receiver,
                host_key_receiver,
                auth_receiver,
            )
            .await
            {
                ssh::event_error(&on_event, &error);
            }
            ssh::event_closed(&on_event);
            registry.lock().await.remove(&session_id);
        });
        Ok(())
    }

    async fn send_command(
        state: State<'_, AppState>,
        session_id: &str,
        command: SessionCommand,
    ) -> Result<(), String> {
        let sender = state
            .sessions
            .lock()
            .await
            .get(session_id)
            .map(|session| session.commands.clone())
            .ok_or_else(|| "セッションが見つかりません".to_owned())?;
        sender
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
        send_command(state, &session_id, SessionCommand::Input(data)).await
    }

    #[tauri::command]
    async fn session_resize(
        session_id: String,
        cols: u32,
        rows: u32,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        send_command(state, &session_id, SessionCommand::Resize { cols, rows }).await
    }

    #[tauri::command]
    async fn close_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
        let control = state
            .sessions
            .lock()
            .await
            .get(&session_id)
            .cloned()
            .ok_or_else(|| "セッションが見つかりません".to_owned())?;
        let _ = control
            .host_keys
            .send(HostKeyAnswer {
                request_id: None,
                decision: HostKeyDecision::Reject,
            })
            .await;
        let _ = control
            .authentication
            .send(AuthAnswer {
                request_id: None,
                responses: Vec::new(),
                cancelled: true,
            })
            .await;
        control
            .commands
            .send(SessionCommand::Close)
            .await
            .map_err(|_| "セッションは終了しています".to_owned())
    }

    #[tauri::command]
    async fn answer_host_key(
        session_id: String,
        request_id: String,
        decision: String,
        state: State<'_, AppState>,
    ) -> Result<(), String> {
        let decision = HostKeyDecision::parse(&decision)?;
        let sender = state
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|session| session.host_keys.clone())
            .ok_or_else(|| "セッションが見つかりません".to_owned())?;
        sender
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
        if let Err(error) = ssh::validate_auth_responses(None, &responses) {
            responses.zeroize();
            return Err(error.to_string());
        }
        let sender = state
            .sessions
            .lock()
            .await
            .get(&session_id)
            .map(|session| session.authentication.clone())
            .ok_or_else(|| "セッションが見つかりません".to_owned());
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
            .manage(AppState::default())
            .invoke_handler(tauri::generate_handler![
                list_hosts,
                ssh_config_path,
                connect_session,
                session_input,
                session_resize,
                close_session,
                answer_host_key,
                answer_auth,
            ])
            .run(tauri::generate_context!())
            .expect("failed to run ope-term");
    }
}

#[cfg(feature = "app")]
pub use application::run;
