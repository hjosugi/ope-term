use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use glob::glob;
use serde::Serialize;

const MULTI_VALUE_KEYS: &[&str] = &[
    "identityfile",
    "certificatefile",
    "localforward",
    "remoteforward",
    "dynamicforward",
    "sendenv",
];
const MAX_INCLUDE_DEPTH: usize = 32;
const MAX_CONFIG_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONFIG_FILES: usize = 1024;
const MAX_CONFIG_DIRECTIVES: usize = 100_000;
const MAX_DIRECTIVE_BYTES: usize = 64 * 1024;
const MAX_INCLUDE_MATCHES: usize = 1024;
const MAX_HOST_SPEC_BYTES: usize = 4 * 1024;
const MAX_USER_BYTES: usize = 1024;
const MAX_AUTH_PATH_BYTES: usize = 32 * 1024;
const MAX_ROUTE_HOPS: usize = 32;
const MAX_AUTH_FILES: usize = 64;
const MAX_HOST_PROFILES: usize = 2_048;

#[derive(Debug, Clone, Default)]
enum Selector {
    #[default]
    Never,
    Host(Vec<String>),
    Match(Vec<MatchCriterion>),
}

#[derive(Debug, Clone)]
struct MatchCriterion {
    kind: MatchKind,
    patterns: Vec<String>,
    negated: bool,
}

#[derive(Debug, Clone, Copy)]
enum MatchKind {
    Host,
    OriginalHost,
    User,
    All,
}

#[derive(Debug, Clone, Default)]
pub struct Block {
    patterns: Vec<String>,
    options: HashMap<String, Vec<String>>,
    implicit: bool,
    selector: Selector,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_files: Vec<PathBuf>,
    pub certificate_files: Vec<PathBuf>,
    pub host_key_alias: Option<String>,
    pub identities_only: bool,
    pub proxy_jump: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub alias: String,
    pub hostname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_jump: Option<String>,
    pub chain: Vec<String>,
}

struct ParseBudget {
    remaining_bytes: usize,
    remaining_directives: usize,
    files: usize,
}

impl Default for ParseBudget {
    fn default() -> Self {
        Self {
            remaining_bytes: MAX_CONFIG_BYTES,
            remaining_directives: MAX_CONFIG_DIRECTIVES,
            files: 0,
        }
    }
}

pub fn default_config_path() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("config"))
        .ok_or_else(|| anyhow!("ホームディレクトリを特定できません"))
}

pub fn load_default() -> Result<Vec<Block>> {
    let path = default_config_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    load(&path)
}

pub fn load(path: &Path) -> Result<Vec<Block>> {
    let include_root = path.parent().unwrap_or_else(|| Path::new("."));
    let mut blocks = vec![implicit_block()];
    let mut active = Vec::new();
    let mut budget = ParseBudget::default();
    parse_file(path, include_root, &mut active, &mut blocks, &mut budget)?;
    Ok(blocks)
}

pub fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for character in line.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '#' && quote.is_none() && current.is_empty() {
            break;
        }
        if character.is_whitespace() && quote.is_none() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(character);
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(any(test, feature = "fuzzing"))]
pub(crate) fn parse(text: &str) -> Vec<Block> {
    let mut blocks = vec![implicit_block()];
    parse_text(
        text,
        None,
        &mut Vec::new(),
        &mut blocks,
        &mut ParseBudget::default(),
    )
    .expect("in-memory config has no includes");
    blocks
}

fn implicit_block() -> Block {
    Block {
        patterns: vec!["*".into()],
        implicit: true,
        selector: Selector::Host(vec!["*".into()]),
        ..Default::default()
    }
}

fn parse_file(
    path: &Path,
    include_root: &Path,
    active: &mut Vec<PathBuf>,
    blocks: &mut Vec<Block>,
    budget: &mut ParseBudget,
) -> Result<()> {
    if active.len() >= MAX_INCLUDE_DEPTH {
        bail!("SSH config Include が {MAX_INCLUDE_DEPTH} 階層を超えています");
    }
    let canonical =
        fs::canonicalize(path).with_context(|| format!("{} を解決できません", path.display()))?;
    if let Some(index) = active.iter().position(|candidate| candidate == &canonical) {
        let mut cycle: Vec<_> = active[index..]
            .iter()
            .map(|item| item.display().to_string())
            .collect();
        cycle.push(canonical.display().to_string());
        bail!(
            "SSH config Include の循環を検出しました: {}",
            cycle.join(" → ")
        );
    }

    let text = read_config_file(&canonical, budget)?;
    active.push(canonical);
    let result = parse_text(&text, Some(include_root), active, blocks, budget);
    active.pop();
    result
}

