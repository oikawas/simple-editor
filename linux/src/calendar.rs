//! The diary's month calendar. GtkCalendar cannot color single days, so this
//! is a grid of day buttons like the web app's: Sundays and holidays in red,
//! Saturdays in blue, today in the accent color, a dot under written days.

use gtk::prelude::*;
use simple_editor_core::holiday::japanese_holiday;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];
/// Six weeks cover every month.
const CELLS: usize = 42;
const DAY_CLASSES: [&str; 6] = ["sun", "sat", "holiday", "today", "selected", "written"];

type Callback = Rc<dyn Fn(&str)>;

struct Shown {
    year: i32,
    /// 1-12
    month: u32,
    selected: Option<String>,
    written: HashSet<u32>,
    /// The date ("YYYY-MM-DD") of each cell, None outside the month.
    dates: Vec<Option<String>>,
}

struct Inner {
    root: gtk::Box,
    title: gtk::Label,
    days: Vec<(gtk::Button, gtk::Label)>,
    shown: RefCell<Shown>,
    on_pick: RefCell<Option<Callback>>,
    on_month: RefCell<Option<Callback>>,
}

#[derive(Clone)]
pub struct DiaryCalendar(Rc<Inner>);

/// The (year, month) `delta` months away.
fn add_months(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let index = year * 12 + month as i32 - 1 + delta;
    (index.div_euclid(12), index.rem_euclid(12) as u32 + 1)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (ny, nm) = add_months(year, month, 1);
    let first_next = chrono::NaiveDate::from_ymd_opt(ny, nm, 1).expect("valid date");
    first_next.pred_opt().map(|d| chrono::Datelike::day(&d)).unwrap_or(30)
}

/// 0 = Sunday.
fn weekday_of(year: i32, month: u32, day: u32) -> u32 {
    chrono::NaiveDate::from_ymd_opt(year, month, day)
        .map(|d| chrono::Datelike::weekday(&d).num_days_from_sunday())
        .unwrap_or(0)
}

impl DiaryCalendar {
    /// A calendar showing the month of `today` ("YYYY-MM-DD").
    pub fn new(today: &str) -> Self {
        let (year, month) = parse_month(today).unwrap_or((2000, 1));

        let title = gtk::Label::builder().xalign(0.0).hexpand(true).css_classes(["cal-title"]).build();
        let prev = gtk::Button::from_icon_name("go-previous-symbolic");
        prev.set_tooltip_text(Some("前の月"));
        let next = gtk::Button::from_icon_name("go-next-symbolic");
        next.set_tooltip_text(Some("次の月"));
        for b in [&prev, &next] {
            b.add_css_class("flat");
            b.add_css_class("circular");
        }
        let head = gtk::Box::new(gtk::Orientation::Horizontal, 2);
        head.append(&title);
        head.append(&prev);
        head.append(&next);

        let grid = gtk::Grid::builder().column_homogeneous(true).row_spacing(2).build();
        for (i, w) in WEEKDAYS.iter().enumerate() {
            let label = gtk::Label::new(Some(w));
            label.add_css_class("cal-weekday");
            match i {
                0 => label.add_css_class("sun"),
                6 => label.add_css_class("sat"),
                _ => {}
            }
            grid.attach(&label, i as i32, 0, 1, 1);
        }
        let mut days = Vec::with_capacity(CELLS);
        for i in 0..CELLS {
            let number = gtk::Label::new(None);
            let dot = gtk::Box::new(gtk::Orientation::Horizontal, 0);
            dot.add_css_class("cal-dot");
            dot.set_halign(gtk::Align::Center);
            let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
            content.set_valign(gtk::Align::Center);
            content.append(&number);
            content.append(&dot);
            let button = gtk::Button::builder().child(&content).halign(gtk::Align::Center).build();
            button.add_css_class("cal-day");
            button.add_css_class("flat");
            grid.attach(&button, (i % 7) as i32, (i / 7) as i32 + 1, 1, 1);
            days.push((button, number));
        }

        let root = gtk::Box::new(gtk::Orientation::Vertical, 4);
        root.add_css_class("diary-calendar");
        root.append(&head);
        root.append(&grid);

        let cal = DiaryCalendar(Rc::new(Inner {
            root,
            title,
            days,
            shown: RefCell::new(Shown {
                year,
                month,
                selected: None,
                written: HashSet::new(),
                dates: vec![None; CELLS],
            }),
            on_pick: RefCell::new(None),
            on_month: RefCell::new(None),
        }));

        for (i, (button, _)) in cal.0.days.iter().enumerate() {
            let weak = Rc::downgrade(&cal.0);
            button.connect_clicked(move |_| {
                let Some(inner) = weak.upgrade() else { return };
                // Release the borrow before calling out: the handler updates the calendar.
                let date = inner.shown.borrow().dates[i].clone();
                let callback = inner.on_pick.borrow().clone();
                if let (Some(date), Some(f)) = (date, callback) {
                    f(&date);
                }
            });
        }
        for (button, delta) in [(&prev, -1), (&next, 1)] {
            let weak = Rc::downgrade(&cal.0);
            button.connect_clicked(move |_| {
                let Some(inner) = weak.upgrade() else { return };
                let cal = DiaryCalendar(inner);
                let (year, month) = cal.month();
                let (year, month) = add_months(year, month, delta);
                cal.set_month(year, month);
                let callback = cal.0.on_month.borrow().clone();
                if let Some(f) = callback {
                    f(&format!("{year:04}-{month:02}"));
                }
            });
        }
        cal.render();
        cal
    }

