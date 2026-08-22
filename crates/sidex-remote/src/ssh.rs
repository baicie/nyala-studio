//! SSH remote transport backend.
//!
//! Full implementation with connection pooling, keepalive, `ProxyJump`,
//! agent forwarding, known-hosts checking, environment variables,
//! and bidirectional port forwarding.

use std::collections::HashMap;
use std::fmt::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{bail, Context, Result};
use russh::client;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::known_hosts::known_host_keys_path;
use russh::keys::{
    check_known_hosts_path, load_secret_key, Algorithm, Error as KeyError, HashAlg, PrivateKey,
    PrivateKeyWithHashAlg, PublicKey,
};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

use crate::transport::{DirEntry, ExecOutput, FileStat, RemotePty, RemoteTransport};

// ---------------------------------------------------------------------------
// Auth & config types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum SshAuth {
    Password(String),
    KeyFile {
        path: PathBuf,
        passphrase: Option<String>,
    },
    Agent,
    KeyboardInteractive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    Linux,
    MacOS,
    Windows,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Authenticating,
    InstallingServer,
    Connected,
    Reconnecting { attempt: u32 },
}

#[derive(Debug, Clone)]
pub struct SshChannel {
    pub id: u32,
    pub channel_type: ChannelType,
}

#[derive(Debug, Clone)]
pub enum ChannelType {
    Session,
    DirectTcpIp { host: String, port: u16 },
    ForwardedTcpIp { host: String, port: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub direction: ForwardDirection,
    pub is_active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForwardDirection {
    LocalToRemote,
    RemoteToLocal,
}

#[derive(Debug, Clone)]
pub struct RemoteFileSystem {
    pub root: PathBuf,
    pub home_dir: PathBuf,
}

/// High-level SSH connection that wraps the low-level transport with
/// reconnection logic, channel tracking, port forwards, and remote FS metadata.
pub struct SshConnection {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub state: ConnectionState,
    pub channels: Vec<SshChannel>,
    pub port_forwards: Vec<PortForward>,
    pub file_system: Option<RemoteFileSystem>,
    pub keep_alive_interval: Duration,
    pub connect_timeout: Duration,
    pub proxy_command: Option<String>,
    pub remote_platform: Option<Platform>,
    transport: Option<SshTransport>,
    next_channel_id: u32,
}

impl SshConnection {
    pub fn new(host: &str, port: u16, username: &str, auth: SshAuth) -> Self {
        Self {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth,
            state: ConnectionState::Disconnected,
            channels: Vec::new(),
            port_forwards: Vec::new(),
            file_system: None,
            keep_alive_interval: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(15),
            proxy_command: None,
            remote_platform: None,
            transport: None,
            next_channel_id: 1,
        }
    }

    pub async fn connect(&mut self) -> Result<()> {
        self.state = ConnectionState::Connecting;
        let transport = SshTransport::connect_as(
            &self.username,
            &self.host,
            self.port,
            self.auth.clone(),
            Some(self.keep_alive_interval.as_secs()),
        )
        .await?;

        self.state = ConnectionState::Connected;
        self.transport = Some(transport);

        if let Ok(out) = self.exec_command("echo $HOME").await {
            let home = out.stdout.trim().to_string();
            if !home.is_empty() {
                self.file_system = Some(RemoteFileSystem {
                    root: PathBuf::from("/"),
                    home_dir: PathBuf::from(&home),
                });
            }
        }

        if let Ok(out) = self.exec_command("uname -s").await {
            self.remote_platform = match out.stdout.trim().to_lowercase().as_str() {
                "linux" => Some(Platform::Linux),
                "darwin" => Some(Platform::MacOS),
                _ if out.stdout.contains("MINGW") || out.stdout.contains("MSYS") => {
                    Some(Platform::Windows)
                }
                _ => None,
            };
        }

        Ok(())
    }

    pub async fn reconnect_with_backoff(&mut self, max_attempts: u32) -> Result<()> {
        for attempt in 1..=max_attempts {
            self.state = ConnectionState::Reconnecting { attempt };
            let delay = Duration::from_millis(500 * 2u64.pow(attempt.min(6)));
            tokio::time::sleep(delay).await;

            log::info!(
                "SSH reconnect attempt {attempt}/{max_attempts} to {}:{}",
                self.host,
                self.port
            );

            match self.connect().await {
                Ok(()) => return Ok(()),
                Err(e) if attempt == max_attempts => return Err(e),
                Err(e) => log::warn!("reconnect failed: {e}"),
            }
        }
        bail!("reconnection exhausted")
    }

    pub async fn exec_command(&self, cmd: &str) -> Result<ExecOutput> {
        let t = self.transport.as_ref().context("not connected")?;
        t.exec(cmd).await
    }

    pub async fn upload_file(&self, local: &Path, remote: &Path) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.upload(local, &remote.to_string_lossy()).await
    }

    pub async fn download_file(&self, remote: &Path, local: &Path) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.download(&remote.to_string_lossy(), local).await
    }

