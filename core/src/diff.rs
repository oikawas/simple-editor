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

/// Where positions in `old` end up in `new`, so a cursor or selection keeps
/// its place in the surrounding text when another device changes it. Offsets
/// count UTF-16 units. A position right where text was inserted stays before
/// the insertion; one inside removed text moves to where the removal was.
/// Edits in several places are each accounted for.
#[uniffi::export]
pub fn remap_offsets(old: String, new: String, offsets: Vec<u32>) -> Vec<u32> {
    let a: Vec<u16> = old.encode_utf16().collect();
    let b: Vec<u16> = new.encode_utf16().collect();
    let mapped = remap(&a, &b, offsets.iter().map(|&o| o as usize));
    mapped
        .into_iter()
        .map(|o| {
            // Never point into the middle of a surrogate pair.
            let o = if o > 0 && o < b.len() && (0xDC00..=0xDFFF).contains(&b[o]) { o - 1 } else { o };
            o as u32
        })
        .collect()
}

/// `remap_offsets` for offsets counted in characters (as GTK does).
pub fn remap_char_offsets(old: &str, new: &str, offsets: &[usize]) -> Vec<usize> {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    remap(&a, &b, offsets.iter().copied())
}

fn remap<T: Eq + std::hash::Hash + Ord>(a: &[T], b: &[T], offsets: impl Iterator<Item = usize>) -> Vec<usize> {
    use similar::{capture_diff_slices_deadline, Algorithm, DiffOp};
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
    let ops = capture_diff_slices_deadline(Algorithm::Myers, a, b, Some(deadline));
    offsets
        .map(|o| {
            let o = o.min(a.len());
            for op in &ops {
                match *op {
                    DiffOp::Equal { old_index, new_index, len } if o >= old_index && o < old_index + len => {
                        return new_index + (o - old_index);
                    }
                    DiffOp::Insert { old_index, new_index, .. } if o == old_index => return new_index,
                    DiffOp::Delete { old_index, old_len, new_index }
                    | DiffOp::Replace { old_index, old_len, new_index, .. }
                        if o >= old_index && o < old_index + old_len =>
                    {
                        return new_index;
                    }
                    _ => {}
                }
            }
            b.len()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaps_offsets_across_several_edits() {
        let old = "Title\nbody 😀";
        let new = "Title (shared)\nbody 😀\nappended";
        let end = old.encode_utf16().count() as u32;
        // The cursor at the old end moves by the title insertion only, not past
        // the text appended right at it.
        assert_eq!(remap_offsets(old.into(), new.into(), vec![end, 0, 5]), vec![end + 9, 0, 5]);
        // Inside removed text: to where the removal was.
        assert_eq!(remap_offsets("abcdef".into(), "abf".into(), vec![4]), vec![2]);
        assert_eq!(remap_char_offsets("a😀b", "X a😀b", &[2]), vec![4]);
    }

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