    pub fn widget(&self) -> &gtk::Box {
        &self.0.root
    }

    /// The shown (year, month 1-12).
    pub fn month(&self) -> (i32, u32) {
        let s = self.0.shown.borrow();
        (s.year, s.month)
    }

    /// "YYYY-MM-" for matching the shown month's dates.
    pub fn month_prefix(&self) -> String {
        let (year, month) = self.month();
        format!("{year:04}-{month:02}-")
    }

    /// Called with "YYYY-MM-DD" when a day is clicked.
    pub fn connect_day_picked(&self, f: impl Fn(&str) + 'static) {
        self.0.on_pick.replace(Some(Rc::new(f)));
    }

    /// Called with "YYYY-MM" after the user moves to another month.
    pub fn connect_month_changed(&self, f: impl Fn(&str) + 'static) {
        self.0.on_month.replace(Some(Rc::new(f)));
    }

    pub fn set_month(&self, year: i32, month: u32) {
        {
            let mut s = self.0.shown.borrow_mut();
            if (s.year, s.month) == (year, month) {
                return;
            }
            s.year = year;
            s.month = month;
            // The written days are the old month's until the caller sets them.
            s.written.clear();
        }
        self.render();
    }

    /// Highlights a date ("YYYY-MM-DD") and shows its month.
    pub fn select(&self, date: &str) {
        self.0.shown.borrow_mut().selected = Some(date.to_owned());
        match parse_month(date) {
            Some((year, month)) if (year, month) != self.month() => self.set_month(year, month),
            _ => self.render(),
        }
    }

    /// The days of the shown month that have an entry.
    pub fn set_written(&self, days: impl IntoIterator<Item = u32>) {
        let days: HashSet<u32> = days.into_iter().collect();
        if self.0.shown.borrow().written == days {
            return;
        }
        self.0.shown.borrow_mut().written = days;
        self.render();
    }