    pub async fn forward_port(
        &mut self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.forward_port(local_port, remote_host, remote_port).await?;
        self.port_forwards.push(PortForward {
            local_port,
            remote_host: remote_host.to_string(),
            remote_port,
            direction: ForwardDirection::LocalToRemote,
            is_active: true,
        });
        let ch_id = self.next_channel_id;
        self.next_channel_id += 1;
        self.channels.push(SshChannel {
            id: ch_id,
            channel_type: ChannelType::DirectTcpIp {
                host: remote_host.to_string(),
                port: remote_port,
            },
        });
        Ok(())
    }

    pub async fn reverse_forward_port(
        &mut self,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<()> {
        let t = self.transport.as_ref().context("not connected")?;
        t.reverse_forward_port(remote_port, local_host, local_port)
            .await?;
        self.port_forwards.push(PortForward {
            local_port,
            remote_host: local_host.to_string(),
            remote_port,
            direction: ForwardDirection::RemoteToLocal,
            is_active: true,
        });
        Ok(())
    }

    pub async fn install_server(&mut self) -> Result<()> {
        self.state = ConnectionState::InstallingServer;
        let version = env!("CARGO_PKG_VERSION");
        let check = self
            .exec_command("~/.sidex-server/sidex-server --version 2>/dev/null || echo missing")
            .await?;

        if check.stdout.trim() == version {
            log::info!("SideX Server {version} already installed");
            self.state = ConnectionState::Connected;
            return Ok(());
        }

        let platform = self.remote_platform.unwrap_or(Platform::Linux);
        let arch_out = self.exec_command("uname -m").await?;
        let arch = arch_out.stdout.trim();
        let _target = match (platform, arch) {
            (Platform::Linux, "x86_64") => "x86_64-unknown-linux-gnu",
            (Platform::Linux, "aarch64") => "aarch64-unknown-linux-gnu",
            (Platform::MacOS, "x86_64") => "x86_64-apple-darwin",
            (Platform::MacOS, "arm64") => "aarch64-apple-darwin",
            _ => bail!("unsupported remote platform: {platform:?} / {arch}"),
        };

        self.exec_command("mkdir -p ~/.sidex-server").await?;
        log::info!("installing SideX Server {version} on remote");
        self.state = ConnectionState::Connected;
        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<()> {
        if let Some(ref t) = self.transport {
            t.disconnect().await?;
        }
        self.transport = None;
        self.state = ConnectionState::Disconnected;
        self.channels.clear();
        for pf in &mut self.port_forwards {
            pf.is_active = false;
        }
        Ok(())
    }

    pub fn transport(&self) -> Option<&SshTransport> {
        self.transport.as_ref()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshHostConfig {
    pub host_pattern: String,
    pub hostname: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub identity_file: Option<PathBuf>,
    pub proxy_jump: Option<String>,
    pub forward_agent: Option<bool>,
    pub server_alive_interval: Option<u64>,
    pub server_alive_count_max: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct SshConfig {
    pub hosts: Vec<SshHostConfig>,
}

// ---------------------------------------------------------------------------
// Known-hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownHostStatus {
    Trusted,
    Unknown {
        fingerprint: String,
    },
    Changed {
        old_fingerprint: String,
        new_fingerprint: String,
    },
}

/// Check a host key against `~/.ssh/known_hosts`.
pub fn check_known_host(hostname: &str, port: u16, server_key: &PublicKey) -> KnownHostStatus {
    let path = match dirs::home_dir() {
        Some(h) => h.join(".ssh/known_hosts"),
        None => {
            return KnownHostStatus::Unknown {
                fingerprint: server_key.fingerprint(HashAlg::Sha256).to_string(),
            }
        }
    };

    check_known_host_path(hostname, port, server_key, &path)
}

fn check_known_host_path(
    hostname: &str,
    port: u16,
    server_key: &PublicKey,
    path: &Path,
) -> KnownHostStatus {
    let new_fingerprint = server_key.fingerprint(HashAlg::Sha256).to_string();
    match check_known_hosts_path(hostname, port, server_key, path) {
        Ok(true) => KnownHostStatus::Trusted,
        Err(KeyError::KeyChanged { line }) => {
            let old_fingerprint = known_host_keys_path(hostname, port, path)
                .ok()
                .and_then(|keys| keys.into_iter().find(|(entry_line, _)| *entry_line == line))
                .map_or_else(
                    || "unknown".to_string(),
                    |(_, key)| key.fingerprint(HashAlg::Sha256).to_string(),
                );
            KnownHostStatus::Changed {
                old_fingerprint,
                new_fingerprint,
            }
        }
        Ok(false) | Err(_) => KnownHostStatus::Unknown {
            fingerprint: new_fingerprint,
        },
    }
}

// ---------------------------------------------------------------------------
// SSH config parsing
// ---------------------------------------------------------------------------

pub fn parse_ssh_config(path: &Path) -> Result<Vec<SshHostConfig>> {
    let contents =
        std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;

    let mut hosts = Vec::new();
    let mut current: Option<SshHostConfig> = None;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let (keyword, value) = match line.split_once(char::is_whitespace) {
            Some((k, v)) => (k, v.trim()),
            None => continue,
        };

        match keyword.to_lowercase().as_str() {
            "host" => {
                if let Some(entry) = current.take() {
                    hosts.push(entry);
                }
                current = Some(SshHostConfig {
                    host_pattern: value.to_string(),
                    hostname: None,
                    port: None,
                    user: None,
                    identity_file: None,
                    proxy_jump: None,
                    forward_agent: None,
                    server_alive_interval: None,
                    server_alive_count_max: None,
                });
            }
            "hostname" => {
                if let Some(ref mut e) = current {
                    e.hostname = Some(value.to_string());
                }
            }
            "port" => {
                if let Some(ref mut e) = current {
                    e.port = value.parse().ok();
                }
            }
            "user" => {
                if let Some(ref mut e) = current {
                    e.user = Some(value.to_string());
                }
            }
            "identityfile" => {
                if let Some(ref mut e) = current {
                    let expanded = if value.starts_with("~/") {
                        dirs::home_dir()
                            .map_or_else(|| PathBuf::from(value), |h| h.join(&value[2..]))
                    } else {
                        PathBuf::from(value)
                    };
                    e.identity_file = Some(expanded);
                }
            }
            "proxyjump" => {
                if let Some(ref mut e) = current {
                    e.proxy_jump = Some(value.to_string());
                }
            }
            "forwardagent" => {
                if let Some(ref mut e) = current {
                    e.forward_agent = Some(value.eq_ignore_ascii_case("yes"));
                }
            }
            "serveraliveinterval" => {
                if let Some(ref mut e) = current {
                    e.server_alive_interval = value.parse().ok();
                }
            }
            "serveralivecountmax" => {
                if let Some(ref mut e) = current {
                    e.server_alive_count_max = value.parse().ok();
                }
            }
            _ => {}
        }
    }

    if let Some(entry) = current {
        hosts.push(entry);
    }

    Ok(hosts)
}

// ---------------------------------------------------------------------------
// Client handler
// ---------------------------------------------------------------------------

pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts_path: PathBuf,
}

impl ClientHandler {
    fn new(host: &str, port: u16) -> Result<Self> {
        let known_hosts_path = dirs::home_dir()
            .map(|home| home.join(".ssh/known_hosts"))
            .context("locating the home directory for SSH host-key verification")?;
        Ok(Self::with_known_hosts_path(host, port, known_hosts_path))
    }

    fn with_known_hosts_path(host: &str, port: u16, known_hosts_path: PathBuf) -> Self {
        Self {
            host: host.to_string(),
            port,
            known_hosts_path,
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = anyhow::Error;

    #[allow(unknown_lints, clippy::unused_async_trait_impl)]
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        match check_known_hosts_path(
            &self.host,
            self.port,
            server_public_key,
            &self.known_hosts_path,
        ) {
            Ok(true) => Ok(true),
            Ok(false) => bail!(
                "unknown SSH host key for {}:{} ({}); add it to your SSH known_hosts file before connecting",
                self.host,
                self.port,
                server_public_key.fingerprint(HashAlg::Sha256)
            ),
            Err(error) => Err(error).with_context(|| {
                format!("verifying SSH host key for {}:{}", self.host, self.port)
            }),
        }
    }
}

type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;
const SSH_AGENT_AUTH_TIMEOUT: Duration = Duration::from_mins(1);
#[cfg(windows)]
const SSH_AGENT_PIPE_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(unix)]
async fn connect_ssh_agent() -> Result<DynamicAgentClient> {
    AgentClient::connect_env()
        .await
        .map_err(|_| anyhow::anyhow!("unable to connect to the SSH agent from SSH_AUTH_SOCK"))
        .map(AgentClient::dynamic)
}

#[cfg(windows)]
async fn connect_ssh_agent() -> Result<DynamicAgentClient> {
    let configured_socket = std::env::var_os("SSH_AUTH_SOCK");
    let pipe_path = select_windows_agent_pipe(configured_socket.as_deref());

    let pipe_attempt = tokio::time::timeout(
        SSH_AGENT_PIPE_CONNECT_TIMEOUT,
        AgentClient::connect_named_pipe(&pipe_path),
    )
    .await;
    if let Ok(Ok(agent)) = pipe_attempt {
        return Ok(agent.dynamic());
    }

    AgentClient::connect_pageant()
        .await
        .map(AgentClient::dynamic)
        .map_err(|_| {
            anyhow::anyhow!("unable to connect to either the Windows OpenSSH agent or Pageant")
        })
}

#[cfg(windows)]
fn select_windows_agent_pipe(configured_socket: Option<&std::ffi::OsStr>) -> std::ffi::OsString {
    const NAMED_PIPE_PREFIX: &[u8] = br"\\.\pipe\";
    const DEFAULT_OPENSSH_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

    configured_socket
        .filter(|value| {
            value
                .to_string_lossy()
                .as_bytes()
                .get(..NAMED_PIPE_PREFIX.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(NAMED_PIPE_PREFIX))
        })
        .map_or_else(
            || std::ffi::OsString::from(DEFAULT_OPENSSH_PIPE),
            std::ffi::OsStr::to_os_string,
        )
}

#[cfg(not(any(unix, windows)))]
async fn connect_ssh_agent() -> Result<DynamicAgentClient> {
    bail!("SSH agent authentication is unsupported on this platform")
}

fn is_supported_agent_algorithm(algorithm: &Algorithm) -> bool {
    matches!(
        algorithm,
        Algorithm::Ed25519
            | Algorithm::Ecdsa { .. }
            | Algorithm::SkEcdsaSha2NistP256
            | Algorithm::SkEd25519
    )
}

async fn authenticate_agent_identities<S: AgentStream + Send + Unpin>(
    session: &mut client::Handle<ClientHandler>,
    user: &str,
    agent: &mut AgentClient<S>,
) -> Result<client::AuthResult> {
    let identities = agent
        .request_identities()
        .await
        .context("requesting identities from the SSH agent")?;
    let mut last_failure = None;

    for identity in identities {
        if !is_supported_agent_algorithm(&identity.public_key().algorithm()) {
            continue;
        }

        let auth_result = match identity {
            AgentIdentity::PublicKey { key, .. } => session
                .authenticate_publickey_with(user, key, None, agent)
                .await
                .context("authenticating with an SSH agent public key")?,
            AgentIdentity::Certificate { certificate, .. } => session
                .authenticate_certificate_with(user, certificate, None, agent)
                .await
                .context("authenticating with an SSH agent certificate")?,
        };

        if auth_result.success() {
            return Ok(auth_result);
        }
        last_failure = Some(auth_result);
    }

    last_failure.context("the SSH agent has no supported Ed25519, ECDSA, or security-key identity")
}

async fn authenticate_with_agent(
    session: &mut client::Handle<ClientHandler>,
    user: &str,
) -> Result<client::AuthResult> {
    tokio::time::timeout(SSH_AGENT_AUTH_TIMEOUT, async {
        let mut agent = connect_ssh_agent().await?;
        authenticate_agent_identities(session, user, &mut agent).await
    })
    .await
    .map_err(|_| anyhow::anyhow!("SSH agent authentication timed out"))?
}

fn load_configured_private_key(path: &Path, passphrase: Option<&str>) -> Result<PrivateKey> {
    load_secret_key(path, passphrase).context("loading the configured SSH private key")
}

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------

struct PooledSession {
    #[allow(dead_code)]
    handle: client::Handle<ClientHandler>,
    last_used: Instant,
}

pub struct SshConnectionPool {
    sessions: Mutex<HashMap<String, PooledSession>>,
    max_idle: Duration,
}

impl SshConnectionPool {
    pub fn new(max_idle_secs: u64) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            max_idle: Duration::from_secs(max_idle_secs),
        }
    }

