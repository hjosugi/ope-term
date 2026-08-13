use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, anyhow, bail};
use serde::Serialize;
use tokio::fs;
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_SCOPES: usize = 64;
const MAX_LIST_ENTRIES: usize = 10_000;
const MAX_RELATIVE_PATH_BYTES: usize = 32 * 1024;
const SCOPE_TOKEN_BYTES: usize = 32;

pub type LocalScopes = Arc<Mutex<VecDeque<(String, PathBuf)>>>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedDirectory {
    pub token: String,
    pub display_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_unix: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub relative_path: String,
    pub entries: Vec<LocalEntry>,
}

pub async fn register(scopes: &LocalScopes, path: PathBuf) -> Result<SelectedDirectory> {
    let canonical = fs::canonicalize(&path)
        .await
        .with_context(|| format!("{} を解決できません", path.display()))?;
    if !fs::metadata(&canonical).await?.is_dir() {
        bail!("選択された path は directory ではありません");
    }
    let token = Uuid::new_v4().simple().to_string();
    let selected = SelectedDirectory {
        token: token.clone(),
        display_path: canonical.display().to_string(),
    };
    let mut registry = scopes.lock().await;
    while registry.len() >= MAX_SCOPES {
        registry.pop_front();
    }
    registry.push_back((token, canonical));
    Ok(selected)
}

pub async fn list(scopes: &LocalScopes, token: &str, relative_path: &str) -> Result<LocalListing> {
    let (root, relative, directory) = scoped_path(scopes, token, relative_path).await?;
    let canonical = fs::canonicalize(&directory)
        .await
        .context("local directory を解決できません")?;
    ensure_below(&root, &canonical)?;
    if !fs::metadata(&canonical).await?.is_dir() {
        bail!("local path は directory ではありません");
    }

    let mut reader = fs::read_dir(&canonical)
        .await
        .context("local directory を一覧できません")?;
    let mut entries = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        if entries.len() >= MAX_LIST_ENTRIES {
            bail!("local directory は {MAX_LIST_ENTRIES} entries を超えているため表示できません");
        }
        let metadata = fs::symlink_metadata(entry.path()).await?;
        let file_type = metadata.file_type();
        entries.push(LocalEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind: if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_dir() {
                "directory"
            } else if file_type.is_file() {
                "file"
            } else {
                "other"
            },
            size: metadata.len(),
            modified_unix: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        });
    }
    entries.sort_by(|left, right| {
        entry_rank(left.kind)
            .cmp(&entry_rank(right.kind))
            .then_with(|| crate::name_sort::case_insensitive(&left.name, &right.name))
    });
    Ok(LocalListing {
        relative_path: display_relative(&relative),
        entries,
    })
}

pub async fn resolve(
    scopes: &LocalScopes,
    token: &str,
    relative_path: &str,
    must_exist: bool,
) -> Result<PathBuf> {
    let (root, _, target) = scoped_path(scopes, token, relative_path).await?;
    if must_exist {
        let metadata = fs::symlink_metadata(&target)
            .await
            .context("local upload 元を確認できません")?;
        if metadata.file_type().is_symlink() {
            bail!("local symlink は転送できません");
        }
        let canonical = fs::canonicalize(&target)
            .await
            .context("local upload 元を解決できません")?;
        ensure_below(&root, &canonical)?;
        return Ok(canonical);
    }

    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("download 先の親 directory がありません"))?;
    let canonical_parent = fs::canonicalize(parent)
        .await
        .context("download 先の親 directory を解決できません")?;
    ensure_below(&root, &canonical_parent)?;
    let name = target
        .file_name()
        .ok_or_else(|| anyhow!("download 先の file 名がありません"))?;
    Ok(canonical_parent.join(name))
}

pub async fn resolve_directory(scopes: &LocalScopes, token: &str) -> Result<PathBuf> {
    validate_token(token)?;
    let root = scopes
        .lock()
        .await
        .iter()
        .find(|(candidate, _)| candidate == token)
        .map(|(_, path)| path.clone())
        .ok_or_else(|| anyhow!("working directory の許可が期限切れです。選択し直してください"))?;
    let canonical = fs::canonicalize(&root)
        .await
        .context("working directory を解決できません")?;
    ensure_below(&root, &canonical)?;
    if !fs::metadata(&canonical).await?.is_dir() {
        bail!("working directory は directory ではありません");
    }
    Ok(canonical)
}

async fn scoped_path(
    scopes: &LocalScopes,
    token: &str,
    raw_relative: &str,
) -> Result<(PathBuf, PathBuf, PathBuf)> {
    validate_token(token)?;
    let root = scopes
        .lock()
        .await
        .iter()
        .find(|(candidate, _)| candidate == token)
        .map(|(_, path)| path.clone())
        .ok_or_else(|| anyhow!("local directory の許可が期限切れです。選択し直してください"))?;
    let relative = safe_relative(raw_relative)?;
    let target = root.join(&relative);
    Ok((root, relative, target))
}

fn validate_token(token: &str) -> Result<()> {
    if token.len() != SCOPE_TOKEN_BYTES
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("local directory token が不正です");
    }
    Ok(())
}

fn safe_relative(raw: &str) -> Result<PathBuf> {
    if raw.len() > MAX_RELATIVE_PATH_BYTES {
        bail!("local relative path は {MAX_RELATIVE_PATH_BYTES} bytes 以下にしてください");
    }
    if raw.contains('\0') {
        bail!("local relative path に NUL は使えません");
    }
    let mut relative = PathBuf::new();
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("local directory の外には移動できません")
            }
        }
    }
    Ok(relative)
}

fn ensure_below(root: &Path, candidate: &Path) -> Result<()> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        bail!("local directory の外には移動できません")
    }
}

fn display_relative(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".to_owned()
    } else {
        path.to_string_lossy().into_owned()
    }
}

fn entry_rank(kind: &str) -> u8 {
    match kind {
        "directory" => 0,
        "file" => 1,
        "symlink" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(safe_relative("../secret").is_err());
        assert!(safe_relative("/etc/passwd").is_err());
        assert!(safe_relative(&"a".repeat(MAX_RELATIVE_PATH_BYTES + 1)).is_err());
        assert!(safe_relative("safe/child").is_ok());
    }

    #[test]
    fn accepts_only_generated_scope_tokens() {
        assert!(validate_token("a2d41d7011c04ddba2d15d692fe5835d").is_ok());
        for invalid in [
            "",
            "A2D41D7011C04DDBA2D15D692FE5835D",
            "a2d41d70-11c0-4ddb-a2d1-5d692fe5835d",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            assert!(validate_token(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[tokio::test]
    async fn scopes_listing_and_transfer_paths_to_the_selected_root() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::create_dir(root.path().join("directory")).expect("directory");
        std::fs::write(root.path().join("file.txt"), b"safe").expect("file");
        let scopes = LocalScopes::default();
        let selected = register(&scopes, root.path().to_path_buf())
            .await
            .expect("register");

        let listing = list(&scopes, &selected.token, ".").await.expect("list");
        assert_eq!(listing.relative_path, ".");
        assert_eq!(listing.entries[0].name, "directory");
        assert_eq!(listing.entries[1].name, "file.txt");
        assert!(
            resolve(&scopes, &selected.token, "file.txt", true)
                .await
                .is_ok()
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), root.path().join("escape"))
                .expect("symlink");
            assert!(
                resolve(&scopes, &selected.token, "escape/new.txt", false)
                    .await
                    .is_err()
            );
        }
    }
}
