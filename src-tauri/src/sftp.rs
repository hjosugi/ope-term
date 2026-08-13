use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result, anyhow, bail};
use russh_sftp::client::SftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const MAX_REMOTE_NAME_BYTES: usize = 4 * 1024;
const MAX_TRANSFER_ID_BYTES: usize = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub permissions: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_unix: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListing {
    pub canonical_path: String,
    pub entries: Vec<SftpEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferInput {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub local_token: String,
    pub local_relative_path: String,
    pub remote_directory: String,
    pub remote_name: String,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default)]
    pub follow_symlink: bool,
}

#[derive(Debug, Clone)]
pub struct SftpTransferRequest {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub local_path: PathBuf,
    pub remote_directory: String,
    pub remote_name: String,
    pub overwrite: bool,
    pub follow_symlink: bool,
}

impl SftpTransferInput {
    pub fn resolve(self, local_path: PathBuf) -> SftpTransferRequest {
        SftpTransferRequest {
            transfer_id: self.transfer_id,
            direction: self.direction,
            local_path,
            remote_directory: self.remote_directory,
            remote_name: self.remote_name,
            overwrite: self.overwrite,
            follow_symlink: self.follow_symlink,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpProgress {
    pub transfer_id: String,
    pub status: &'static str,
    pub transferred: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferResult {
    pub transfer_id: String,
    pub transferred: u64,
}

pub async fn list(session: &SftpSession, path: &str) -> Result<SftpListing> {
    reject_nul(path)?;
    let canonical_path = session
        .canonicalize(if path.trim().is_empty() { "." } else { path })
        .await
        .context("remote path を解決できません")?;
    let mut entries = session
        .read_dir(canonical_path.clone())
        .await
        .context("remote directory を一覧できません")?
        .map(|entry| {
            let metadata = entry.metadata();
            let file_type = metadata.file_type();
            SftpEntry {
                name: entry.file_name(),
                kind: file_type_name(file_type),
                size: metadata.len(),
                permissions: metadata.permissions().to_string(),
                modified_unix: metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs()),
            }
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| {
        entry_rank(left.kind)
            .cmp(&entry_rank(right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(SftpListing {
        canonical_path,
        entries,
    })
}

pub async fn transfer(
    session: Arc<SftpSession>,
    request: SftpTransferRequest,
    progress: Channel<SftpProgress>,
    cancelled: Arc<AtomicBool>,
) -> Result<SftpTransferResult> {
    validate_transfer_id(&request.transfer_id)?;
    validate_remote_name(&request.remote_name)?;
    reject_nul(&request.remote_directory)?;
    emit(&progress, &request.transfer_id, "running", 0, 0);
    let result = match request.direction {
        TransferDirection::Upload => upload(&session, &request, &progress, &cancelled).await,
        TransferDirection::Download => download(&session, &request, &progress, &cancelled).await,
    };
    match result {
        Ok(transferred) => {
            emit(
                &progress,
                &request.transfer_id,
                "completed",
                transferred,
                transferred,
            );
            Ok(SftpTransferResult {
                transfer_id: request.transfer_id,
                transferred,
            })
        }
        Err(error) if cancelled.load(Ordering::Relaxed) => {
            emit(&progress, &request.transfer_id, "cancelled", 0, 0);
            Err(anyhow!("転送をキャンセルしました: {error:#}"))
        }
        Err(error) => {
            emit(&progress, &request.transfer_id, "failed", 0, 0);
            Err(error)
        }
    }
}

async fn upload(
    session: &SftpSession,
    request: &SftpTransferRequest,
    progress: &Channel<SftpProgress>,
    cancelled: &AtomicBool,
) -> Result<u64> {
    let local_path = request.local_path.clone();
    let local_metadata = fs::symlink_metadata(&local_path)
        .await
        .context("upload 元を確認できません")?;
    if local_metadata.file_type().is_symlink() {
        bail!("symlink は upload できません。実体の file を選択してください");
    }
    if !local_metadata.is_file() {
        bail!("upload 元は通常 file ではありません");
    }

    let directory = canonical_remote_directory(session, &request.remote_directory).await?;
    let target = join_remote(&directory, &request.remote_name);
    let existing = remote_lstat(session, &target).await?;
    if let Some(metadata) = &existing {
        if metadata.file_type().is_symlink() {
            bail!("symlink の上書きは拒否しました");
        }
        if metadata.file_type() != FileType::File {
            bail!("通常 file 以外は上書きできません");
        }
        if !request.overwrite {
            bail!("remote file は既に存在します。上書き確認が必要です");
        }
    }

    let temporary = join_remote(
        &directory,
        &format!(".ope-term-upload-{}.part", request.transfer_id),
    );
    if remote_lstat(session, &temporary).await?.is_some() {
        bail!("upload 用の一時 file が既に存在します");
    }
    let attributes = existing
        .as_ref()
        .map(|metadata| FileAttributes {
            permissions: metadata.permissions,
            ..FileAttributes::empty()
        })
        .unwrap_or_else(FileAttributes::empty);
    let mut remote = session
        .open_with_flags_and_attributes(
            temporary.clone(),
            OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
            attributes,
        )
        .await
        .context("remote の一時 file を作成できません")?;
    let mut local = fs::File::open(&local_path).await?;
    let total = local_metadata.len();
    let mut transferred = 0_u64;
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    let copy_result: Result<()> = async {
        loop {
            ensure_not_cancelled(cancelled)?;
            let read = local.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            remote.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            emit(
                progress,
                &request.transfer_id,
                "running",
                transferred,
                total,
            );
        }
        remote.close().await?;
        Ok(())
    }
    .await;
    if let Err(error) = copy_result {
        let _ = session.remove_file(&temporary).await;
        return Err(error.context("upload に失敗しました"));
    }

    replace_remote_file(
        session,
        &temporary,
        &target,
        existing.is_some(),
        &request.transfer_id,
    )
    .await?;
    Ok(transferred)
}

async fn download(
    session: &SftpSession,
    request: &SftpTransferRequest,
    progress: &Channel<SftpProgress>,
    cancelled: &AtomicBool,
) -> Result<u64> {
    let directory = canonical_remote_directory(session, &request.remote_directory).await?;
    let requested_path = join_remote(&directory, &request.remote_name);
    let link_metadata = remote_lstat(session, &requested_path)
        .await?
        .ok_or_else(|| anyhow!("remote file が見つかりません"))?;
    let remote_path = if link_metadata.file_type().is_symlink() {
        if !request.follow_symlink {
            bail!("symlink の download には明示的な確認が必要です");
        }
        session
            .canonicalize(&requested_path)
            .await
            .context("symlink の実体を解決できません")?
    } else {
        requested_path
    };
    let metadata = session
        .metadata(&remote_path)
        .await
        .context("remote file を確認できません")?;
    if metadata.file_type() != FileType::File {
        bail!("download 元は通常 file ではありません");
    }

    let target = request.local_path.clone();
    let existing = local_lstat(&target).await?;
    if let Some(metadata) = &existing {
        if metadata.file_type().is_symlink() {
            bail!("local symlink の上書きは拒否しました");
        }
        if !metadata.is_file() {
            bail!("通常 file 以外は上書きできません");
        }
        if !request.overwrite {
            bail!("local file は既に存在します。上書き確認が必要です");
        }
    }
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .ok_or_else(|| anyhow!("download 先の親 directory がありません"))?;
    let temporary = parent.join(format!(".ope-term-download-{}.part", request.transfer_id));
    let mut local = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .await
        .context("download 用の一時 file を作成できません")?;
    let mut remote = session.open(&remote_path).await?;
    let total = metadata.len();
    let mut transferred = 0_u64;
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    let copy_result: Result<()> = async {
        loop {
            ensure_not_cancelled(cancelled)?;
            let read = remote.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            local.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            emit(
                progress,
                &request.transfer_id,
                "running",
                transferred,
                total,
            );
        }
        local.sync_all().await?;
        Ok(())
    }
    .await;
    if let Err(error) = copy_result {
        drop(local);
        let _ = fs::remove_file(&temporary).await;
        return Err(error.context("download に失敗しました"));
    }
    drop(local);
    replace_local_file(
        &temporary,
        &target,
        existing.is_some(),
        &request.transfer_id,
    )
    .await?;
    Ok(transferred)
}

async fn canonical_remote_directory(session: &SftpSession, path: &str) -> Result<String> {
    session
        .canonicalize(if path.trim().is_empty() { "." } else { path })
        .await
        .context("remote directory を解決できません")
}

async fn remote_lstat(session: &SftpSession, path: &str) -> Result<Option<FileAttributes>> {
    match session.symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => Ok(None),
        Err(error) => Err(error).context("remote path を確認できません"),
    }
}

async fn local_lstat(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).context("local path を確認できません"),
    }
}

async fn replace_remote_file(
    session: &SftpSession,
    temporary: &str,
    target: &str,
    target_exists: bool,
    transfer_id: &str,
) -> Result<()> {
    if !target_exists {
        return match session.rename(temporary, target).await {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = session.remove_file(temporary).await;
                Err(error).context("upload の一時 file を確定できません")
            }
        };
    }
    let backup = format!("{target}.ope-term-backup-{transfer_id}");
    if remote_lstat(session, &backup).await?.is_some() {
        let _ = session.remove_file(temporary).await;
        bail!("remote backup file が既に存在します");
    }
    if let Err(error) = session.rename(target, &backup).await {
        let _ = session.remove_file(temporary).await;
        return Err(error).context("上書き前の remote file を退避できません");
    }
    if let Err(error) = session.rename(temporary, target).await {
        let _ = session.remove_file(temporary).await;
        if let Err(restore_error) = session.rename(&backup, target).await {
            bail!(
                "upload file を配置できず（{error}）、元の file の復元にも失敗しました（{restore_error}）。backup は {backup} に残っています"
            );
        }
        return Err(error).context("upload file を配置できず、元の file を復元しました");
    }
    session
        .remove_file(&backup)
        .await
        .context("upload は完了しましたが remote backup を削除できません")
}

async fn replace_local_file(
    temporary: &Path,
    target: &Path,
    target_exists: bool,
    transfer_id: &str,
) -> Result<()> {
    if !target_exists {
        return match fs::rename(temporary, target).await {
            Ok(()) => Ok(()),
            Err(error) => {
                let _ = fs::remove_file(temporary).await;
                Err(error).context("download の一時 file を確定できません")
            }
        };
    }
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("download 先 file name を扱えません"))?;
    let backup = target.with_file_name(format!("{file_name}.ope-term-backup-{transfer_id}"));
    if local_lstat(&backup).await?.is_some() {
        let _ = fs::remove_file(temporary).await;
        bail!("local backup file が既に存在します");
    }
    if let Err(error) = fs::rename(target, &backup).await {
        let _ = fs::remove_file(temporary).await;
        return Err(error).context("上書き前の local file を退避できません");
    }
    if let Err(error) = fs::rename(temporary, target).await {
        let _ = fs::remove_file(temporary).await;
        if let Err(restore_error) = fs::rename(&backup, target).await {
            bail!(
                "download file を配置できず（{error}）、元の file の復元にも失敗しました（{restore_error}）。backup は {} に残っています",
                backup.display()
            );
        }
        return Err(error).context("download file を配置できず、元の file を復元しました");
    }
    fs::remove_file(&backup)
        .await
        .context("download は完了しましたが local backup を削除できません")
}

fn validate_remote_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > MAX_REMOTE_NAME_BYTES
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        bail!("安全でない remote file name です");
    }
    Ok(())
}

fn validate_transfer_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > MAX_TRANSFER_ID_BYTES
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("安全でない transfer id です");
    }
    Ok(())
}

