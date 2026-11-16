use std::cmp::Ordering;

/// Compares file names without allocating a lowercase copy for every sort comparison.
///
/// ASCII folding matches the common shell/file-manager expectation. The original
/// UTF-8 bytes provide a deterministic tie-break and preserve all non-ASCII names.
pub fn case_insensitive(left: &str, right: &str) -> Ordering {
    left.bytes()
        .map(|byte| byte.to_ascii_lowercase())
        .cmp(right.bytes().map(|byte| byte.to_ascii_lowercase()))
        .then_with(|| left.cmp(right))
}

/// Directories first, then files, symlinks, and anything else.
pub(crate) fn entry_rank(kind: &str) -> u8 {
    match kind {
        "directory" => 0,
        "file" => 1,
        "symlink" => 2,
        _ => 3,
    }
}

/// Orders directory listings by kind, then case-insensitively by name.
pub(crate) fn entry_order(
    left_kind: &str,
    left_name: &str,
    right_kind: &str,
    right_name: &str,
) -> Ordering {
    entry_rank(left_kind)
        .cmp(&entry_rank(right_kind))
        .then_with(|| case_insensitive(left_name, right_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_ascii_case_without_allocating_sort_keys() {
        let mut names = ["zeta", "Beta", "alpha", "ALPHA", "界"];
        names.sort_by(|left, right| case_insensitive(left, right));
        assert_eq!(names, ["ALPHA", "alpha", "Beta", "zeta", "界"]);
    }
}
