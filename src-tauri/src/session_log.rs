use std::borrow::Cow;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::sync::{mpsc, oneshot};

const LOG_QUEUE_CAPACITY: usize = 64;
const MAX_TEMPLATE_BYTES: usize = 160;
const MAX_QUERY_BYTES: usize = 256;
const MAX_LINE_BYTES: usize = 4 * 1024;
const MAX_RESULTS: usize = 500;
const MAX_LOG_DIRECTORY_ENTRIES: usize = 10_000;
const MIN_ROTATION_BYTES: u64 = 1024 * 1024;
const MAX_ROTATION_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RETAINED_FILES: u8 = 20;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogInput {
    pub enabled: bool,
    pub directory_token: Option<String>,
    pub file_name_template: String,
    pub timestamps: bool,
    pub rotation_bytes: u64,
    pub retained_files: u8,
}

#[derive(Debug, Clone)]
pub struct LogConfig {
    directory: PathBuf,
    file_name: String,
    timestamps: bool,
    rotation_bytes: u64,
    retained_files: u8,
}

#[derive(Debug, Clone)]
pub struct LogSink {
    sender: mpsc::Sender<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFile {
    pub name: String,
    pub size: u64,
    pub modified_unix: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SearchMode {
    Fuzzy,
    Exact,
    Regex,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogMatch {
    pub line: u64,
    pub text: String,
}

/// Where a search page stopped: the byte offset of the next unread line and
/// that line's 1-based number, so paging never rescans from the start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCursor {
    pub offset: u64,
    pub line: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchPage {
    pub matches: Vec<LogMatch>,
    /// Present only when the page filled up before the end of the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next: Option<LogCursor>,
}

pub fn configure(input: LogInput, directory: PathBuf, host: &str, user: &str) -> Result<LogConfig> {
    if !input.enabled {
        bail!("disabled log configuration must not be resolved");
    }
    if input.file_name_template.is_empty() || input.file_name_template.len() > MAX_TEMPLATE_BYTES {
        bail!("log file template は 1..={MAX_TEMPLATE_BYTES} bytes にしてください");
    }
    let now = OffsetDateTime::now_utc();
    let date = format!(
        "{:04}-{:02}-{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    );
    let time = format!("{:02}-{:02}-{:02}Z", now.hour(), now.minute(), now.second());
    let mut file_name = input.file_name_template;
    for (variable, value) in [
        ("{host}", safe_value(host)),
        ("{user}", safe_value(user)),
        ("{date}", date),
        ("{time}", time),
    ] {
        file_name = file_name.replace(variable, &value);
    }
    if file_name.contains('{') || file_name.contains('}') {
        bail!("未対応の log file 変数があります");
    }
    validate_file_name(&file_name)?;
    if !file_name.ends_with(".log") {
        bail!("log file template は .log で終えてください");
    }
    Ok(LogConfig {
        directory,
        file_name,
        timestamps: input.timestamps,
        rotation_bytes: input
            .rotation_bytes
            .clamp(MIN_ROTATION_BYTES, MAX_ROTATION_BYTES),
        retained_files: input.retained_files.clamp(1, MAX_RETAINED_FILES),
    })
}

pub async fn start(config: LogConfig) -> Result<LogSink> {
    let (sender, receiver) = mpsc::channel(LOG_QUEUE_CAPACITY);
    let (ready_sender, ready_receiver) = oneshot::channel();
    std::thread::Builder::new()
        .name("ope-term-session-log".to_owned())
        .spawn(move || {
            if let Err(error) = write_loop(config, receiver, ready_sender) {
                eprintln!("ope-term session logger stopped: {error:#}");
            }
        })
        .context("session log writer を開始できません")?;
    ready_receiver
        .await
        .context("session log writer が準備前に終了しました")?
        .map_err(anyhow::Error::msg)?;
    Ok(LogSink { sender })
}

impl LogSink {
    pub async fn write(&self, bytes: &[u8]) -> Result<()> {
        self.sender
            .send(bytes.to_vec())
            .await
            .map_err(|_| anyhow!("session log writer は終了しています"))
    }

    pub fn blocking_write(&self, bytes: &[u8]) -> Result<()> {
        self.sender
            .blocking_send(bytes.to_vec())
            .map_err(|_| anyhow!("session log writer は終了しています"))
    }
}

fn write_loop(
    config: LogConfig,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    ready: oneshot::Sender<std::result::Result<(), String>>,
) -> Result<()> {
    let path = config.directory.join(&config.file_name);
    let initialized = (|| -> Result<(File, u64)> {
        fs::create_dir_all(&config.directory).context("log directory を作成できません")?;
        let mut file = open_log(&path)?;
        let mut size = file.metadata()?.len();
        if size > 0 {
            file.write_all(b"\n")?;
            size += 1;
        }
        Ok((file, size))
    })();
    let (mut file, mut size) = match initialized {
        Ok(state) => state,
        Err(error) => {
            let _ = ready.send(Err(format!("{error:#}")));
            return Err(error);
        }
    };
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }
    let mut line_start = true;
    while let Some(bytes) = receiver.blocking_recv() {
        let line_start_before = line_start;
        let mut encoded: Cow<'_, [u8]> = if config.timestamps {
            Cow::Owned(timestamp_lines(&bytes, &mut line_start))
        } else {
            Cow::Borrowed(&bytes)
        };
        if size > 0 && size.saturating_add(encoded.len() as u64) > config.rotation_bytes {
            drop(file);
            rotate(&path, config.retained_files)?;
            file = open_log(&path)?;
            size = 0;
            // Re-stamp the chunk for the fresh file: its first line always
            // carries a timestamp, and `line_start` keeps the state after this
            // chunk instead of being reset to "start of line" mid-line.
            if config.timestamps && !line_start_before {
                line_start = true;
                encoded = Cow::Owned(timestamp_lines(&bytes, &mut line_start));
            }
        }
        file.write_all(&encoded)?;
        file.flush()?;
        size = size.saturating_add(encoded.len() as u64);
    }
    file.sync_all()?;
    Ok(())
}

fn timestamp_lines(bytes: &[u8], line_start: &mut bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len() + 40);
    for byte in bytes {
        if *line_start {
            let stamp = OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .unwrap_or_else(|_| "unknown-time".to_owned());
            output.extend_from_slice(format!("[{stamp}] ").as_bytes());
            *line_start = false;
        }
        output.push(*byte);
        if *byte == b'\n' {
            *line_start = true;
        }
    }
    output
}

fn open_log(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // O_NOFOLLOW closes the check/open race for a hostile same-name
        // symlink. O_NONBLOCK lets us reject FIFOs without hanging the writer.
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .with_context(|| format!("{} を開けません", path.display()))?;
    if !file.metadata()?.is_file() {
        bail!("session log は通常 file でなければなりません");
    }
    Ok(file)
}

fn open_log_for_read(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .with_context(|| format!("{} を開けません", path.display()))?;
    if !file.metadata()?.is_file() {
        bail!("通常 file 以外は検索できません");
    }
    Ok(file)
}

fn rotate(path: &Path, retained: u8) -> Result<()> {
    let oldest = rotated_path(path, retained);
    match fs::remove_file(&oldest) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("古い log を削除できません"),
    }
    for generation in (1..retained).rev() {
        let source = rotated_path(path, generation);
        let target = rotated_path(path, generation + 1);
        match fs::rename(&source, &target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("log generation を移動できません"),
        }
    }
    fs::rename(path, rotated_path(path, 1)).context("active log を rotate できません")
}

