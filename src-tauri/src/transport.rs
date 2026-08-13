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
                // Unblock any pending SSH-only prompts before closing the
                // command channel. No equivalent exists for local terminals.
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
                    .map_err(|_| "SSH session は終了しています".to_owned())
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
}
