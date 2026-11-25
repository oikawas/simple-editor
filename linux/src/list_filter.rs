//! Narrowing the notes list by when a note was created and by tags to leave
//! out. The tags to leave out are kept in the settings; the year and month are not.

use chrono::{Datelike, Local, TimeZone};

/// Notes created in a year and/or month, in local time. None means any.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CreatedFilter {
    pub year: Option<i32>,
    /// 1 to 12.
    pub month: Option<u32>,
}

impl CreatedFilter {
    pub fn matches(&self, created_at: i64) -> bool {
        self.matches_in(created_at, &Local)
    }

    /// Whether a note created at `created_at` (ms; 0 when unknown) matches.
    /// A note without a creation time matches only no filter.
    pub fn matches_in<Tz: TimeZone>(&self, created_at: i64, tz: &Tz) -> bool {
        if self.year.is_none() && self.month.is_none() {
            return true;
        }
        let Some(date) = local_date(created_at, tz) else { return false };
        self.year.is_none_or(|y| date.year() == y) && self.month.is_none_or(|m| date.month() == m)
    }
}

fn local_date<Tz: TimeZone>(created_at: i64, tz: &Tz) -> Option<chrono::DateTime<Tz>> {
    if created_at <= 0 {
        return None;
    }
    tz.timestamp_millis_opt(created_at).single()
}

/// The years notes were created in, newest first.
pub fn created_years(created_ats: impl IntoIterator<Item = i64>) -> Vec<i32> {
    created_years_in(created_ats, &Local)
}

fn created_years_in<Tz: TimeZone>(created_ats: impl IntoIterator<Item = i64>, tz: &Tz) -> Vec<i32> {
    let mut years: Vec<i32> = created_ats.into_iter().filter_map(|t| local_date(t, tz)).map(|d| d.year()).collect();
    years.sort_unstable_by(|a, b| b.cmp(a));
    years.dedup();
    years
}

/// Whether a note has none of the tags to leave out.
pub fn without_excluded(tags: &[String], excluded: &[String]) -> bool {
    !tags.iter().any(|t| excluded.contains(t))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn tokyo() -> FixedOffset {
        FixedOffset::east_opt(9 * 3600).unwrap()
    }

    fn ms(y: i32, m: u32, d: u32, h: u32) -> i64 {
        tokyo().with_ymd_and_hms(y, m, d, h, 0, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn matches_the_year_and_month_in_local_time() {
        let nov = ms(2025, 11, 15, 12);
        let f = |year, month| CreatedFilter { year, month };
        assert!(f(None, None).matches_in(nov, &tokyo()));
        assert!(f(Some(2025), None).matches_in(nov, &tokyo()));
        assert!(f(None, Some(11)).matches_in(nov, &tokyo()));
        assert!(f(Some(2025), Some(11)).matches_in(nov, &tokyo()));
        assert!(!f(Some(2024), None).matches_in(nov, &tokyo()));
        assert!(!f(Some(2025), Some(10)).matches_in(nov, &tokyo()));
        // Just after midnight on the 1st, local time (still October in UTC).
        assert!(f(None, Some(11)).matches_in(ms(2025, 11, 1, 0), &tokyo()));
    }

    #[test]
    fn a_note_without_a_creation_time_matches_only_no_filter() {
        assert!(CreatedFilter::default().matches_in(0, &tokyo()));
        assert!(!CreatedFilter { year: Some(1970), month: None }.matches_in(0, &tokyo()));
    }

    #[test]
    fn lists_the_years_newest_first() {
        let years = created_years_in([ms(2024, 3, 1, 12), ms(2026, 1, 1, 12), ms(2024, 9, 1, 12), 0], &tokyo());
        assert_eq!(years, vec![2026, 2024]);
    }

    #[test]
    fn leaves_out_notes_with_an_excluded_tag() {
        let s = |v: &[&str]| v.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert!(without_excluded(&s(&["work"]), &s(&[])));
        assert!(without_excluded(&s(&["work"]), &s(&["archive"])));
        assert!(!without_excluded(&s(&["work", "archive"]), &s(&["archive", "draft"])));
    }
}
