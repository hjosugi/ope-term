use std::fs::OpenOptions;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use russh::keys::{Error as KeyError, ssh_key};

const MAX_KNOWN_HOSTS_BYTES: u64 = 16 * 1024 * 1024;
static SAVE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Eq, PartialEq)]
pub enum KnownHostStatus {
    Trusted,
    Unknown,
    Changed { line: usize },
}

pub fn default_path() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join(".ssh").join("known_hosts"))
        .ok_or_else(|| anyhow::anyhow!("ホームディレクトリが見つかりません"))
}

pub fn check(
    path: &Path,
    hostname: &str,
    port: u16,
    key: &ssh_key::PublicKey,
) -> Result<KnownHostStatus> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            bail!("known_hosts は通常 file でなければなりません")
        }
        Ok(metadata) if metadata.len() > MAX_KNOWN_HOSTS_BYTES => {
            bail!("known_hosts は {MAX_KNOWN_HOSTS_BYTES} bytes 以下にしてください")
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("known_hosts を確認できません"),
    }
    match russh::keys::known_hosts::check_known_hosts_path(hostname, port, key, path) {
        Ok(true) => Ok(KnownHostStatus::Trusted),
        Ok(false) => Ok(KnownHostStatus::Unknown),
        Err(KeyError::KeyChanged { line }) => Ok(KnownHostStatus::Changed { line }),
        Err(error) => Err(error).context("known_hosts を検証できません"),
    }
}

pub fn save(path: &Path, hostname: &str, port: u16, key: &ssh_key::PublicKey) -> Result<()> {
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|error| error.into_inner());

    match check(path, hostname, port, key)? {
        KnownHostStatus::Trusted => return Ok(()),
        KnownHostStatus::Changed { line } => {
            bail!("known_hosts {line} 行目に異なるホスト鍵があります")
        }
        KnownHostStatus::Unknown => {}
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("{} を作成できません", parent.display()))?;
    }

    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("{} を開けません", path.display()))?;
    let metadata = file.metadata().context("known_hosts を確認できません")?;
    if !metadata.is_file() {
        bail!("known_hosts は通常 file でなければなりません");
    }
    if metadata.len() > MAX_KNOWN_HOSTS_BYTES {
        bail!("known_hosts は {MAX_KNOWN_HOSTS_BYTES} bytes 以下にしてください");
    }

    let mut prefix = "";
    if file.seek(SeekFrom::End(-1)).is_ok() {
        let mut last = [0_u8; 1];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            prefix = "\n";
        }
    }

    let host = if port == 22 {
        hostname.to_owned()
    } else {
        format!("[{hostname}]:{port}")
    };
    let line = format!("{prefix}{host} {}\n", key.to_openssh()?);
    file.write_all(line.as_bytes())?;
    file.sync_data()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::parse_public_key_base64;

    const KEY_ONE: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ";
    const KEY_TWO: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA6rWI3G1sz07DnfFlrouTcysQlj2P+jpNSOEWD9OJ3X";
    const HASHED_KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";

    #[test]
    fn recognizes_hashed_host() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        std::fs::write(
            &path,
            format!(
                "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {HASHED_KEY}\n"
            ),
        )
        .unwrap();
        let key = parse_public_key_base64(HASHED_KEY).unwrap();

        assert_eq!(
            check(&path, "example.com", 22, &key).unwrap(),
            KnownHostStatus::Trusted
        );
    }

    #[test]
    fn saves_and_recognizes_nonstandard_port_without_breaking_newline() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        std::fs::write(&path, "# existing entry without newline").unwrap();
        let key = parse_public_key_base64(KEY_ONE).unwrap();

        save(&path, "router.internal", 2222, &key).unwrap();

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.starts_with("# existing entry without newline\n"));
        assert!(contents.contains("[router.internal]:2222 ssh-ed25519 "));
        assert!(contents.ends_with('\n'));
        assert_eq!(
            check(&path, "router.internal", 2222, &key).unwrap(),
            KnownHostStatus::Trusted
        );
    }

    #[test]
    fn reports_changed_key_and_refuses_to_overwrite_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("known_hosts");
        let original = parse_public_key_base64(KEY_ONE).unwrap();
        let changed = parse_public_key_base64(KEY_TWO).unwrap();
        save(&path, "server.internal", 22, &original).unwrap();

        assert_eq!(
            check(&path, "server.internal", 22, &changed).unwrap(),
            KnownHostStatus::Changed { line: 1 }
        );
        assert!(save(&path, "server.internal", 22, &changed).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn creates_known_hosts_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(".ssh").join("known_hosts");
        let key = parse_public_key_base64(KEY_ONE).unwrap();

        save(&path, "server.internal", 22, &key).unwrap();

        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn rejects_oversized_and_non_file_known_hosts() {
        let directory = tempfile::tempdir().expect("directory");
        let key = parse_public_key_base64(KEY_ONE).expect("key");
        let oversized = directory.path().join("oversized");
        let file = std::fs::File::create(&oversized).expect("file");
        file.set_len(MAX_KNOWN_HOSTS_BYTES + 1)
            .expect("sparse file");
        assert!(check(&oversized, "example.com", 22, &key).is_err());
        assert!(check(directory.path(), "example.com", 22, &key).is_err());
    }

    #[test]
    fn serializes_concurrent_saves_without_losing_entries() {
        use std::sync::{Arc, Barrier};

        let directory = tempfile::tempdir().expect("directory");
        let path = Arc::new(directory.path().join("known_hosts"));
        let barrier = Arc::new(Barrier::new(16));
        let handles = (0..16)
            .map(|index| {
                let path = Arc::clone(&path);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let key = parse_public_key_base64(KEY_ONE).expect("key");
                    barrier.wait();
                    save(&path, &format!("server-{index}.internal"), 22, &key)
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            handle.join().expect("thread").expect("save");
        }

        let contents = std::fs::read_to_string(path.as_ref()).expect("known_hosts");
        assert_eq!(contents.lines().count(), 16);
        for index in 0..16 {
            assert!(contents.contains(&format!("server-{index}.internal ssh-ed25519 ")));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_known_hosts_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("directory");
        let target = directory.path().join("target");
        let link = directory.path().join("known_hosts");
        std::fs::write(&target, "sentinel\n").expect("target");
        symlink(&target, &link).expect("symlink");
        let key = parse_public_key_base64(KEY_ONE).expect("key");

        assert!(check(&link, "example.com", 22, &key).is_err());
        assert!(save(&link, "example.com", 22, &key).is_err());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "sentinel\n");
    }
}
