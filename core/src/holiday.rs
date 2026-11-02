//! Japanese national holidays, for the diary's calendar. Computed on the
//! device from the rules of the holiday law (国民の祝日に関する法律), so the
//! calendar works offline. client/src/holidays.ts implements the same rules
//! for the web app; keep the two in step.
//!
//! Covers 1980-2099: the equinox formula holds for those years.

const FIRST_YEAR: i32 = 1980;
const LAST_YEAR: i32 = 2099;

/// Days since 1970-01-01 for a date in the proleptic Gregorian calendar.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = m as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 0 for Sunday.
fn weekday(y: i32, m: u32, d: u32) -> u32 {
    (days_from_civil(y, m, d) + 4).rem_euclid(7) as u32
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// The day of the month of the nth Monday.
fn nth_monday(y: i32, m: u32, n: u32) -> u32 {
    let first = weekday(y, m, 1);
    1 + (8 - first) % 7 + (n - 1) * 7
}

fn vernal_equinox(y: i32) -> u32 {
    (20.8431 + 0.242194 * (y - 1980) as f64 - ((y - 1980) / 4) as f64).floor() as u32
}

fn autumnal_equinox(y: i32) -> u32 {
    (23.2488 + 0.242194 * (y - 1980) as f64 - ((y - 1980) / 4) as f64).floor() as u32
}

/// The holidays named in the law (祝日), without substitute holidays and
/// citizens' holidays.
fn named_holiday(y: i32, m: u32, d: u32) -> Option<&'static str> {
    let name = match (m, d) {
        (1, 1) => "元日",
        (1, _) if y >= 2000 && d == nth_monday(y, 1, 2) => "成人の日",
        (1, 15) if y < 2000 => "成人の日",
        (2, 11) => "建国記念の日",
        (2, 23) if y >= 2020 => "天皇誕生日",
        (2, 24) if y == 1989 => "昭和天皇の大喪の礼",
        (3, _) if d == vernal_equinox(y) => "春分の日",
        (4, 29) if y >= 2007 => "昭和の日",
        (4, 29) if y >= 1989 => "みどりの日",
        (4, 29) => "天皇誕生日",
        (5, 1) if y == 2019 => "天皇の即位の日",
        (5, 3) => "憲法記念日",
        (5, 4) if y >= 2007 => "みどりの日",
        (5, 5) => "こどもの日",
        (6, 9) if y == 1993 => "皇太子徳仁親王の結婚の儀",
        (7, 20) if (1996..=2002).contains(&y) => "海の日",
        (7, 23) if y == 2020 => "海の日",
        (7, 22) if y == 2021 => "海の日",
        (7, _) if y >= 2003 && y != 2020 && y != 2021 && d == nth_monday(y, 7, 3) => "海の日",
        (7, 24) if y == 2020 => "スポーツの日",
        (7, 23) if y == 2021 => "スポーツの日",
        (8, 10) if y == 2020 => "山の日",
        (8, 8) if y == 2021 => "山の日",
        (8, 11) if y >= 2016 && y != 2020 && y != 2021 => "山の日",
        (9, 15) if y < 2003 => "敬老の日",
        (9, _) if y >= 2003 && d == nth_monday(y, 9, 3) => "敬老の日",
        (9, _) if d == autumnal_equinox(y) => "秋分の日",
        (10, 10) if y < 2000 => "体育の日",
        (10, _) if y >= 2000 && y != 2020 && y != 2021 && d == nth_monday(y, 10, 2) => {
            if y >= 2020 {
                "スポーツの日"
            } else {
                "体育の日"
            }
        }
        (10, 22) if y == 2019 => "即位礼正殿の儀",
        (11, 3) => "文化の日",
        (11, 12) if y == 1990 => "即位礼正殿の儀",
        (11, 23) => "勤労感謝の日",
        (12, 23) if (1989..=2018).contains(&y) => "天皇誕生日",
        _ => return None,
    };
    Some(name)
}

/// The day before or after, as (year, month, day).
fn step(y: i32, m: u32, d: u32, forward: bool) -> (i32, u32, u32) {
    if forward {
        if d < days_in_month(y, m) {
            (y, m, d + 1)
        } else if m < 12 {
            (y, m + 1, 1)
        } else {
            (y + 1, 1, 1)
        }
    } else if d > 1 {
        (y, m, d - 1)
    } else if m > 1 {
        (y, m - 1, days_in_month(y, m - 1))
    } else {
        (y - 1, 12, 31)
    }
}

fn holiday_name(y: i32, m: u32, d: u32) -> Option<&'static str> {
    if !(FIRST_YEAR..=LAST_YEAR).contains(&y) {
        return None;
    }
    if let Some(name) = named_holiday(y, m, d) {
        return Some(name);
    }
    // Substitute holiday (振替休日): a holiday on a Sunday moves to the next
    // day that is not a holiday (before 2007: only to the Monday).
    let mut back = step(y, m, d, false);
    if y >= 2007 {
        while named_holiday(back.0, back.1, back.2).is_some() {
            if weekday(back.0, back.1, back.2) == 0 {
                return Some("振替休日");
            }
            back = step(back.0, back.1, back.2, false);
        }
    } else if weekday(y, m, d) == 1 && named_holiday(back.0, back.1, back.2).is_some() {
        return Some("振替休日");
    }
    // Citizens' holiday (国民の休日, from 1986): a day between two holidays
    // (before 2007, not on a Sunday).
    let before = step(y, m, d, false);
    let after = step(y, m, d, true);
    if y >= 1986
        && named_holiday(before.0, before.1, before.2).is_some()
        && named_holiday(after.0, after.1, after.2).is_some()
        && (y >= 2007 || weekday(y, m, d) != 0)
    {
        return Some("国民の休日");
    }
    None
}

/// The name of the Japanese holiday on a date ("YYYY-MM-DD"), or `None`.
#[uniffi::export]
pub fn japanese_holiday(date: String) -> Option<String> {
    let mut parts = date.split('-').map(|p| p.parse::<u32>().ok());
    let (Some(Some(y)), Some(Some(m)), Some(Some(d)), None) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    if !(1..=12).contains(&m) || d == 0 || d > days_in_month(y as i32, m) {
        return None;
    }
    holiday_name(y as i32, m, d).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every holiday of a year, as "MM-DD name", for comparing with the
    /// Cabinet Office's list. The same lists test client/src/holidays.ts.
    fn year(y: i32) -> Vec<String> {
        let mut out = Vec::new();
        for m in 1..=12 {
            for d in 1..=days_in_month(y, m) {
                if let Some(name) = japanese_holiday(format!("{y:04}-{m:02}-{d:02}")) {
                    out.push(format!("{m:02}-{d:02} {name}"));
                }
            }
        }
        out
    }

    #[test]
    fn matches_the_cabinet_office_lists() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/holidays.json")).expect("fixtures");
        for (y, days) in fixtures.as_object().unwrap() {
            let want: Vec<String> = days.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
            assert_eq!(year(y.parse().unwrap()), want, "holidays of {y}");
        }
    }

    #[test]
    fn weekdays_and_bad_input() {
        assert_eq!(weekday(2026, 11, 1), 0);
        assert_eq!(weekday(2024, 1, 2), 2);
        assert_eq!(japanese_holiday("2026-02-30".into()), None);
        assert_eq!(japanese_holiday("2026-11".into()), None);
        assert_eq!(japanese_holiday("1970-01-01".into()), None);
    }
}