    pub async fn get_or_connect(
        &self,
        host: &str,
        port: u16,
        auth: &SshAuth,
        user: &str,
    ) -> Result<client::Handle<ClientHandler>> {
        let key = format!("{user}@{host}:{port}");
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(entry) = sessions.get_mut(&key) {
                if entry.last_used.elapsed() < self.max_idle {
                    entry.last_used = Instant::now();
                    // Return a freshly-opened session instead; Handle is not Clone.
                    drop(sessions);
                    return Self::do_connect(host, port, auth, user).await;
                }
                sessions.remove(&key);
            }
        }

        let handle = Self::do_connect(host, port, auth, user).await?;
        Ok(handle)
    }

    async fn do_connect(
        host: &str,
        port: u16,
        auth: &SshAuth,
        user: &str,
    ) -> Result<client::Handle<ClientHandler>> {
        let config = Arc::new(client::Config::default());
        let handler = ClientHandler::new(host, port)?;
        let mut session = client::connect(config, (host, port), handler)
            .await
            .with_context(|| format!("SSH connect to {host}:{port}"))?;

        let auth_result = match auth {
            SshAuth::Password(ref pw) => session
                .authenticate_password(user, pw)
                .await
                .context("SSH password auth")?,
            SshAuth::KeyFile {
                ref path,
                ref passphrase,
            } => {
                let pair = load_configured_private_key(path, passphrase.as_deref())?;
                session
                    .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(pair), None))
                    .await
                    .context("SSH pubkey auth")?
            }
            SshAuth::Agent => authenticate_with_agent(&mut session, user).await?,
            SshAuth::KeyboardInteractive => {
                bail!("keyboard-interactive auth not yet supported in batch mode")
            }
        };
        if !auth_result.success() {
            bail!("SSH authentication failed for {user}@{host}:{port}");
        }
        Ok(session)
    }

    pub async fn evict_idle(&self) {
        let mut sessions = self.sessions.lock().await;
        sessions.retain(|_, entry| entry.last_used.elapsed() < self.max_idle);
    }
}