fn parse_text(
    text: &str,
    include_root: Option<&Path>,
    active: &mut Vec<PathBuf>,
    blocks: &mut Vec<Block>,
    budget: &mut ParseBudget,
) -> Result<()> {
    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed.len() > MAX_DIRECTIVE_BYTES {
            bail!("SSH config directive が {MAX_DIRECTIVE_BYTES} bytes を超えています");
        }
        if budget.remaining_directives == 0 {
            bail!("SSH config directive が合計 {MAX_CONFIG_DIRECTIVES} 件を超えています");
        }
        budget.remaining_directives -= 1;
        let normalized = normalize_equals(trimmed);
        let tokens = tokenize(&normalized);
        let Some(key) = tokens.first().map(|value| value.to_ascii_lowercase()) else {
            continue;
        };
        let values = &tokens[1..];

        if key == "host" {
            blocks.push(Block {
                patterns: values.to_vec(),
                selector: Selector::Host(values.to_vec()),
                ..Default::default()
            });
            continue;
        }
        if key == "match" {
            blocks.push(Block {
                selector: parse_match(values),
                ..Default::default()
            });
            continue;
        }
        if key == "include" {
            let Some(include_root) = include_root else {
                continue;
            };
            for pattern in values {
                for path in expand_include_pattern(pattern, include_root)? {
                    parse_file(&path, include_root, active, blocks, budget)?;
                }
            }
            continue;
        }

        let current = blocks.last_mut().expect("implicit block always exists");
        let value = values.join(" ");
        if MULTI_VALUE_KEYS.contains(&key.as_str()) {
            current.options.entry(key).or_default().push(value);
        } else {
            current.options.entry(key).or_insert_with(|| vec![value]);
        }
    }
    Ok(())
}

fn read_config_file(path: &Path, budget: &mut ParseBudget) -> Result<String> {
    if budget.files >= MAX_CONFIG_FILES {
        bail!("SSH config Include が合計 {MAX_CONFIG_FILES} file を超えています");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("{} を読み込めません", path.display()))?;
    let metadata = file
        .metadata()
        .with_context(|| format!("{} のサイズを確認できません", path.display()))?;
    if !metadata.is_file() {
        bail!("{} は通常 file ではありません", path.display());
    }
    let declared_bytes = metadata.len();
    if declared_bytes > budget.remaining_bytes as u64 {
        bail!("SSH config Include の合計が {MAX_CONFIG_BYTES} bytes を超えています");
    }
    let mut bytes = Vec::with_capacity(declared_bytes as usize);
    file.by_ref()
        .take(budget.remaining_bytes.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .with_context(|| format!("{} を読み込めません", path.display()))?;
    if bytes.len() > budget.remaining_bytes {
        bail!("SSH config Include の合計が {MAX_CONFIG_BYTES} bytes を超えています");
    }
    budget.remaining_bytes -= bytes.len();
    budget.files += 1;
    String::from_utf8(bytes).with_context(|| format!("{} は UTF-8 ではありません", path.display()))
}

fn expand_include_pattern(value: &str, include_root: &Path) -> Result<Vec<PathBuf>> {
    let expanded = expand_environment(value);
    let expanded = expand_home(&expanded, dirs::home_dir().as_deref());
    let pattern = if expanded.is_absolute() {
        expanded
    } else {
        include_root.join(expanded)
    };
    let pattern = pattern.to_string_lossy();
    let mut matches = glob(&pattern)
        .with_context(|| format!("Include pattern が不正です: {pattern}"))?
        .filter_map(std::result::Result::ok)
        .take(MAX_INCLUDE_MATCHES + 1)
        .collect::<Vec<_>>();
    if matches.len() > MAX_INCLUDE_MATCHES {
        bail!("Include pattern が {MAX_INCLUDE_MATCHES} file を超えて展開されます: {pattern}");
    }
    matches.sort();
    Ok(matches)
}

fn expand_environment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        output.push_str(&rest[..start]);
        let variable = &rest[start + 2..];
        let Some(end) = variable.find('}') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let name = &variable[..end];
        if let Ok(replacement) = std::env::var(name) {
            output.push_str(&replacement);
        } else {
            output.push_str(&rest[start..start + end + 3]);
        }
        rest = &variable[end + 1..];
    }
    output.push_str(rest);
    output
}

