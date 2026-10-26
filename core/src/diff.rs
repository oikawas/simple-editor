//! Line diffs for comparing a history version with the current text.

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum DiffKind {
    Same,
    /// Only in the second text (restoring it would add the line).
    Added,
    /// Only in the first text (restoring would remove the line).
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

/// Line diff from `from` to `to` using a longest-common-subsequence table.
/// Returns `None` when the texts are too large to diff quickly.
#[uniffi::export]
pub fn line_diff(from: String, to: String) -> Option<Vec<DiffLine>> {
    const MAX_CELLS: usize = 4_000_000;
    let a: Vec<&str> = from.split('\n').collect();
    let b: Vec<&str> = to.split('\n').collect();
    // Trim the common head and tail first; most edits touch a small region.
    let mut head = 0;
    while head < a.len() && head < b.len() && a[head] == b[head] {
        head += 1;
    }
    let mut tail = 0;
    while tail < a.len() - head && tail < b.len() - head && a[a.len() - 1 - tail] == b[b.len() - 1 - tail] {
        tail += 1;
    }
    let am = &a[head..a.len() - tail];
    let bm = &b[head..b.len() - tail];
    let (n, m) = (am.len(), bm.len());
    if (n + 1) * (m + 1) > MAX_CELLS {
        return None;
    }
    let at = |i: usize, j: usize| i * (m + 1) + j;
    let mut lcs = vec![0u32; (n + 1) * (m + 1)];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[at(i, j)] = if am[i] == bm[j] { lcs[at(i + 1, j + 1)] + 1 } else { lcs[at(i + 1, j)].max(lcs[at(i, j + 1)]) };
        }
    }
    let line = |kind, text: &str| DiffLine { kind, text: text.to_owned() };
    let mut out: Vec<DiffLine> = a[..head].iter().map(|t| line(DiffKind::Same, t)).collect();
    let (mut i, mut j) = (0, 0);
    while i < n || j < m {
        if i < n && j < m && am[i] == bm[j] {
            out.push(line(DiffKind::Same, am[i]));
            i += 1;
            j += 1;
        } else if j < m && (i == n || lcs[at(i, j + 1)] >= lcs[at(i + 1, j)]) {
            out.push(line(DiffKind::Added, bm[j]));
            j += 1;
        } else {
            out.push(line(DiffKind::Removed, am[i]));
            i += 1;
        }
    }
    out.extend(a[a.len() - tail..].iter().map(|t| line(DiffKind::Same, t)));
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(from: &str, to: &str) -> Vec<(DiffKind, String)> {
        line_diff(from.into(), to.into()).unwrap().into_iter().map(|d| (d.kind, d.text)).collect()
    }

    #[test]
    fn diffs_lines() {
        use DiffKind::*;
        assert_eq!(
            kinds("title\nkobe\nnara\nosaka", "title\nkyoto\nnara"),
            vec![
                (Same, "title".into()),
                (Added, "kyoto".into()),
                (Removed, "kobe".into()),
                (Same, "nara".into()),
                (Removed, "osaka".into()),
            ]
        );
        assert!(kinds("a\nb", "a\nb").iter().all(|(k, _)| *k == Same));
    }
}