fn rotated_path(path: &Path, generation: u8) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!("{name}.{generation}"))
}

pub fn list(directory: &Path) -> Result<Vec<LogFile>> {
    let mut logs = Vec::new();
    for (scanned, entry) in fs::read_dir(directory)
        .context("log directory を一覧できません")?
        .enumerate()
    {
        if scanned >= MAX_LOG_DIRECTORY_ENTRIES {
            bail!(
                "log directory は {MAX_LOG_DIRECTORY_ENTRIES} entries を超えているため表示できません"
            );
        }
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !metadata.is_file() || metadata.file_type().is_symlink() || !is_log_file_name(&name) {
            continue;
        }
        logs.push(LogFile {
            name,
            size: metadata.len(),
            modified_unix: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs()),
        });
    }
    logs.sort_by_key(|entry| std::cmp::Reverse(entry.modified_unix));
    Ok(logs)
}

pub fn search(
    directory: &Path,
    name: &str,
    query: &str,
    mode: SearchMode,
    cursor: Option<LogCursor>,
) -> Result<LogSearchPage> {
    validate_file_name(name)?;
    if !is_log_file_name(name) {
        bail!(".log file とその rotation 世代だけを検索できます");
    }
    if query.len() > MAX_QUERY_BYTES {
        bail!("検索 query は {MAX_QUERY_BYTES} bytes 以下にしてください");
    }
    let path = directory.join(name);
    let metadata = fs::symlink_metadata(&path).context("log file を確認できません")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("通常 file 以外は検索できません");
    }
    let regex = match mode {
        SearchMode::Regex => Some(Regex::new(query).context("正規表現が不正です")?),
        _ => None,
    };
    let mut file = open_log_for_read(&path)?;
    let start = cursor.unwrap_or(LogCursor { offset: 0, line: 1 });
    validate_cursor(&mut file, start)?;
    file.seek(SeekFrom::Start(start.offset))
        .context("log file の検索位置へ移動できません")?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut results = Vec::new();
    let mut offset = start.offset;
    let mut line_number = start.line - 1;
    while let Some((bytes, consumed)) = read_bounded_line(&mut reader)? {
        line_number += 1;
        offset += consumed;
        let text = String::from_utf8_lossy(&bytes)
            .trim_end_matches(['\r', '\n'])
            .to_owned();
        let matched = match mode {
            SearchMode::Exact => text.contains(query),
            SearchMode::Regex => regex.as_ref().is_some_and(|regex| regex.is_match(&text)),
            SearchMode::Fuzzy => fuzzy_matches(&text, query),
        };
        if matched {
            results.push(LogMatch {
                line: line_number,
                text,
            });
            if results.len() >= MAX_RESULTS {
                // Only report a cursor when something is left to read.
                let more = !reader.fill_buf()?.is_empty();
                return Ok(LogSearchPage {
                    matches: results,
                    next: more.then_some(LogCursor {
                        offset,
                        line: line_number + 1,
                    }),
                });
            }
        }
    }
    Ok(LogSearchPage {
        matches: results,
        next: None,
    })
}