fn parse_match(values: &[String]) -> Selector {
    if values.len() == 1 && values[0].eq_ignore_ascii_case("all") {
        return Selector::Match(vec![MatchCriterion {
            kind: MatchKind::All,
            patterns: Vec::new(),
            negated: false,
        }]);
    }

    let mut criteria = Vec::new();
    let mut index = 0;
    while index < values.len() {
        let raw_kind = values[index].to_ascii_lowercase();
        let (kind_name, negated) = raw_kind
            .strip_prefix('!')
            .map(|kind| (kind, true))
            .unwrap_or((raw_kind.as_str(), false));
        let kind = match kind_name {
            "host" => MatchKind::Host,
            "originalhost" => MatchKind::OriginalHost,
            "user" => MatchKind::User,
            _ => return Selector::Never,
        };
        let Some(patterns) = values.get(index + 1) else {
            return Selector::Never;
        };
        criteria.push(MatchCriterion {
            kind,
            patterns: patterns
                .split(',')
                .filter(|pattern| !pattern.is_empty())
                .map(str::to_owned)
                .collect(),
            negated,
        });
        index += 2;
    }
    Selector::Match(criteria)
}

fn normalize_equals(line: &str) -> String {
    let Some(index) = line.find('=') else {
        return line.to_owned();
    };
    if line[..index]
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        format!("{} {}", &line[..index], &line[index + 1..])
    } else {
        line.to_owned()
    }
}

fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let mut previous = vec![false; pattern.len() + 1];
    previous[0] = true;
    for index in 1..=pattern.len() {
        if pattern[index - 1] == b'*' {
            previous[index] = previous[index - 1];
        }
    }

    let mut current = vec![false; pattern.len() + 1];
    for byte in value.bytes() {
        current.fill(false);
        for index in 1..=pattern.len() {
            current[index] = match pattern[index - 1] {
                b'*' => current[index - 1] || previous[index],
                b'?' => previous[index - 1],
                literal => literal == byte && previous[index - 1],
            };
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[pattern.len()]
}

fn pattern_list_matches(value: &str, patterns: &[String]) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negative) = pattern.strip_prefix('!') {
            if glob_matches(negative, value) {
                return false;
            }
        } else if glob_matches(pattern, value) {
            matched = true;
        }
    }
    matched
}