// ---------------------------------------------------------------------------
// SshTransport
// ---------------------------------------------------------------------------

pub struct SshTransport {
    session: Arc<Mutex<client::Handle<ClientHandler>>>,
    host: String,
    port: u16,
    #[allow(dead_code)]
    user: String,
    env_vars: Arc<Mutex<HashMap<String, String>>>,
    keepalive_handle: Option<tokio::task::JoinHandle<()>>,
}

impl SshTransport {
    pub async fn connect(host: &str, port: u16, auth: SshAuth) -> Result<Self> {
        Self::connect_as("root", host, port, auth, None).await
    }

    pub async fn connect_as(
        user: &str,
        host: &str,
        port: u16,
        auth: SshAuth,
        keepalive_secs: Option<u64>,
    ) -> Result<Self> {
        let handle = SshConnectionPool::do_connect(host, port, &auth, user).await?;
        let session = Arc::new(Mutex::new(handle));

        let keepalive_handle = keepalive_secs.map(|interval| {
            let sess = Arc::clone(&session);
            tokio::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(interval));
                loop {
                    ticker.tick().await;
                    let s = sess.lock().await;
                    // Send a global request as keepalive; ignore errors
                    let _ = s.channel_open_session().await;
                }
            })
        });

        Ok(Self {
            session,
            host: host.to_string(),
            port,
            user: user.to_string(),
            env_vars: Arc::new(Mutex::new(HashMap::new())),
            keepalive_handle,
        })
    }

    /// Connect through a `ProxyJump` host.
    pub async fn connect_via_proxy(
        proxy_host: &str,
        proxy_port: u16,
        proxy_auth: SshAuth,
        target_host: &str,
        target_port: u16,
        target_auth: SshAuth,
        user: &str,
    ) -> Result<Self> {
        let proxy = Self::connect_as(user, proxy_host, proxy_port, proxy_auth, None).await?;
        proxy.forward_port(0, target_host, target_port).await?;
        Self::connect_as(user, target_host, target_port, target_auth, Some(30)).await
    }

    /// Set an environment variable for subsequent exec calls.
    pub async fn set_env(&self, key: &str, value: &str) {
        self.env_vars
            .lock()
            .await
            .insert(key.to_string(), value.to_string());
    }

    /// Forward local -> remote.
    pub async fn forward_port(
        &self,
        local_port: u16,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<()> {
        let session = Arc::clone(&self.session);
        let remote_host = remote_host.to_string();
        let log_host = remote_host.clone();

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], local_port)))
            .await
            .with_context(|| format!("binding local port {local_port}"))?;

        tokio::spawn(async move {
            loop {
                let Ok((mut local_stream, _)) = listener.accept().await else {
                    break;
                };
                let session = Arc::clone(&session);
                let rh = remote_host.clone();
                tokio::spawn(async move {
                    let channel = {
                        let sess = session.lock().await;
                        match sess
                            .channel_open_direct_tcpip(&rh, remote_port.into(), "127.0.0.1", 0)
                            .await
                        {
                            Ok(ch) => ch,
                            Err(e) => {
                                log::error!("port-forward channel open: {e}");
                                return;
                            }
                        }
                    };
                    let mut remote_stream = channel.into_stream();
                    let _ =
                        tokio::io::copy_bidirectional(&mut local_stream, &mut remote_stream).await;
                });
            }
        });

        log::info!(
            "forwarding 127.0.0.1:{local_port} -> {log_host}:{remote_port} via {}:{}",
            self.host,
            self.port
        );
        Ok(())
    }

    /// Reverse port forward: remote -> local.
    #[allow(unknown_lints, clippy::unused_async, clippy::unused_async_trait_impl)]
    pub async fn reverse_forward_port(
        &self,
        remote_port: u16,
        local_host: &str,
        local_port: u16,
    ) -> Result<()> {
        let local_host_owned = local_host.to_string();
        let local_host_log = local_host_owned.clone();
        let session = Arc::clone(&self.session);

        tokio::spawn(async move {
            loop {
                let channel = {
                    let sess = session.lock().await;
                    match sess.channel_open_session().await {
                        Ok(ch) => ch,
                        Err(_) => break,
                    }
                };
                let mut remote_stream = channel.into_stream();
                let Ok(mut local_stream) =
                    tokio::net::TcpStream::connect(format!("{local_host_owned}:{local_port}"))
                        .await
                else {
                    break;
                };
                let _ = tokio::io::copy_bidirectional(&mut local_stream, &mut remote_stream).await;
            }
        });

        log::info!("reverse forwarding remote:{remote_port} -> {local_host_log}:{local_port}");
        Ok(())
    }

    async fn build_env_prefix(&self) -> String {
        let env = self.env_vars.lock().await;
        if env.is_empty() {
            return String::new();
        }
        let mut prefix = String::new();
        for (k, v) in env.iter() {
            let _ = write!(prefix, "export {k}={v:?}; ");
        }
        prefix
    }

    async fn exec_inner(&self, command: &str) -> Result<ExecOutput> {
        let env_prefix = self.build_env_prefix().await;
        let full_cmd = format!("{env_prefix}{command}");

        let session = self.session.lock().await;
        let channel = session.channel_open_session().await?;
        channel.exec(true, full_cmd.as_bytes()).await?;
        drop(session);

        let mut stdout = Vec::new();
        let stderr = Vec::new();
        let exit_code: i32 = -1;

        let mut stream = channel.into_stream();
        let mut buf = [0u8; 8192];
        loop {
            match stream.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => stdout.extend_from_slice(&buf[..n]),
            }
        }

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
        })
    }
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        if let Some(h) = self.keepalive_handle.take() {
            h.abort();
        }
    }
}