fn reject_nul(value: &str) -> Result<()> {
    if value.contains('\0') {
        bail!("path に NUL は使用できません");
    }
    Ok(())
}

fn join_remote(directory: &str, name: &str) -> String {
    if directory == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", directory.trim_end_matches('/'))
    }
}

fn ensure_not_cancelled(cancelled: &AtomicBool) -> Result<()> {
    if cancelled.load(Ordering::Relaxed) {
        bail!("cancelled");
    }
    Ok(())
}

fn emit(
    channel: &Channel<SftpProgress>,
    transfer_id: &str,
    status: &'static str,
    transferred: u64,
    total: u64,
) {
    let _ = channel.send(SftpProgress {
        transfer_id: transfer_id.to_owned(),
        status,
        transferred,
        total,
    });
}

fn file_type_name(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Dir => "directory",
        FileType::File => "file",
        FileType::Symlink => "symlink",
        FileType::Other => "other",
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
    fn remote_names_cannot_escape_the_selected_directory() {
        for invalid in ["", ".", "..", "../secret", "a/b", "a\\b", "nul\0name"] {
            assert!(
                validate_remote_name(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
        assert!(validate_remote_name("report 2026.txt").is_ok());
    }

    #[test]
    fn transfer_ids_are_safe_for_temporary_file_names() {
        assert!(validate_transfer_id("a2d41d70-11c0-4ddb-a2d1-5d692fe5835d").is_ok());
        assert!(validate_transfer_id("../../escape").is_err());
        assert!(validate_transfer_id(&"x".repeat(MAX_TRANSFER_ID_BYTES + 1)).is_err());
    }

    #[test]
    fn remote_join_preserves_root_and_removes_duplicate_separator() {
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/home/me/", "a"), "/home/me/a");
    }

    #[tokio::test]
    async fn failed_local_replace_restores_the_original_file() {
        let directory = tempfile::tempdir().expect("directory");
        let target = directory.path().join("target.txt");
        let missing_temporary = directory.path().join("missing.part");
        fs::write(&target, b"original").await.expect("original");

        assert!(
            replace_local_file(&missing_temporary, &target, true, "safe-id")
                .await
                .is_err()
        );
        assert_eq!(fs::read(&target).await.expect("restored"), b"original");
        assert!(
            local_lstat(&directory.path().join("target.txt.ope-term-backup-safe-id"))
                .await
                .expect("backup metadata")
                .is_none()
        );
    }

    #[tokio::test]
    async fn backup_collision_removes_the_download_temporary_file() {
        let directory = tempfile::tempdir().expect("directory");
        let target = directory.path().join("target.txt");
        let temporary = directory.path().join("download.part");
        let backup = directory.path().join("target.txt.ope-term-backup-safe-id");
        fs::write(&target, b"original").await.expect("original");
        fs::write(&temporary, b"replacement")
            .await
            .expect("temporary");
        fs::write(&backup, b"existing backup")
            .await
            .expect("backup");

        let error = replace_local_file(&temporary, &target, true, "safe-id")
            .await
            .expect_err("backup collision");
        assert!(error.to_string().contains("backup file"));
        assert_eq!(fs::read(&target).await.expect("target"), b"original");
        assert_eq!(fs::read(&backup).await.expect("backup"), b"existing backup");
        assert!(local_lstat(&temporary).await.expect("temporary").is_none());
    }
}
