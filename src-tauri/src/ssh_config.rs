use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;

const MULTI_VALUE_KEYS: &[&str] = &[
    "identityfile",
    "localforward",
    "remoteforward",
    "dynamicforward",
    "sendenv",
];

#[derive(Debug, Clone, Default)]
pub struct Block {
    patterns: Vec<String>,
    options: HashMap<String, Vec<String>>,
    implicit: bool,
    skipped: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: u16,
    pub identity_files: Vec<PathBuf>,
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
    let text = fs::read_to_string(&path)
        .with_context(|| format!("{} を読み込めません", path.display()))?;
    Ok(parse(&text))
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

pub fn parse(text: &str) -> Vec<Block> {
    let mut blocks = vec![Block {
        patterns: vec!["*".into()],
        implicit: true,
        ..Default::default()
    }];

    for raw in text.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let normalized = normalize_equals(trimmed);
        let tokens = tokenize(&normalized);
        let Some(key) = tokens.first().map(|value| value.to_ascii_lowercase()) else {
            continue;
        };
        let values = &tokens[1..];

        if key == "host" {
            blocks.push(Block {
                patterns: values.to_vec(),
                ..Default::default()
            });
            continue;
        }
        if key == "match" {
            blocks.push(Block {
                skipped: true,
                ..Default::default()
            });
            continue;
        }

        let current = blocks.last_mut().expect("implicit block always exists");
        if current.skipped {
            continue;
        }
        let value = values.join(" ");
        if MULTI_VALUE_KEYS.contains(&key.as_str()) {
            current.options.entry(key).or_default().push(value);
        } else {
            current.options.entry(key).or_insert_with(|| vec![value]);
        }
    }
    blocks
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
    fn walk(pattern: &[u8], value: &[u8]) -> bool {
        match pattern.split_first() {
            None => value.is_empty(),
            Some((&b'*', rest)) => {
                walk(rest, value) || (!value.is_empty() && walk(pattern, &value[1..]))
            }
            Some((&b'?', rest)) => !value.is_empty() && walk(rest, &value[1..]),
            Some((&literal, rest)) => value.first() == Some(&literal) && walk(rest, &value[1..]),
        }
    }
    walk(pattern.as_bytes(), value.as_bytes())
}

fn block_matches(alias: &str, patterns: &[String]) -> bool {
    let mut matched = false;
    for pattern in patterns {
        if let Some(negative) = pattern.strip_prefix('!') {
            if glob_matches(negative, alias) {
                return false;
            }
        } else if glob_matches(pattern, alias) {
            matched = true;
        }
    }
    matched
}

pub fn resolve(alias: &str, blocks: &[Block]) -> Result<Endpoint> {
    let mut values: HashMap<String, Vec<String>> = HashMap::new();
    for block in blocks {
        if block.skipped || !block_matches(alias, &block.patterns) {
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

    let parsed = parse_jump_spec(alias);
    let canonical_alias = parsed.alias;
    let hostname = first(&values, "hostname").unwrap_or_else(|| canonical_alias.clone());
    let port = parsed
        .port
        .or_else(|| first(&values, "port").and_then(|value| value.parse().ok()))
        .unwrap_or(22);
    let home = dirs::home_dir();
    let identity_files = values
        .remove("identityfile")
        .unwrap_or_default()
        .into_iter()
        .map(|value| expand_home(&value, home.as_deref()))
        .collect();

    Ok(Endpoint {
        alias: canonical_alias,
        hostname,
        user: parsed.user.or_else(|| first(&values, "user")),
        port,
        identity_files,
        proxy_jump: first(&values, "proxyjump").filter(|value| !value.eq_ignore_ascii_case("none")),
    })
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
        if block.implicit || block.skipped {
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
    if route.len() > 1 {
        return route.iter().map(|alias| resolve(alias, blocks)).collect();
    }

    let mut chain = Vec::new();
    let mut stack = Vec::new();
    expand_chain(&route[0], blocks, &mut stack, &mut chain)?;
    Ok(chain)
}

fn expand_chain(
    alias: &str,
    blocks: &[Block],
    stack: &mut Vec<String>,
    output: &mut Vec<Endpoint>,
) -> Result<()> {
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
            expand_chain(jump, blocks, stack, output)?;
        }
    }
    stack.pop();
    output.push(endpoint);
    Ok(())
}

pub fn profiles(blocks: &[Block]) -> Vec<HostProfile> {
    list_hosts(blocks)
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
        .collect()
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
    fn uses_first_obtained_scalar_and_accumulates_identity_files() {
        let resolved = resolve("prod-db", &parse(CONFIG)).unwrap();
        assert_eq!(resolved.user.as_deref(), Some("admin"));
        assert_eq!(resolved.identity_files.len(), 2);
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
    fn handles_quotes_comments_and_negation() {
        assert_eq!(
            tokenize("IdentityFile \"~/my keys/id\" # note"),
            ["IdentityFile", "~/my keys/id"]
        );
        assert!(resolve("secret-a", &parse(CONFIG)).unwrap().user.is_none());
    }

    #[test]
    fn parses_jump_user_and_port_override() {
        let endpoint = resolve("alice@bastion:2200", &parse(CONFIG)).unwrap();
        assert_eq!(endpoint.alias, "bastion");
        assert_eq!(endpoint.user.as_deref(), Some("alice"));
        assert_eq!(endpoint.port, 2200);
    }
}
