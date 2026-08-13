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