pub fn resolve(alias: &str, blocks: &[Block]) -> Result<Endpoint> {
    if alias.len() > MAX_HOST_SPEC_BYTES {
        bail!("ホスト指定が {MAX_HOST_SPEC_BYTES} bytes を超えています");
    }
    let parsed = parse_jump_spec(alias);
    let canonical_alias = parsed.alias;
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    for block in blocks {
        if !selector_matches(
            &block.selector,
            &canonical_alias,
            parsed.user.as_deref(),
            &values,
        ) {
            continue;
        }
        for (key, candidates) in &block.options {
            if MULTI_VALUE_KEYS.contains(&key.as_str()) {
                values
                    .entry(key.clone())
                    .or_default()
                    .extend(candidates.clone());
            } else {
                values
                    .entry(key.clone())
                    .or_insert_with(|| candidates.clone());
            }
        }
    }

    let raw_hostname = first(&values, "hostname").unwrap_or_else(|| canonical_alias.clone());
    let hostname = expand_tokens(
        &raw_hostname,
        &TokenContext {
            hostname: &canonical_alias,
            original_host: &canonical_alias,
            port: 22,
            remote_user: parsed.user.as_deref().unwrap_or(""),
            home: dirs::home_dir().as_deref(),
        },
    );
    let port = parsed
        .port
        .or_else(|| first(&values, "port").and_then(|value| value.parse().ok()))
        .unwrap_or(22);
    let home = dirs::home_dir();
    let user = parsed.user.or_else(|| first(&values, "user"));
    let remote_user = user.clone().unwrap_or_else(default_username);
    let token_context = TokenContext {
        hostname: &hostname,
        original_host: &canonical_alias,
        port,
        remote_user: &remote_user,
        home: home.as_deref(),
    };
    let identity_files: Vec<_> = values
        .remove("identityfile")
        .unwrap_or_default()
        .into_iter()
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| expand_home(&expand_tokens(&value, &token_context), home.as_deref()))
        .collect();
    if identity_files.len() > MAX_AUTH_FILES {
        bail!("IdentityFile が {MAX_AUTH_FILES} 件を超えています");
    }
    let certificate_files: Vec<_> = values
        .remove("certificatefile")
        .unwrap_or_default()
        .into_iter()
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| expand_home(&expand_tokens(&value, &token_context), home.as_deref()))
        .collect();
    if certificate_files.len() > MAX_AUTH_FILES {
        bail!("CertificateFile が {MAX_AUTH_FILES} 件を超えています");
    }
    let proxy_jump = first(&values, "proxyjump")
        .filter(|value| !value.eq_ignore_ascii_case("none"))
        .map(|value| expand_tokens(&value, &token_context));

    let endpoint = Endpoint {
        alias: canonical_alias,
        hostname,
        user,
        port,
        identity_files,
        certificate_files,
        host_key_alias: first(&values, "hostkeyalias"),
        identities_only: first(&values, "identitiesonly")
            .is_some_and(|value| value.eq_ignore_ascii_case("yes")),
        proxy_jump,
    };
    validate_endpoint(&endpoint)?;
    Ok(endpoint)
}

fn validate_endpoint(endpoint: &Endpoint) -> Result<()> {
    if endpoint.hostname.is_empty() || endpoint.hostname.len() > MAX_HOST_SPEC_BYTES {
        bail!("HostName は1..={MAX_HOST_SPEC_BYTES} bytesにしてください");
    }
    if endpoint
        .user
        .as_ref()
        .is_some_and(|user| user.is_empty() || user.len() > MAX_USER_BYTES)
    {
        bail!("User は1..={MAX_USER_BYTES} bytesにしてください");
    }
    if endpoint
        .host_key_alias
        .as_ref()
        .is_some_and(|alias| alias.is_empty() || alias.len() > MAX_HOST_SPEC_BYTES)
    {
        bail!("HostKeyAlias は1..={MAX_HOST_SPEC_BYTES} bytesにしてください");
    }
    if endpoint
        .identity_files
        .iter()
        .chain(&endpoint.certificate_files)
        .any(|path| {
            path.as_os_str().is_empty()
                || path.as_os_str().to_string_lossy().len() > MAX_AUTH_PATH_BYTES
        })
    {
        bail!("認証file pathは1..={MAX_AUTH_PATH_BYTES} bytesにしてください");
    }
    Ok(())
}

fn selector_matches(
    selector: &Selector,
    original_host: &str,
    command_user: Option<&str>,
    values: &HashMap<String, Vec<String>>,
) -> bool {
    match selector {
        Selector::Never => false,
        Selector::Host(patterns) => pattern_list_matches(original_host, patterns),
        Selector::Match(criteria) => {
            let hostname = first(values, "hostname")
                .map(|value| {
                    value
                        .replace("%%", "\0")
                        .replace("%h", original_host)
                        .replace('\0', "%")
                })
                .unwrap_or_else(|| original_host.to_owned());
            let user = command_user
                .map(str::to_owned)
                .or_else(|| first(values, "user"))
                .unwrap_or_else(default_username);
            criteria.iter().all(|criterion| {
                let matched = match criterion.kind {
                    MatchKind::All => true,
                    MatchKind::Host => pattern_list_matches(&hostname, &criterion.patterns),
                    MatchKind::OriginalHost => {
                        pattern_list_matches(original_host, &criterion.patterns)
                    }
                    MatchKind::User => pattern_list_matches(&user, &criterion.patterns),
                };
                matched != criterion.negated
            })
        }
    }
}

