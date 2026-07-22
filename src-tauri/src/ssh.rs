use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use bytes::Bytes;
use russh::client;
use russh::keys::PrivateKeyWithHashAlg;
use russh::keys::ssh_key;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, Response};
use tokio::sync::{Mutex, mpsc};

use crate::host_keys::{self, KnownHostStatus};
use crate::ssh_config::{self, Endpoint};

static HOST_KEY_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
const HOST_KEY_RESPONSE_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    pub session_id: String,
    pub route: Vec<String>,
    pub cols: u32,
    pub rows: u32,
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
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    Chain { hops: Vec<HopStatus> },
    Hop { hop: HopStatus },
    HostKeyPrompt { prompt: HostKeyPrompt },
    Ready,
    Error { message: String },
    Closed,
}

#[derive(Debug)]
pub enum SessionCommand {
    Input(String),
    Resize { cols: u32, rows: u32 },
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

#[derive(Clone)]
pub struct SessionControl {
    pub commands: mpsc::Sender<SessionCommand>,
    pub host_keys: mpsc::Sender<HostKeyAnswer>,
}

pub type SessionMap = Arc<Mutex<HashMap<String, SessionControl>>>;

pub async fn run(
    request: ConnectRequest,
    events: Channel<SessionEvent>,
    data: Channel<Response>,
    commands: mpsc::Receiver<SessionCommand>,
    host_key_answers: mpsc::Receiver<HostKeyAnswer>,
) -> Result<()> {
    let blocks = ssh_config::load_default()?;
    let chain = ssh_config::chain_for_route(&request.route, &blocks)?;
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
            client::connect_stream(config, stream, handler).await?
        } else {
            client::connect(config, (endpoint.hostname.as_str(), endpoint.port), handler)
                .await
                .with_context(|| {
                    format!("{}:{} へ接続できません", endpoint.hostname, endpoint.port)
                })?
        };
        authenticate(&mut handle, endpoint).await?;
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
            let channel = handle
                .channel_open_direct_tcpip(&next.hostname, next.port.into(), "127.0.0.1", 0)
                .await
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

    session_loop(&mut channel, commands, &data).await?;
    for handle in handles.iter_mut().rev() {
        let _ = handle
            .disconnect(Disconnect::ByApplication, "ope-term closed", "en")
            .await;
    }
    Ok(())
}

async fn session_loop(
    channel: &mut russh::Channel<client::Msg>,
    mut commands: mpsc::Receiver<SessionCommand>,
    data_channel: &Channel<Response>,
) -> Result<()> {
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Input(data)) => channel.data_bytes(Bytes::from(data)).await?,
                    Some(SessionCommand::Resize { cols, rows }) => {
                        channel.window_change(cols.max(1), rows.max(1), 0, 0).await?;
                    }
                    Some(SessionCommand::Close) | None => {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
            message = channel.wait() => {
                match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = data_channel.send(Response::new(data.to_vec()));
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn send(channel: &Channel<SessionEvent>, event: SessionEvent) {
    let _ = channel.send(event);
}

struct HostVerifier {
    hop: String,
    hostname: String,
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
        match host_keys::check(
            &self.known_hosts_path,
            &self.hostname,
            self.port,
            server_public_key,
        )? {
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
                        host_keys::save(
                            &self.known_hosts_path,
                            &self.hostname,
                            self.port,
                            server_public_key,
                        )?;
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

async fn authenticate(
    handle: &mut client::Handle<HostVerifier>,
    endpoint: &Endpoint,
) -> Result<()> {
    let username = endpoint.user.clone().unwrap_or_else(default_username);

    #[cfg(unix)]
    if authenticate_with_agent(handle, &username)
        .await
        .unwrap_or(false)
    {
        return Ok(());
    }

    let mut candidates = endpoint.identity_files.clone();
    if let Some(home) = dirs::home_dir() {
        for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
            let path = home.join(".ssh").join(name);
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }

    let mut attempted = Vec::new();
    for path in candidates.into_iter().filter(|path| path.is_file()) {
        attempted.push(path.display().to_string());
        let Ok(key) = russh::keys::load_secret_key(&path, None) else {
            continue;
        };
        let hash = handle.best_supported_rsa_hash().await?.flatten();
        let result = handle
            .authenticate_publickey(
                username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?;
        if result.success() {
            return Ok(());
        }
    }

    let detail = if attempted.is_empty() {
        "利用可能な ssh-agent または秘密鍵がありません".to_owned()
    } else {
        format!("試行した鍵: {}", attempted.join(", "))
    };
    bail!(
        "{}@{} の公開鍵認証に失敗しました。{detail}",
        username,
        endpoint.alias
    )
}

#[cfg(unix)]
async fn authenticate_with_agent(
    handle: &mut client::Handle<HostVerifier>,
    username: &str,
) -> Result<bool> {
    use russh::keys::agent::{AgentIdentity, client::AgentClient};

    let mut agent = AgentClient::connect_env().await?;
    let identities = agent.request_identities().await?;
    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        if let AgentIdentity::PublicKey { key, .. } = identity {
            let result = handle
                .authenticate_publickey_with(username, key, hash, &mut agent)
                .await?;
            if result.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
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

pub fn event_closed(channel: &Channel<SessionEvent>) {
    send(channel, SessionEvent::Closed);
}