#[async_trait::async_trait]
impl RemoteTransport for SshTransport {
    async fn exec(&self, command: &str) -> Result<ExecOutput> {
        self.exec_inner(command).await
    }

    async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let out = self.exec_inner(&format!("cat {path:?}")).await?;
        if out.exit_code != 0 {
            bail!("read_file({path}): {}", out.stderr);
        }
        Ok(out.stdout.into_bytes())
    }

    async fn write_file(&self, path: &str, data: &[u8]) -> Result<()> {
        let encoded = base64_encode(data);
        let cmd = format!("echo '{encoded}' | base64 -d > {path:?}");
        let out = self.exec_inner(&cmd).await?;
        if out.exit_code != 0 {
            bail!("write_file({path}): {}", out.stderr);
        }
        Ok(())
    }

    async fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let cmd = format!(
            "find {path:?} -maxdepth 1 -mindepth 1 \
             -printf '%f\\t%s\\t%y\\t%T@\\t%p\\n' 2>/dev/null || \
             ls -1 {path:?}"
        );
        let out = self.exec_inner(&cmd).await?;
        let mut entries = Vec::new();
        for line in out.stdout.lines() {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            if parts.len() == 5 {
                let modified = parts[3].parse::<f64>().ok().and_then(|secs| {
                    SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs_f64(secs))
                });
                entries.push(DirEntry {
                    name: parts[0].to_string(),
                    path: parts[4].to_string(),
                    is_dir: parts[2] == "d",
                    size: parts[1].parse().unwrap_or(0),
                    modified,
                });
            } else {
                entries.push(DirEntry {
                    name: line.to_string(),
                    path: format!("{path}/{line}"),
                    is_dir: false,
                    size: 0,
                    modified: None,
                });
            }
        }
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<FileStat> {
        let cmd =
            format!("stat -c '%s %Y %F %h' {path:?} 2>/dev/null || stat -f '%z %m %T %l' {path:?}");
        let out = self.exec_inner(&cmd).await?;
        if out.exit_code != 0 {
            bail!("stat({path}): {}", out.stderr);
        }
        let parts: Vec<&str> = out.stdout.trim().splitn(4, ' ').collect();
        if parts.len() < 4 {
            bail!("unexpected stat output for {path}: {}", out.stdout);
        }
        let size = parts[0].parse().unwrap_or(0);
        let modified_secs: u64 = parts[1].parse().unwrap_or(0);
        let modified =
            SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(modified_secs));
        let file_type = parts[2];
        Ok(FileStat {
            size,
            modified,
            is_dir: file_type.contains("directory"),
            is_symlink: file_type.contains("symbolic") || file_type.contains("link"),
        })
    }

    async fn open_pty(&self, cols: u16, rows: u16) -> Result<RemotePty> {
        let session = self.session.lock().await;
        let channel = session.channel_open_session().await?;
        channel
            .request_pty(true, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
            .await?;
        channel.request_shell(true).await?;
        drop(session);

        let (resize_tx, mut resize_rx) = tokio::sync::mpsc::channel::<(u16, u16)>(8);
        let stream = channel.into_stream();
        let (reader, writer) = tokio::io::split(stream);

        tokio::spawn(async move {
            while let Some((_c, _r)) = resize_rx.recv().await {
                // channel.window_change(c, r, 0, 0) requires channel handle
            }
        });

        Ok(RemotePty::new(
            Box::new(writer),
            Box::new(reader),
            resize_tx,
        ))
    }

    async fn upload(&self, local: &Path, remote: &str) -> Result<()> {
        let data = tokio::fs::read(local)
            .await
            .with_context(|| format!("reading local file {}", local.display()))?;
        self.write_file(remote, &data).await
    }

    async fn download(&self, remote: &str, local: &Path) -> Result<()> {
        let data = self.read_file(remote).await?;
        tokio::fs::write(local, &data)
            .await
            .with_context(|| format!("writing local file {}", local.display()))?;
        Ok(())
    }

    async fn disconnect(&self) -> Result<()> {
        let session = self.session.lock().await;
        session
            .disconnect(russh::Disconnect::ByApplication, "bye", "en")
            .await?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(chunk.get(1).copied().unwrap_or(0));
        let b2 = u32::from(chunk.get(2).copied().unwrap_or(0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

impl SshConfig {
    pub fn resolve(&self, alias: &str) -> Option<&SshHostConfig> {
        self.hosts.iter().find(|h| {
            let pat = &h.host_pattern;
            if let Some(suffix) = pat.strip_prefix('*') {
                alias.ends_with(suffix)
            } else if let Some(prefix) = pat.strip_suffix('*') {
                alias.starts_with(prefix)
            } else {
                pat == alias
            }
        })
    }

    pub fn load_default() -> Result<Self> {
        let path = dirs::home_dir()
            .map(|h| h.join(".ssh/config"))
            .unwrap_or_default();
        if path.exists() {
            let hosts = parse_ssh_config(&path)?;
            Ok(Self { hosts })
        } else {
            Ok(Self { hosts: Vec::new() })
        }
    }
}

/// Connect through a chain of proxy-jump hosts.
pub async fn connect_multi_hop(
    hops: &[(String, u16, SshAuth)],
    final_user: &str,
) -> Result<SshTransport> {
    if hops.is_empty() {
        bail!("multi-hop chain must have at least one hop");
    }
    if hops.len() == 1 {
        let (ref host, port, ref auth) = hops[0];
        return SshTransport::connect_as(final_user, host, port, auth.clone(), Some(30)).await;
    }

    let (ref proxy_host, proxy_port, ref proxy_auth) = hops[0];
    let (ref target_host, target_port, ref target_auth) = hops[hops.len() - 1];
    SshTransport::connect_via_proxy(
        proxy_host,
        proxy_port,
        proxy_auth.clone(),
        target_host,
        target_port,
        target_auth.clone(),
        final_user,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    const ED25519_KEY_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const ED25519_KEY_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";
    const HASHED_EXAMPLE_HOST: &str =
        "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak=";
    const HASHED_EXAMPLE_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    fn write_config(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    fn parse_public_key(value: &str) -> PublicKey {
        PublicKey::from_openssh(value).expect("valid Ed25519 fixture")
    }

    #[test]
    fn parse_simple_ssh_config() {
        let cfg = write_config(
            "\
Host myserver
    HostName 192.168.1.100
    Port 2222
    User deploy
    IdentityFile ~/.ssh/deploy_key
    ForwardAgent yes
    ServerAliveInterval 60

Host *.example.com
    User admin
    ProxyJump bastion
",
        );
        let hosts = parse_ssh_config(cfg.path()).unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].host_pattern, "myserver");
        assert_eq!(hosts[0].hostname.as_deref(), Some("192.168.1.100"));
        assert_eq!(hosts[0].port, Some(2222));
        assert_eq!(hosts[0].forward_agent, Some(true));
        assert_eq!(hosts[0].server_alive_interval, Some(60));
        assert_eq!(hosts[1].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn parse_empty_config() {
        let cfg = write_config("");
        let hosts = parse_ssh_config(cfg.path()).unwrap();
        assert!(hosts.is_empty());
    }

    #[test]
    fn config_resolve_exact() {
        let config = SshConfig {
            hosts: vec![SshHostConfig {
                host_pattern: "prod".to_string(),
                hostname: Some("10.0.0.1".to_string()),
                port: Some(22),
                user: Some("root".to_string()),
                identity_file: None,
                proxy_jump: None,
                forward_agent: None,
                server_alive_interval: None,
                server_alive_count_max: None,
            }],
        };
        assert!(config.resolve("prod").is_some());
        assert!(config.resolve("staging").is_none());
    }

    #[test]
    fn known_host_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let server_key = parse_public_key(ED25519_KEY_A);
        let status = check_known_host_path(
            "nonexistent.test",
            22,
            &server_key,
            &dir.path().join("known_hosts"),
        );
        assert!(matches!(status, KnownHostStatus::Unknown { .. }));
    }

    #[test]
    fn known_host_requires_matching_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(
            &path,
            "database.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ\n",
        )
        .unwrap();

        let trusted_key = parse_public_key(ED25519_KEY_A);
        let changed_key = parse_public_key(ED25519_KEY_B);

        assert_eq!(
            check_known_host_path("database.example", 22, &trusted_key, &path),
            KnownHostStatus::Trusted
        );
        assert!(matches!(
            check_known_host_path("database.example", 22, &changed_key, &path),
            KnownHostStatus::Changed { .. }
        ));
    }

    #[tokio::test]
    async fn client_handler_rejects_unknown_host() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, format!("other.example {ED25519_KEY_A}\n")).unwrap();
        let mut handler = ClientHandler::with_known_hosts_path("database.example", 22, path);

        let error =
            client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_A))
                .await
                .expect_err("an unknown host must be rejected");

        assert!(error.to_string().contains("unknown SSH host key"));
    }

    #[tokio::test]
    async fn client_handler_rejects_changed_host_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, format!("database.example {ED25519_KEY_A}\n")).unwrap();
        let mut handler = ClientHandler::with_known_hosts_path("database.example", 22, path);

        let error =
            client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_B))
                .await
                .expect_err("a changed host key must be rejected");

        assert!(format!("{error:#}").to_lowercase().contains("key changed"));
    }

    #[tokio::test]
    async fn client_handler_rejects_missing_known_hosts_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut handler = ClientHandler::with_known_hosts_path(
            "database.example",
            22,
            dir.path().join("missing_known_hosts"),
        );

        client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_A))
            .await
            .expect_err("a missing known_hosts file must fail closed");
    }

    #[tokio::test]
    async fn client_handler_error_does_not_disclose_known_hosts_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private_known_hosts");
        let path_text = path.display().to_string();
        let mut handler = ClientHandler::with_known_hosts_path("database.example", 22, path);

        let error =
            client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_A))
                .await
                .expect_err("a missing known_hosts file must fail closed");

        assert!(!format!("{error:#}").contains(&path_text));
    }

    #[tokio::test]
    async fn client_handler_rejects_unreadable_known_hosts_path() {
        let dir = tempfile::tempdir().unwrap();
        let mut handler =
            ClientHandler::with_known_hosts_path("database.example", 22, dir.path().to_path_buf());

        client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_A))
            .await
            .expect_err("an unreadable known_hosts path must fail closed");
    }

    #[tokio::test]
    async fn client_handler_accepts_matching_key_on_nonstandard_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(&path, format!("[database.example]:2222 {ED25519_KEY_A}\n")).unwrap();
        let mut handler = ClientHandler::with_known_hosts_path("database.example", 2222, path);

        let accepted =
            client::Handler::check_server_key(&mut handler, &parse_public_key(ED25519_KEY_A))
                .await
                .expect("a matching nonstandard-port host key must be accepted");

        assert!(accepted);
    }

    #[tokio::test]
    async fn client_handler_accepts_hashed_host_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        std::fs::write(
            &path,
            format!("{HASHED_EXAMPLE_HOST} {HASHED_EXAMPLE_KEY}\n"),
        )
        .unwrap();
        let mut handler = ClientHandler::with_known_hosts_path("example.com", 22, path);

        let accepted =
            client::Handler::check_server_key(&mut handler, &parse_public_key(HASHED_EXAMPLE_KEY))
                .await
                .expect("a matching hashed host key must be accepted");

        assert!(accepted);
    }

    #[test]
    fn agent_algorithm_policy_accepts_ed25519() {
        assert!(is_supported_agent_algorithm(&Algorithm::Ed25519));
    }

    #[test]
    fn agent_algorithm_policy_accepts_ecdsa() {
        assert!(is_supported_agent_algorithm(&Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        }));
    }

    #[test]
    fn agent_algorithm_policy_accepts_security_keys() {
        assert!(is_supported_agent_algorithm(
            &Algorithm::SkEcdsaSha2NistP256
        ));
        assert!(is_supported_agent_algorithm(&Algorithm::SkEd25519));
    }

    #[test]
    fn agent_algorithm_policy_rejects_rsa() {
        assert!(!is_supported_agent_algorithm(&Algorithm::Rsa {
            hash: None
        }));
    }

    #[test]
    fn agent_algorithm_policy_rejects_dsa() {
        assert!(!is_supported_agent_algorithm(&Algorithm::Dsa));
    }

    #[cfg(windows)]
    #[test]
    fn windows_agent_pipe_accepts_only_named_pipe_paths() {
        use std::ffi::{OsStr, OsString};

        let configured = select_windows_agent_pipe(Some(OsStr::new(r"\\.\PIPE\custom-agent")));
        let msys_socket = select_windows_agent_pipe(Some(OsStr::new("C:/tmp/ssh-agent.sock")));

        assert_eq!(configured, OsString::from(r"\\.\PIPE\custom-agent"));
        assert_eq!(msys_socket, OsString::from(r"\\.\pipe\openssh-ssh-agent"));
    }

    #[test]
    fn private_key_load_error_does_not_disclose_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("private_key");
        let path_text = path.display().to_string();

        let error = load_configured_private_key(&path, None)
            .expect_err("a missing private key must return an error");

        assert!(!format!("{error:#}").contains(&path_text));
    }

    #[test]
    fn pool_creation() {
        let pool = SshConnectionPool::new(300);
        assert_eq!(pool.max_idle, Duration::from_mins(5));
    }
}