struct TokenContext<'a> {
    hostname: &'a str,
    original_host: &'a str,
    port: u16,
    remote_user: &'a str,
    home: Option<&'a Path>,
}

fn expand_tokens(value: &str, context: &TokenContext<'_>) -> String {
    let home = context
        .home
        .map(|path| path.to_string_lossy())
        .unwrap_or_default();
    let port = context.port.to_string();
    let mut output = String::with_capacity(value.len());
    let mut characters = value.chars();
    while let Some(character) = characters.next() {
        if character != '%' {
            output.push(character);
            continue;
        }
        match characters.next() {
            Some('%') => output.push('%'),
            Some('d') => output.push_str(&home),
            Some('h') => output.push_str(context.hostname),
            Some('n') => output.push_str(context.original_host),
            Some('p') => output.push_str(&port),
            Some('r') => output.push_str(context.remote_user),
            Some(other) => {
                output.push('%');
                output.push(other);
            }
            None => output.push('%'),
        }
    }
    output
}

fn default_username() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "root".to_owned())
}

fn first(values: &HashMap<String, Vec<String>>, key: &str) -> Option<String> {
    values.get(key).and_then(|items| items.first()).cloned()
}

fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    if value == "~" {
        return home.unwrap_or_else(|| Path::new("~")).to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/")
        && let Some(home) = home
    {
        return home.join(rest);
    }
    PathBuf::from(value)
}

struct JumpSpec {
    alias: String,
    user: Option<String>,
    port: Option<u16>,
}

fn parse_jump_spec(value: &str) -> JumpSpec {
    let (user, host_port) = value
        .rsplit_once('@')
        .map(|(user, rest)| (Some(user.to_owned()), rest))
        .unwrap_or((None, value));
    let (alias, port) = host_port
        .rsplit_once(':')
        .and_then(|(host, port)| port.parse().ok().map(|port| (host, port)))
        .map(|(host, port)| (host.to_owned(), Some(port)))
        .unwrap_or_else(|| (host_port.to_owned(), None));
    JumpSpec { alias, user, port }
}

pub fn list_hosts(blocks: &[Block]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut hosts = Vec::new();
    for block in blocks {
        if block.implicit || !matches!(block.selector, Selector::Host(_)) {
            continue;
        }
        for pattern in &block.patterns {
            if pattern.starts_with('!') || pattern.contains('*') || pattern.contains('?') {
                continue;
            }
            if seen.insert(pattern.clone()) {
                hosts.push(pattern.clone());
            }
        }
    }
    hosts
}

pub fn chain_for_route(route: &[String], blocks: &[Block]) -> Result<Vec<Endpoint>> {
    if route.is_empty() {
        bail!("接続ルートが空です");
    }
    if route.len() > MAX_ROUTE_HOPS {
        bail!("接続ルートが {MAX_ROUTE_HOPS} hop を超えています");
    }
    if route.len() > 1 {
        return route.iter().map(|alias| resolve(alias, blocks)).collect();
    }

    let mut chain = Vec::new();
    let mut stack = Vec::new();
    let mut expanded = 0;
    expand_chain(&route[0], blocks, &mut stack, &mut chain, &mut expanded)?;
    Ok(chain)
}

fn expand_chain(
    alias: &str,
    blocks: &[Block],
    stack: &mut Vec<String>,
    output: &mut Vec<Endpoint>,
    expanded: &mut usize,
) -> Result<()> {
    if *expanded >= MAX_ROUTE_HOPS {
        bail!("ProxyJump の展開が {MAX_ROUTE_HOPS} hop を超えています");
    }
    *expanded += 1;
    let endpoint = resolve(alias, blocks)?;
    if stack.contains(&endpoint.alias) {
        stack.push(endpoint.alias);
        bail!("ProxyJump の循環を検出しました: {}", stack.join(" → "));
    }
    stack.push(endpoint.alias.clone());
    if let Some(jumps) = &endpoint.proxy_jump {
        for jump in jumps
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
        {
            expand_chain(jump, blocks, stack, output, expanded)?;
        }
    }
    stack.pop();
    output.push(endpoint);
    Ok(())
}