    fn render(&self) {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut s = self.0.shown.borrow_mut();
        let (year, month) = (s.year, s.month);
        self.0.title.set_text(&format!("{year}年{month}月"));
        let first = weekday_of(year, month, 1) as usize;
        let count = days_in_month(year, month) as usize;
        for (i, (button, number)) in self.0.days.iter().enumerate() {
            for class in DAY_CLASSES {
                button.remove_css_class(class);
            }
            let day = i as i64 - first as i64 + 1;
            if day < 1 || day > count as i64 {
                s.dates[i] = None;
                // Empty cells keep their place; a sixth week only appears when needed.
                button.set_visible(i < (first + count).div_ceil(7) * 7);
                button.set_opacity(0.0);
                button.set_sensitive(false);
                button.set_tooltip_text(None);
                number.set_text("");
                continue;
            }
            let day = day as u32;
            let date = format!("{year:04}-{month:02}-{day:02}");
            let mut classes = Vec::new();
            match i % 7 {
                0 => classes.push("sun"),
                6 => classes.push("sat"),
                _ => {}
            }
            if japanese_holiday(date.clone()).is_some() {
                classes.push("holiday");
            }
            if date == today {
                classes.push("today");
            }
            if s.selected.as_deref() == Some(date.as_str()) {
                classes.push("selected");
            }
            if s.written.contains(&day) {
                classes.push("written");
            }
            for class in classes {
                button.add_css_class(class);
            }
            button.set_visible(true);
            button.set_opacity(1.0);
            button.set_sensitive(true);
            button.set_tooltip_text(Some(&crate::window::format_diary_date(&date)));
            number.set_text(&day.to_string());
            s.dates[i] = Some(date);
        }
    }
}

fn parse_month(date: &str) -> Option<(i32, u32)> {
    let year = date.get(0..4)?.parse().ok()?;
    let month = date.get(5..7)?.parse().ok()?;
    (1..=12).contains(&month).then_some((year, month))
}

/// Styles for the calendar, added to the app's stylesheet.
pub const CSS: &str = "
.diary-calendar .cal-title { font-weight: bold; margin-left: 6px; }
.diary-calendar .cal-weekday { font-size: 0.8em; opacity: 0.6; margin-bottom: 2px; }
.diary-calendar .cal-day { min-width: 34px; min-height: 34px; padding: 0; border-radius: 999px; }
.diary-calendar .cal-day label { font-feature-settings: \"tnum\"; }
.diary-calendar .cal-dot { min-width: 4px; min-height: 4px; margin-top: 1px; border-radius: 999px; }
.diary-calendar .cal-day.written .cal-dot { background-color: @accent_color; }
.diary-calendar .sun, .diary-calendar .cal-day.holiday { color: #c8463d; }
.diary-calendar .sat { color: #3b6bc8; }
.diary-calendar .cal-day.today { color: @accent_color; font-weight: bold; }
.diary-calendar .cal-day.selected { background-color: @accent_bg_color; color: @accent_fg_color; font-weight: bold; }
.diary-calendar .cal-day.selected.written .cal-dot { background-color: @accent_fg_color; }
";

/// Dark-theme colors for Sundays, holidays, and Saturdays (the web app's).
pub const CSS_DARK: &str = "
.diary-calendar .sun, .diary-calendar .cal-day.holiday { color: #ee7a72; }
.diary-calendar .sat { color: #84a7f0; }
.diary-calendar .cal-day.today { color: @accent_color; }
.diary-calendar .cal-day.selected { color: @accent_fg_color; }
";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn months_wrap_around_the_year() {
        assert_eq!(add_months(2026, 12, 1), (2027, 1));
        assert_eq!(add_months(2026, 1, -1), (2025, 12));
        assert_eq!(add_months(2026, 11, 0), (2026, 11));
    }

    #[test]
    fn month_lengths() {
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 2), 28);
        assert_eq!(days_in_month(2026, 11), 30);
        assert_eq!(days_in_month(2026, 12), 31);
    }

    #[test]
    fn weekdays_and_months_parse() {
        assert_eq!(weekday_of(2026, 11, 1), 0);
        assert_eq!(weekday_of(2026, 11, 3), 2);
        assert_eq!(parse_month("2026-11-03"), Some((2026, 11)));
        assert_eq!(parse_month("2026-13-01"), None);
    }
}