/// A cursor must point at the start of a line inside the file; anything else
/// was not produced by a previous page and is rejected rather than guessed.
fn validate_cursor(file: &mut File, cursor: LogCursor) -> Result<()> {
    if cursor.line == 0 {
        bail!("log cursor の行番号が不正です");
    }
    let length = file.metadata()?.len();
    if cursor.offset > length {
        bail!("log cursor が file の末尾を超えています");
    }
    if cursor.offset == 0 {
        if cursor.line != 1 {
            bail!("log cursor の行番号が不正です");
        }
        return Ok(());
    }
    let mut previous = [0_u8; 1];
    file.seek(SeekFrom::Start(cursor.offset - 1))?;
    std::io::Read::read_exact(file, &mut previous)?;
    if previous[0] != b'\n' {
        bail!("log cursor が行頭を指していません");
    }
    Ok(())
}

/// Reads one line of at most `MAX_LINE_BYTES`, returning it with the number of
/// bytes consumed from the file (the whole line, even past the cap).
fn read_bounded_line(reader: &mut impl BufRead) -> Result<Option<(Vec<u8>, u64)>> {
    let mut line = Vec::new();
    let mut total = 0_u64;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok((total > 0).then_some((line, total)));
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        let remaining = MAX_LINE_BYTES.saturating_sub(line.len());
        line.extend_from_slice(&available[..consumed.min(remaining)]);
        let complete = available[..consumed].ends_with(b"\n");
        reader.consume(consumed);
        total += consumed as u64;
        if complete {
            return Ok(Some((line, total)));
        }
    }
}

fn fuzzy_matches(text: &str, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    let mut characters = query.chars().flat_map(char::to_lowercase);
    let mut wanted = characters.next();
    for character in text.chars().flat_map(char::to_lowercase) {
        if Some(character) == wanted {
            wanted = characters.next();
            if wanted.is_none() {
                return true;
            }
        }
    }
    false
}

fn safe_value(value: &str) -> String {
    let value = value
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if value.is_empty() {
        "unknown".to_owned()
    } else {
        value
    }
}

fn validate_file_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'
                )
        })
        || name.len() > 255
    {
        bail!("安全でない log file name です");
    }
    Ok(())
}

