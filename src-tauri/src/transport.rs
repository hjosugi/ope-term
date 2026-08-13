use tokio::sync::mpsc;

use crate::local_terminal::LocalCommand;
use crate::ssh::{AuthAnswer, HostKeyAnswer, HostKeyDecision, SessionCommand, SessionControl};

/// Operations shared by every interactive terminal transport.
///
/// Authentication, host-key verification, and SFTP intentionally stay on
/// `SessionControl`: they are SSH capabilities, not terminal capabilities.
pub enum TerminalRequest {
    Input(String),
    Resize { cols: u32, rows: u32 },
}

#[derive(Clone)]
pub enum TerminalControl {
    Ssh(SessionControl),
    Local(mpsc::Sender<LocalCommand>),
}

impl TerminalControl {
    pub fn ssh(&self) -> Option<&SessionControl> {
        match self {
            Self::Ssh(control) => Some(control),
            Self::Local(_) => None,
        }
    }

    pub async fn send(&self, request: TerminalRequest) -> Result<(), String> {
        match (self, request) {
            (Self::Ssh(control), TerminalRequest::Input(data)) => control
                .commands
                .send(SessionCommand::Input(data))
                .await
                .map_err(|_| "SSH session は終了しています".to_owned()),
            (Self::Ssh(control), TerminalRequest::Resize { cols, rows }) => control
                .commands
                .send(SessionCommand::Resize { cols, rows })
                .await
                .map_err(|_| "SSH session は終了しています".to_owned()),
            (Self::Local(sender), TerminalRequest::Input(data)) => sender
                .send(LocalCommand::Input(data))
                .await
                .map_err(|_| "local session は終了しています".to_owned()),
            (Self::Local(sender), TerminalRequest::Resize { cols, rows }) => sender
                .send(LocalCommand::Resize { cols, rows })
                .await
                .map_err(|_| "local session は終了しています".to_owned()),
        }
    }

    pub async fn close(&self) -> Result<(), String> {
        match self {
            Self::Local(sender) => sender
                .send(LocalCommand::Close)
                .await
                .map_err(|_| "local session は終了しています".to_owned()),
            Self::Ssh(control) => {
                // A session can currently be waiting on host-key input, auth
                // input, or shell commands. Send all three shutdown signals
                // concurrently so a full inactive channel cannot block the
                // signal that the session is actually polling.
                let host_key = control.host_keys.send(HostKeyAnswer {
                    request_id: None,
                    decision: HostKeyDecision::Reject,
                });
                let authentication = control.authentication.send(AuthAnswer {
                    request_id: None,
                    responses: Vec::new(),
                    cancelled: true,
                });
                let command = control.commands.send(SessionCommand::Close);
                let (host_key, authentication, command) =
                    tokio::join!(host_key, authentication, command);
                if host_key.is_ok() || authentication.is_ok() || command.is_ok() {
                    Ok(())
                } else {
                    Err("SSH session は終了しています".to_owned())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn common_requests_are_translated_for_local_terminals() {
        let (sender, mut receiver) = mpsc::channel(3);
        let control = TerminalControl::Local(sender);

        control
            .send(TerminalRequest::Input("echo ok".to_owned()))
            .await
            .unwrap();
        control
            .send(TerminalRequest::Resize {
                cols: 120,
                rows: 40,
            })
            .await
            .unwrap();
        control.close().await.unwrap();

        assert!(matches!(
            receiver.recv().await,
            Some(LocalCommand::Input(data)) if data == "echo ok"
        ));
        assert!(matches!(
            receiver.recv().await,
            Some(LocalCommand::Resize {
                cols: 120,
                rows: 40
            })
        ));
        assert!(matches!(receiver.recv().await, Some(LocalCommand::Close)));
    }

    #[tokio::test]
    async fn common_requests_and_close_are_translated_for_ssh() {
        let (commands, mut command_receiver) = mpsc::channel(3);
        let (host_keys, mut host_key_receiver) = mpsc::channel(1);
        let (authentication, mut authentication_receiver) = mpsc::channel(1);
        let session = SessionControl {
            commands,
            host_keys,
            authentication,
        };
        let control = TerminalControl::Ssh(session.clone());

        assert!(control.ssh().is_some());
        control
            .send(TerminalRequest::Input("uname -a".to_owned()))
            .await
            .unwrap();
        control
            .send(TerminalRequest::Resize { cols: 96, rows: 32 })
            .await
            .unwrap();
        control.close().await.unwrap();

        assert!(matches!(
            command_receiver.recv().await,
            Some(SessionCommand::Input(data)) if data == "uname -a"
        ));
        assert!(matches!(
            command_receiver.recv().await,
            Some(SessionCommand::Resize { cols: 96, rows: 32 })
        ));
        assert!(matches!(
            command_receiver.recv().await,
            Some(SessionCommand::Close)
        ));

        let host_key_answer = host_key_receiver.recv().await.unwrap();
        assert!(host_key_answer.request_id.is_none());
        assert!(matches!(host_key_answer.decision, HostKeyDecision::Reject));

        let auth_answer = authentication_receiver.recv().await.unwrap();
        assert!(auth_answer.request_id.is_none());
        assert!(auth_answer.responses.is_empty());
        assert!(auth_answer.cancelled);
    }

    #[tokio::test]
    async fn ssh_close_reaches_the_command_channel_when_an_inactive_prompt_queue_is_full() {
        let (commands, mut command_receiver) = mpsc::channel(1);
        let (host_keys, host_key_receiver) = mpsc::channel(1);
        let (authentication, authentication_receiver) = mpsc::channel(1);
        host_keys
            .send(HostKeyAnswer {
                request_id: Some("stale".to_owned()),
                decision: HostKeyDecision::TrustOnce,
            })
            .await
            .unwrap();
        let control = TerminalControl::Ssh(SessionControl {
            commands,
            host_keys,
            authentication,
        });

        let driver = async move {
            assert!(matches!(
                command_receiver.recv().await,
                Some(SessionCommand::Close)
            ));
            // The real SSH task drops every remaining receiver after it sees
            // Close, releasing sends to inactive/full prompt queues.
            drop(host_key_receiver);
            drop(authentication_receiver);
        };
        let (close_result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(control.close(), driver)
        })
        .await
        .expect("close should not wait on the full host-key queue");

        close_result.unwrap();
    }
}