pub fn profiles(blocks: &[Block]) -> Result<Vec<HostProfile>> {
    let aliases = list_hosts(blocks);
    if aliases.len() > MAX_HOST_PROFILES {
        bail!("表示可能な具体 Host は {MAX_HOST_PROFILES} 件までです");
    }
    Ok(aliases
        .into_iter()
        .filter_map(|alias| {
            let endpoint = resolve(&alias, blocks).ok()?;
            let chain = chain_for_route(std::slice::from_ref(&alias), blocks)
                .unwrap_or_else(|_| vec![endpoint.clone()])
                .into_iter()
                .map(|hop| hop.alias)
                .collect();
            Some(HostProfile {
                alias,
                hostname: endpoint.hostname,
                user: endpoint.user,
                port: endpoint.port,
                proxy_jump: endpoint.proxy_jump,
                chain,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
Host prod-db
  HostName 10.0.2.15
  User admin
  ProxyJump bastion,dmz
  IdentityFile ~/.ssh/id_ed25519

Host bastion
  HostName bastion.example.com
  Port 2222

Host dmz
  HostName 192.168.10.5

Host github.com
  User=git

Host * !secret-*
  User operator
  IdentityFile ~/.ssh/id_rsa
"#;

    #[test]
    fn lists_concrete_aliases_only() {
        assert_eq!(
            list_hosts(&parse(CONFIG)),
            ["prod-db", "bastion", "dmz", "github.com"]
        );
    }

    #[test]
    fn bounds_profiles_before_resolving_every_host() {
        let config = (0..=MAX_HOST_PROFILES)
            .map(|index| format!("Host host-{index}\n"))
            .collect::<String>();
        let error = profiles(&parse(&config)).unwrap_err();
        assert!(error.to_string().contains(&MAX_HOST_PROFILES.to_string()));
    }

    #[test]
    fn bounds_directive_length_and_count_before_tokenization() {
        let oversized = format!("Host {}", "x".repeat(MAX_DIRECTIVE_BYTES));
        let mut blocks = vec![implicit_block()];
        let error = parse_text(
            &oversized,
            None,
            &mut Vec::new(),
            &mut blocks,
            &mut ParseBudget::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains(&MAX_DIRECTIVE_BYTES.to_string()));

        let repeated = "User operator\n".repeat(MAX_CONFIG_DIRECTIVES + 1);
        let mut blocks = vec![implicit_block()];
        let error = parse_text(
            &repeated,
            None,
            &mut Vec::new(),
            &mut blocks,
            &mut ParseBudget::default(),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains(&MAX_CONFIG_DIRECTIVES.to_string())
        );
    }

    #[test]
    fn uses_first_obtained_scalar_and_accumulates_identity_files() {
        let resolved = resolve("prod-db", &parse(CONFIG)).unwrap();
        assert_eq!(resolved.user.as_deref(), Some("admin"));
        assert_eq!(resolved.identity_files.len(), 2);
    }

    #[test]
    fn bounds_identity_and_certificate_candidates() {
        for directive in ["IdentityFile", "CertificateFile"] {
            let mut config = String::from("Host crowded\n");
            for index in 0..=MAX_AUTH_FILES {
                config.push_str(&format!("  {directive} ~/.ssh/key-{index}\n"));
            }
            let error = resolve("crowded", &parse(&config)).unwrap_err();
            assert!(error.to_string().contains(&MAX_AUTH_FILES.to_string()));
        }
    }

    #[test]
    fn bounds_resolved_network_values_and_auth_paths() {
        for (directive, value, maximum) in [
            ("HostName", "h", MAX_HOST_SPEC_BYTES),
            ("User", "u", MAX_USER_BYTES),
            ("HostKeyAlias", "a", MAX_HOST_SPEC_BYTES),
            ("IdentityFile", "p", MAX_AUTH_PATH_BYTES),
            ("CertificateFile", "p", MAX_AUTH_PATH_BYTES),
        ] {
            let config = format!(
                "Host bounded\n  {directive} {}\n",
                value.repeat(maximum + 1)
            );
            let error = resolve("bounded", &parse(&config)).unwrap_err();
            assert!(error.to_string().contains("bytes"));
        }
    }

    #[test]
    fn supports_key_equals_value() {
        assert_eq!(
            resolve("github.com", &parse(CONFIG))
                .unwrap()
                .user
                .as_deref(),
            Some("git")
        );
    }

    #[test]
    fn expands_proxy_jump_chain() {
        let aliases: Vec<_> = chain_for_route(&["prod-db".into()], &parse(CONFIG))
            .unwrap()
            .into_iter()
            .map(|item| item.alias)
            .collect();
        assert_eq!(aliases, ["bastion", "dmz", "prod-db"]);
    }

    #[test]
    fn explicit_route_is_not_auto_expanded() {
        let aliases: Vec<_> =
            chain_for_route(&["bastion".into(), "prod-db".into()], &parse(CONFIG))
                .unwrap()
                .into_iter()
                .map(|item| item.alias)
                .collect();
        assert_eq!(aliases, ["bastion", "prod-db"]);
    }

    #[test]
    fn detects_proxy_jump_cycles() {
        let blocks = parse("Host a\n ProxyJump b\nHost b\n ProxyJump a\n");
        assert!(
            chain_for_route(&["a".into()], &blocks)
                .unwrap_err()
                .to_string()
                .contains("循環")
        );
    }

    #[test]
    fn bounds_proxy_jump_routes_that_change_alias_on_every_hop() {
        let blocks = parse("ProxyJump next-%n\n");
        let error = chain_for_route(&["root".into()], &blocks).unwrap_err();

        assert!(error.to_string().contains("32 hop"));
    }

    #[test]
    fn bounds_proxy_jump_alias_growth() {
        let blocks = parse("ProxyJump %n%n\n");
        let error = chain_for_route(&["root".into()], &blocks).unwrap_err();

        assert!(error.to_string().contains("4096 bytes"));
    }

    #[test]
    fn bounds_explicit_routes() {
        let route = (0..=MAX_ROUTE_HOPS)
            .map(|index| format!("host-{index}"))
            .collect::<Vec<_>>();
        let error = chain_for_route(&route, &parse("")).unwrap_err();

        assert!(error.to_string().contains("32 hop"));
    }

    #[test]
    fn handles_quotes_comments_and_negation() {
        assert_eq!(
            tokenize("IdentityFile \"~/my keys/id\" # note"),
            ["IdentityFile", "~/my keys/id"]
        );
        assert!(resolve("secret-a", &parse(CONFIG)).unwrap().user.is_none());
    }

    #[test]
    fn matches_adversarial_wildcards_without_exponential_backtracking() {
        assert!(!glob_matches(
            "********&",
            "******************************************************a"
        ));
        assert!(glob_matches("***prod**-??", "prod-db"));
    }

    #[test]
    fn parses_jump_user_and_port_override() {
        let endpoint = resolve("alice@bastion:2200", &parse(CONFIG)).unwrap();
        assert_eq!(endpoint.alias, "bastion");
        assert_eq!(endpoint.user.as_deref(), Some("alice"));
        assert_eq!(endpoint.port, 2200);
    }

    #[test]
    fn evaluates_supported_match_criteria_against_resolved_values() {
        let blocks = parse(
            r#"
Host prod
  HostName prod.internal
  User deploy
Match host prod.internal originalhost prod user deploy
  Port 2201
Match !user deploy
  HostKeyAlias must-not-match
"#,
        );

        let endpoint = resolve("prod", &blocks).unwrap();
        assert_eq!(endpoint.port, 2201);
        assert_eq!(endpoint.host_key_alias, None);
    }

    #[test]
    fn expands_connection_tokens_in_paths_and_proxy_jump() {
        let endpoint = resolve(
            "prod",
            &parse(
                r#"
Host prod
  HostName %h.internal
  User deploy
  Port 2201
  IdentityFile %d/.ssh/%r@%h-%p-%n
  CertificateFile %d/.ssh/%n-cert.pub
  ProxyJump jump-%n:%p
  HostKeyAlias prod-host-key
  IdentitiesOnly yes
"#,
            ),
        )
        .unwrap();
        let home = dirs::home_dir().unwrap();

        assert_eq!(endpoint.hostname, "prod.internal");
        assert_eq!(
            endpoint.identity_files,
            [home.join(".ssh/deploy@prod.internal-2201-prod")]
        );
        assert_eq!(
            endpoint.certificate_files,
            [home.join(".ssh/prod-cert.pub")]
        );
        assert_eq!(endpoint.proxy_jump.as_deref(), Some("jump-prod:2201"));
        assert_eq!(endpoint.host_key_alias.as_deref(), Some("prod-host-key"));
        assert!(endpoint.identities_only);
    }

    #[test]
    fn expands_includes_in_lexical_order_and_lists_their_hosts() {
        let directory = tempfile::tempdir().unwrap();
        let include_directory = directory.path().join("conf.d");
        fs::create_dir_all(&include_directory).unwrap();
        fs::write(
            directory.path().join("config"),
            "Include conf.d/*.conf\nHost root\n HostName root.internal\n",
        )
        .unwrap();
        fs::write(
            include_directory.join("10-prod.conf"),
            "Host prod\n HostName prod.internal\n User first\n",
        )
        .unwrap();
        fs::write(
            include_directory.join("20-prod.conf"),
            "Host prod\n User second\nHost stage\n HostName stage.internal\n",
        )
        .unwrap();

        let blocks = load(&directory.path().join("config")).unwrap();

        assert_eq!(list_hosts(&blocks), ["prod", "stage", "root"]);
        assert_eq!(
            resolve("prod", &blocks).unwrap().user.as_deref(),
            Some("first")
        );
    }

    #[test]
    fn rejects_include_cycles_with_the_chain_in_the_error() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("config"), "Include child.conf\n").unwrap();
        fs::write(directory.path().join("child.conf"), "Include config\n").unwrap();

        let error = load(&directory.path().join("config")).unwrap_err();

        assert!(error.to_string().contains("循環"));
        assert!(error.to_string().contains("child.conf"));
    }

    #[test]
    fn rejects_a_config_larger_than_the_global_parse_budget() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config");
        let file = fs::File::create(&path).unwrap();
        file.set_len((MAX_CONFIG_BYTES + 1) as u64).unwrap();

        let error = load(&path).unwrap_err();

        assert!(error.to_string().contains(&MAX_CONFIG_BYTES.to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_special_config_files_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("config.fifo");
        let native_path = CString::new(path.as_os_str().as_bytes()).expect("native path");
        // SAFETY: `native_path` is a live, NUL-terminated path and mode has no
        // platform-specific pointer requirements.
        assert_eq!(unsafe { libc::mkfifo(native_path.as_ptr(), 0o600) }, 0);

        let error =
            read_config_file(&path, &mut ParseBudget::default()).expect_err("special config file");
        assert!(error.to_string().contains("通常 file"));
    }

    #[cfg(unix)]
    #[test]
    fn matches_openssh_golden_output_for_supported_options() {
        use std::process::Command;

        if Command::new("ssh").arg("-V").output().is_err() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("config");
        fs::write(
            &path,
            r#"
Host prod
  HostName %h.internal
  User deploy
  Port 2201
  IdentityFile %d/.ssh/id_%r_%h_%p_%n
  CertificateFile %d/.ssh/cert_%n
  HostKeyAlias prod-key
  IdentitiesOnly yes
"#,
        )
        .unwrap();
        let output = Command::new("ssh")
            .args(["-G", "-F"])
            .arg(&path)
            .arg("prod")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let golden: HashMap<_, _> = String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .filter_map(|line| line.split_once(' '))
            .map(|(key, value)| (key.to_owned(), value.to_owned()))
            .collect();
        let endpoint = resolve("prod", &load(&path).unwrap()).unwrap();

        assert_eq!(endpoint.hostname, golden["hostname"]);
        assert_eq!(endpoint.user.as_deref(), Some(golden["user"].as_str()));
        assert_eq!(endpoint.port.to_string(), golden["port"]);
        assert_eq!(
            endpoint.host_key_alias.as_deref(),
            Some(golden["hostkeyalias"].as_str())
        );
        assert_eq!(
            endpoint.identities_only,
            golden["identitiesonly"].eq_ignore_ascii_case("yes")
        );
        // `ssh -G` intentionally leaves path tokens unexpanded; path expansion
        // is covered separately above while scalar resolution is compared here.
        assert_eq!(golden["identityfile"], "%d/.ssh/id_%r_%h_%p_%n");
        assert_eq!(golden["certificatefile"], "%d/.ssh/cert_%n");
    }
}