fn is_log_file_name(name: &str) -> bool {
    name.ends_with(".log")
        || name
            .rsplit_once(".log.")
            .is_some_and(|(base, generation)| !base.is_empty() && generation.parse::<u8>().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_only_fixed_safe_variables() {
        let directory = tempfile::tempdir().expect("directory");
        let input = LogInput {
            enabled: true,
            directory_token: None,
            file_name_template: "{host}-{user}-{date}-{time}.log".to_owned(),
            timestamps: true,
            rotation_bytes: MIN_ROTATION_BYTES,
            retained_files: 3,
        };
        let configured =
            configure(input, directory.path().to_path_buf(), "prod/db", "a b").expect("config");
        assert!(configured.file_name.starts_with("prod_db-a_b-"));
        assert!(
            configure(
                LogInput {
                    enabled: true,
                    directory_token: None,
                    file_name_template: "{unknown}.log".to_owned(),
                    timestamps: false,
                    rotation_bytes: MIN_ROTATION_BYTES,
                    retained_files: 1,
                },
                directory.path().to_path_buf(),
                "h",
                "u"
            )
            .is_err()
        );
        for template in ["line\nbreak.log", "windows?.log", "directory/name.log"] {
            assert!(
                configure(
                    LogInput {
                        enabled: true,
                        directory_token: None,
                        file_name_template: template.to_owned(),
                        timestamps: false,
                        rotation_bytes: MIN_ROTATION_BYTES,
                        retained_files: 1,
                    },
                    directory.path().to_path_buf(),
                    "h",
                    "u"
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn reports_an_invalid_log_target_before_session_start() {
        let directory = tempfile::tempdir().expect("directory");
        fs::create_dir(directory.path().join("session.log")).expect("conflicting directory");
        let config = configure(
            LogInput {
                enabled: true,
                directory_token: None,
                file_name_template: "session.log".to_owned(),
                timestamps: false,
                rotation_bytes: MIN_ROTATION_BYTES,
                retained_files: 1,
            },
            directory.path().to_path_buf(),
            "host",
            "user",
        )
        .expect("config");

        let error = match start(config).await {
            Ok(_) => panic!("invalid target was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("session.log"));
    }

    #[test]
    fn bounded_search_handles_large_lines_and_all_modes() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("test.log");
        let mut content = vec![b'x'; MAX_LINE_BYTES * 2];
        content.extend_from_slice(b" needle end\nsecond Error 42\n");
        fs::write(&path, content).expect("log");
        assert_eq!(
            search(
                directory.path(),
                "test.log",
                "needle",
                SearchMode::Exact,
                None
            )
            .expect("exact")
            .matches
            .len(),
            0
        );
        assert_eq!(
            search(
                directory.path(),
                "test.log",
                "serr42",
                SearchMode::Fuzzy,
                None
            )
            .expect("fuzzy")
            .matches
            .len(),
            1
        );
        assert_eq!(
            search(
                directory.path(),
                "test.log",
                r"Error \d+",
                SearchMode::Regex,
                None
            )
            .expect("regex")
            .matches
            .len(),
            1
        );
    }

    #[test]
    fn rotation_preserves_requested_generations() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("session.log");
        fs::write(&path, b"current").expect("current");
        fs::write(rotated_path(&path, 1), b"one").expect("one");
        fs::write(rotated_path(&path, 2), b"two").expect("two");
        rotate(&path, 2).expect("rotate");
        assert_eq!(fs::read(rotated_path(&path, 1)).expect("one"), b"current");
        assert_eq!(fs::read(rotated_path(&path, 2)).expect("two"), b"one");
    }

    #[cfg(unix)]
    #[test]
    fn log_files_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("session.log");
        open_log(&path).expect("log file");
        let mode = fs::metadata(&path).expect("metadata").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let target = directory.path().join("target.txt");
        fs::write(&target, b"unchanged").expect("target");
        let link = directory.path().join("link.log");
        symlink(&target, &link).expect("symlink");
        assert!(open_log(&link).is_err());
        assert!(
            search(
                directory.path(),
                "link.log",
                "sentinel",
                SearchMode::Exact,
                None
            )
            .is_err()
        );
        assert_eq!(fs::read(&target).expect("target"), b"unchanged");
    }

    #[test]
    fn searches_a_100_mib_file_with_a_bounded_line_buffer() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("session-large.log");
        let mut file = File::create(&path).expect("file");
        file.set_len(100 * 1024 * 1024).expect("sparse fixture");
        file.seek(SeekFrom::End(-32)).expect("seek");
        file.write_all(b"\nunique-search-marker\n").expect("marker");
        drop(file);

        let page = search(
            directory.path(),
            "session-large.log",
            "unique-search-marker",
            SearchMode::Exact,
            None,
        )
        .expect("search");
        assert_eq!(page.matches.len(), 1);
        assert!(page.next.is_none());
    }

    #[test]
    fn pages_through_every_line_with_a_cursor() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("paged.log");
        let total = MAX_RESULTS * 2 + 7;
        let content = (1..=total)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        fs::write(&path, content).expect("log");

        let mut cursor = None;
        let mut seen = Vec::new();
        loop {
            let page =
                search(directory.path(), "paged.log", "", SearchMode::Fuzzy, cursor).expect("page");
            assert!(page.matches.len() <= MAX_RESULTS);
            seen.extend(
                page.matches
                    .iter()
                    .map(|entry| (entry.line, entry.text.clone())),
            );
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(seen.len(), total);
        for (index, (line, text)) in seen.iter().enumerate() {
            assert_eq!(*line, index as u64 + 1);
            assert_eq!(text, &format!("line {}", index + 1));
        }
    }

    #[test]
    fn a_page_that_ends_exactly_at_eof_has_no_cursor() {
        let directory = tempfile::tempdir().expect("directory");
        let content = (1..=MAX_RESULTS)
            .map(|line| format!("{line}\n"))
            .collect::<String>();
        fs::write(directory.path().join("exact.log"), content).expect("log");
        let page =
            search(directory.path(), "exact.log", "", SearchMode::Fuzzy, None).expect("page");
        assert_eq!(page.matches.len(), MAX_RESULTS);
        assert!(page.next.is_none());
    }

    #[test]
    fn rejects_cursors_that_a_previous_page_could_not_have_produced() {
        let directory = tempfile::tempdir().expect("directory");
        fs::write(directory.path().join("cursor.log"), b"first\nsecond\n").expect("log");
        let search_at = |offset, line| {
            search(
                directory.path(),
                "cursor.log",
                "",
                SearchMode::Fuzzy,
                Some(LogCursor { offset, line }),
            )
        };
        assert!(search_at(3, 2).is_err(), "mid-line offset");
        assert!(search_at(999, 2).is_err(), "past the end");
        assert!(search_at(0, 5).is_err(), "line number at offset 0");
        assert!(search_at(6, 0).is_err(), "line zero");
        let page = search_at(6, 2).expect("second line");
        assert_eq!(page.matches.len(), 1);
        assert_eq!(page.matches[0].line, 2);
        assert_eq!(page.matches[0].text, "second");
    }

    #[test]
    fn pages_from_the_middle_of_a_100_mib_file_without_rescanning() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("paged-large.log");
        let mut file = File::create(&path).expect("file");
        let offset = 100 * 1024 * 1024;
        file.set_len(offset).expect("sparse fixture");
        file.seek(SeekFrom::End(-1)).expect("seek");
        file.write_all(b"\n").expect("line end");
        file.write_all(b"tail-one\ntail-two\n").expect("tail");
        drop(file);

        let page = search(
            directory.path(),
            "paged-large.log",
            "tail",
            SearchMode::Exact,
            Some(LogCursor { offset, line: 2 }),
        )
        .expect("search");
        assert_eq!(
            page.matches
                .iter()
                .map(|entry| (entry.line, entry.text.as_str()))
                .collect::<Vec<_>>(),
            [(2, "tail-one"), (3, "tail-two")]
        );
    }

    #[test]
    fn every_line_keeps_one_timestamp_across_a_rotation() {
        let directory = tempfile::tempdir().expect("directory");
        let config = LogConfig {
            directory: directory.path().to_path_buf(),
            file_name: "stamped.log".to_owned(),
            timestamps: true,
            rotation_bytes: MIN_ROTATION_BYTES,
            retained_files: 2,
        };
        let (sender, receiver) = mpsc::channel(LOG_QUEUE_CAPACITY);
        let (ready_sender, _ready_receiver) = oneshot::channel();
        let writer = std::thread::spawn(move || write_loop(config, receiver, ready_sender));
        // A chunk that leaves a line open, then enough bytes to force a
        // rotation in the middle of that line, then the rest of it.
        sender.blocking_send(b"open line ".to_vec()).expect("first");
        let filler = format!("{}\n", "x".repeat(MIN_ROTATION_BYTES as usize));
        sender.blocking_send(filler.into_bytes()).expect("filler");
        sender
            .blocking_send(b"after\nnext ".to_vec())
            .expect("after");
        sender.blocking_send(b"done\n".to_vec()).expect("done");
        drop(sender);
        writer.join().expect("writer thread").expect("writer");

        let current = fs::read_to_string(directory.path().join("stamped.log")).expect("current");
        let rotated = fs::read_to_string(directory.path().join("stamped.log.1")).expect("rotated");
        for (name, content) in [("current", &current), ("rotated", &rotated)] {
            for line in content.lines().filter(|line| !line.is_empty()) {
                assert!(
                    line.starts_with("[20"),
                    "{name} line lacks a stamp: {line:.40}"
                );
                assert_eq!(
                    line.matches("] ").count(),
                    1,
                    "{name} line stamped twice: {line:.60}"
                );
            }
        }
        assert!(current.contains("] after\n"));
        assert!(current.contains("next done\n"));
    }
}
