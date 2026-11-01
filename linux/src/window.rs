//! The main window: note list (or the diary's calendar) on the left, editor
//! on the right.

use crate::config::{self, Settings};
use crate::{history, settings_dialog};
use adw::prelude::*;
use gtk::{gio, glib};
use simple_editor_core::client::{Client, ClientConfig, ClientListener, Note};
use simple_editor_core::diff::remap_char_offsets;
use simple_editor_core::error::CoreError;
use simple_editor_core::note::{diary_date, diary_note_id, NoteSummary};
use simple_editor_core::sync::SyncStatus;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

/// Events from the core, which arrive on its threads and are handled on the
/// GTK main thread.
enum Event {
    Status(SyncStatus),
    NotesChanged,
    NoteChanged(String),
}

struct Listener(async_channel::Sender<Event>);

impl ClientListener for Listener {
    fn on_status(&self, status: SyncStatus) {
        let _ = self.0.send_blocking(Event::Status(status));
    }
    fn on_notes_changed(&self) {
        let _ = self.0.send_blocking(Event::NotesChanged);
    }
    fn on_note_changed(&self, id: String) {
        let _ = self.0.send_blocking(Event::NoteChanged(id));
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Notes,
    Diary,
}

#[derive(Clone, PartialEq)]
enum Filter {
    All,
    Tag(String),
    Trash,
}

struct State {
    settings: Settings,
    client: Option<Arc<Client>>,
    notes: Vec<NoteSummary>,
    current: Option<Arc<Note>>,
    filter: Filter,
    mode: Mode,
    /// Full-text hits from the server for a query: note id -> excerpt.
    search: Option<(String, HashMap<String, String>)>,
}

pub struct Ui {
    pub window: adw::ApplicationWindow,
    toasts: adw::ToastOverlay,
    split: adw::NavigationSplitView,
    status_title: adw::WindowTitle,
    banner: adw::Banner,
    search: gtk::SearchEntry,
    notes_tab: gtk::ToggleButton,
    diary_tab: gtk::ToggleButton,
    new_button: gtk::Button,
    tag_scroll: gtk::ScrolledWindow,
    tag_bar: gtk::Box,
    calendar: gtk::Calendar,
    /// The (year, month) the list and marks were made for. A day selection
    /// that comes with moving to another month is not taken as picking a day.
    shown_month: Rc<Cell<(i32, i32)>>,
    list: gtk::ListBox,
    empty: adw::StatusPage,
    content_page: adw::NavigationPage,
    stack: gtk::Stack,
    tags_flow: gtk::FlowBox,
    tag_entry: gtk::Entry,
    dates: gtk::Label,
    buffer: gtk::TextBuffer,
    view: gtk::TextView,
    font_css: gtk::CssProvider,
    trash_button: gtk::Button,
    changed_handler: RefCell<Option<glib::SignalHandlerId>>,
}

pub struct App {
    pub ui: Ui,
    state: RefCell<State>,
    refresh_pending: Cell<Option<glib::SourceId>>,
    search_pending: Cell<Option<glib::SourceId>>,
}

const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];

/// "2024年1月2日（火）" for "2024-01-02".
fn format_diary_date(date: &str) -> String {
    match chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
        Ok(d) => {
            use chrono::Datelike;
            let weekday = WEEKDAYS[d.weekday().num_days_from_sunday() as usize];
            format!("{}年{}月{}日（{weekday}）", d.year(), d.month(), d.day())
        }
        Err(_) => date.to_owned(),
    }
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// A diary day counts as written once it has some text.
fn is_written(n: &NoteSummary) -> bool {
    !n.title.is_empty()
}

pub fn build(app: &adw::Application) -> Rc<App> {
    let ui = build_ui(app);
    let settings = Settings::load();
    let mode = if settings.diary_mode { Mode::Diary } else { Mode::Notes };
    let app = Rc::new(App {
        ui,
        state: RefCell::new(State {
            settings,
            client: None,
            notes: Vec::new(),
            current: None,
            filter: Filter::All,
            mode,
            search: None,
        }),
        refresh_pending: Cell::new(None),
        search_pending: Cell::new(None),
    });
    connect_signals(&app);
    app.apply_font();
    app.render_list();
    app.show_note_ui(false);
    glib::spawn_future_local(clone_rc(&app, |app| async move { app.start().await }));
    app
}

fn clone_rc<T, F, R>(rc: &Rc<T>, f: F) -> R
where
    F: FnOnce(Rc<T>) -> R,
{
    f(rc.clone())
}

fn build_ui(app: &adw::Application) -> Ui {
    // Sidebar: header, status banner, search, tag filter, note list.
    let status_title = adw::WindowTitle::new("メモ", "");
    let new_button = gtk::Button::from_icon_name("list-add-symbolic");
    new_button.set_tooltip_text(Some("新規ノート"));
    new_button.set_action_name(Some("win.new-note"));
    let menu = gio::Menu::new();
    menu.append(Some("設定と端末"), Some("win.settings"));
    menu.append(Some("すべて書き出し (.zip)"), Some("win.export-all"));
    let menu_button = gtk::MenuButton::builder().icon_name("open-menu-symbolic").menu_model(&menu).build();
    let side_header = adw::HeaderBar::new();
    side_header.set_title_widget(Some(&status_title));
    side_header.pack_start(&new_button);
    side_header.pack_end(&menu_button);

    let banner = adw::Banner::new("");
    let notes_tab = gtk::ToggleButton::builder().label("メモ").hexpand(true).build();
    let diary_tab = gtk::ToggleButton::builder().label("日記").hexpand(true).group(&notes_tab).build();
    let tabs = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    tabs.add_css_class("linked");
    tabs.set_margin_start(8);
    tabs.set_margin_end(8);
    tabs.set_margin_top(6);
    tabs.append(&notes_tab);
    tabs.append(&diary_tab);
    let search = gtk::SearchEntry::builder()
        .placeholder_text("検索（メモと日記）")
        .margin_start(8)
        .margin_end(8)
        .margin_top(6)
        .build();
    let tag_bar = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    tag_bar.set_margin_start(8);
    tag_bar.set_margin_end(8);
    let tag_scroll = gtk::ScrolledWindow::builder()
        .child(&tag_bar)
        .vscrollbar_policy(gtk::PolicyType::Never)
        .margin_top(6)
        .margin_bottom(6)
        .build();
    let calendar = gtk::Calendar::builder().margin_start(8).margin_end(8).margin_top(6).margin_bottom(6).build();
    let list = gtk::ListBox::new();
    list.add_css_class("navigation-sidebar");
    let list_scroll = gtk::ScrolledWindow::builder().child(&list).vexpand(true).build();
    let side_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
    side_box.append(&banner);
    side_box.append(&tabs);
    side_box.append(&search);
    side_box.append(&tag_scroll);
    side_box.append(&calendar);
    side_box.append(&list_scroll);
    let side_toolbar = adw::ToolbarView::new();
    side_toolbar.add_top_bar(&side_header);
    side_toolbar.set_content(Some(&side_box));
    let sidebar_page = adw::NavigationPage::new(&side_toolbar, "メモ");

    // Content: tags, dates, and the text.
    let history_button = gtk::Button::from_icon_name("document-open-recent-symbolic");
    history_button.set_tooltip_text(Some("編集履歴"));
    history_button.set_action_name(Some("win.history"));
    let export_button = gtk::Button::from_icon_name("document-save-symbolic");
    export_button.set_tooltip_text(Some("テキストとして書き出し"));
    export_button.set_action_name(Some("win.export-note"));
    let trash_button = gtk::Button::from_icon_name("user-trash-symbolic");
    trash_button.set_action_name(Some("win.toggle-trash"));
    let content_header = adw::HeaderBar::new();
    content_header.pack_end(&trash_button);
    content_header.pack_end(&export_button);
    content_header.pack_end(&history_button);

    let tags_flow = gtk::FlowBox::builder()
        .selection_mode(gtk::SelectionMode::None)
        .max_children_per_line(20)
        .row_spacing(4)
        .column_spacing(4)
        .build();
    let tag_entry = gtk::Entry::builder().placeholder_text("タグを追加").width_chars(14).build();
    let tags_row = gtk::Box::new(gtk::Orientation::Horizontal, 6);
    tags_row.set_margin_start(12);
    tags_row.set_margin_end(12);
    tags_row.set_margin_top(6);
    tags_row.append(&tags_flow);
    tags_row.append(&tag_entry);
    let dates = gtk::Label::builder().xalign(0.0).margin_start(12).margin_top(4).build();
    dates.add_css_class("dim-label");
    dates.add_css_class("caption");

    let buffer = gtk::TextBuffer::new(None);
    buffer.create_tag(Some("title"), &[("weight", &700i32), ("scale", &1.2f64)]);
    let view = gtk::TextView::builder()
        .buffer(&buffer)
        .wrap_mode(gtk::WrapMode::WordChar)
        .left_margin(16)
        .right_margin(16)
        .top_margin(12)
        .bottom_margin(24)
        .pixels_below_lines(2)
        .build();
    view.add_css_class("editor");
    let font_css = gtk::CssProvider::new();
    gtk::style_context_add_provider_for_display(
        &gtk::prelude::WidgetExt::display(&view),
        &font_css,
        gtk::STYLE_PROVIDER_PRIORITY_USER,
    );
    let text_scroll = gtk::ScrolledWindow::builder().child(&view).vexpand(true).build();
    let editor = gtk::Box::new(gtk::Orientation::Vertical, 0);
    editor.append(&tags_row);
    editor.append(&dates);
    editor.append(&text_scroll);

    let empty = adw::StatusPage::builder()
        .icon_name("accessories-text-editor-symbolic")
        .title("ノートを選択するか、新規作成してください")
        .build();
    let stack = gtk::Stack::new();
    stack.add_named(&empty, Some("empty"));
    stack.add_named(&editor, Some("editor"));
    let content_toolbar = adw::ToolbarView::new();
    content_toolbar.add_top_bar(&content_header);
    content_toolbar.set_content(Some(&stack));
    let content_page = adw::NavigationPage::new(&content_toolbar, "");

    let split = adw::NavigationSplitView::new();
    split.set_sidebar(Some(&sidebar_page));
    split.set_content(Some(&content_page));
    split.set_min_sidebar_width(260.0);
    let toasts = adw::ToastOverlay::new();
    toasts.set_child(Some(&split));

    let window = adw::ApplicationWindow::builder()
        .application(app)
        .title("Simple Editor")
        .default_width(1000)
        .default_height(700)
        .width_request(360)
        .height_request(420)
        .content(&toasts)
        .build();
    let narrow = adw::Breakpoint::new(adw::BreakpointCondition::parse("max-width: 640sp").unwrap());
    narrow.add_setter(&split, "collapsed", Some(&true.to_value()));
    window.add_breakpoint(narrow);

    let shown_month = (calendar.year(), calendar.month());
    Ui {
        window,
        toasts,
        split,
        status_title,
        banner,
        search,
        notes_tab,
        diary_tab,
        new_button,
        tag_scroll,
        tag_bar,
        calendar,
        shown_month: Rc::new(Cell::new(shown_month)),
        list,
        empty,
        content_page,
        stack,
        tags_flow,
        tag_entry,
        dates,
        buffer,
        view,
        font_css,
        trash_button,
        changed_handler: RefCell::new(None),
    }
}

fn action(app: &Rc<App>, name: &str, f: impl Fn(&Rc<App>) + 'static) {
    let a = gio::SimpleAction::new(name, None);
    let weak = Rc::downgrade(app);
    a.connect_activate(move |_, _| {
        if let Some(app) = weak.upgrade() {
            f(&app);
        }
    });
    app.ui.window.add_action(&a);
}

fn connect_signals(app: &Rc<App>) {
    action(app, "new-note", |app| app.new_note());
    action(app, "settings", |app| settings_dialog::open(app, None));
    action(app, "export-all", |app| {
        glib::spawn_future_local(clone_rc(app, |app| async move { app.export_all().await }));
    });
    action(app, "export-note", |app| {
        glib::spawn_future_local(clone_rc(app, |app| async move { app.export_note().await }));
    });
    action(app, "toggle-trash", |app| app.toggle_trash());
    action(app, "history", |app| {
        let (client, note) = {
            let st = app.state.borrow();
            (st.client.clone(), st.current.clone())
        };
        if let (Some(client), Some(note)) = (client, note) {
            history::open(app, client, note);
        }
    });

    let weak = Rc::downgrade(app);
    app.ui.list.connect_row_activated(move |_, row| {
        if let Some(app) = weak.upgrade() {
            let id = row.widget_name().to_string();
            match diary_date(id.clone()) {
                Some(date) => app.open_diary(&date),
                None => app.select_note(&id),
            }
        }
    });

    let weak = Rc::downgrade(app);
    app.ui.notes_tab.connect_toggled(move |tab| {
        if let Some(app) = weak.upgrade() {
            app.set_mode(if tab.is_active() { Mode::Notes } else { Mode::Diary });
        }
    });

    // Moving to another month shows its entries; picking a day in the shown
    // month opens that day's entry. Moving can also select a day, so a
    // selection is a pick only when the month stayed the same.
    let weak = Rc::downgrade(app);
    let moved = move |_: &gtk::Calendar| {
        if let Some(app) = weak.upgrade() {
            app.calendar_month_changed();
        }
    };
    let calendar = &app.ui.calendar;
    calendar.connect_next_month(moved.clone());
    calendar.connect_prev_month(moved.clone());
    calendar.connect_next_year(moved.clone());
    calendar.connect_prev_year(moved);
    let weak = Rc::downgrade(app);
    app.ui.calendar.connect_day_selected(move |calendar| {
        let Some(app) = weak.upgrade() else { return };
        if app.calendar_month_changed() {
            return;
        }
        if let Ok(text) = calendar.date().format("%Y-%m-%d") {
            app.open_diary(&text);
        }
    });

    let weak = Rc::downgrade(app);
    app.ui.search.connect_search_changed(move |_| {
        if let Some(app) = weak.upgrade() {
            app.render_list();
            app.schedule_search();
        }
    });

    let weak = Rc::downgrade(app);
    app.ui.tag_entry.connect_activate(move |entry| {
        if let Some(app) = weak.upgrade() {
            let current = app.state.borrow().current.clone();
            if let Some(note) = current {
                if note.add_tag(entry.text().to_string()) {
                    app.note_meta_changed();
                }
            }
            entry.set_text("");
        }
    });

    let weak = Rc::downgrade(app);
    let handler = app.ui.buffer.connect_changed(move |buffer| {
        let Some(app) = weak.upgrade() else { return };
        let Some(note) = app.state.borrow().current.clone() else { return };
        let text = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false);
        note.set_body(text.to_string());
        app.style_title_line();
        app.update_current_summary();
    });
    app.ui.changed_handler.replace(Some(handler));
}

/// The span where `old` and `new` differ, in characters (GTK's offsets):
/// (start, removed count, inserted text).
fn char_span(old: &str, new: &str) -> Option<(i32, i32, String)> {
    if old == new {
        return None;
    }
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end = 0;
    while end < a.len() - start && end < b.len() - start && a[a.len() - 1 - end] == b[b.len() - 1 - end] {
        end += 1;
    }
    let inserted: String = b[start..b.len() - end].iter().collect();
    Some((start as i32, (a.len() - end - start) as i32, inserted))
}

pub fn format_date_pub(ms: i64) -> String {
    format_date(ms)
}

/// With seconds, to tell apart versions saved within the same minute.
pub fn format_time_precise(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) => t.format("%Y/%m/%d %H:%M:%S").to_string(),
        _ => String::new(),
    }
}

fn format_date(ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) => t.format("%Y/%m/%d %H:%M").to_string(),
        _ => String::new(),
    }
}

impl App {
    pub fn toast(&self, text: &str) {
        self.ui.toasts.add_toast(adw::Toast::new(text));
    }

    pub fn settings(&self) -> Settings {
        self.state.borrow().settings.clone()
    }

    /// Applies the font and line height chosen in the settings to the editor.
    pub fn apply_font(&self) {
        let settings = self.settings();
        let font = &settings.font;
        let mut rules = vec![format!("line-height: {:.1};", settings.line_height())];
        if !font.is_empty() {
            let desc = gtk::pango::FontDescription::from_string(font);
            if let Some(family) = desc.family() {
                rules.push(format!("font-family: \"{}\";", family.replace(['"', '\\'], "")));
            }
            if desc.size() > 0 {
                let size = desc.size() as f64 / gtk::pango::SCALE as f64;
                let unit = if desc.is_size_absolute() { "px" } else { "pt" };
                rules.push(format!("font-size: {size}{unit};"));
            }
            match desc.style() {
                gtk::pango::Style::Italic => rules.push("font-style: italic;".into()),
                gtk::pango::Style::Oblique => rules.push("font-style: oblique;".into()),
                _ => {}
            }
            let weight = match desc.weight() {
                gtk::pango::Weight::Thin => 100,
                gtk::pango::Weight::Ultralight => 200,
                gtk::pango::Weight::Light | gtk::pango::Weight::Semilight | gtk::pango::Weight::Book => 300,
                gtk::pango::Weight::Medium => 500,
                gtk::pango::Weight::Semibold => 600,
                gtk::pango::Weight::Bold => 700,
                gtk::pango::Weight::Ultrabold => 800,
                gtk::pango::Weight::Heavy | gtk::pango::Weight::Ultraheavy => 900,
                _ => 400,
            };
            rules.push(format!("font-weight: {weight};"));
        }
        let css = format!("textview.editor {{ {} }}", rules.join(" "));
        self.ui.font_css.load_from_string(&css);
    }

    pub fn set_settings(&self, settings: Settings) {
        self.state.borrow_mut().settings = settings;
    }

    /// Re-reads the open note after it changed outside the editor.
    pub fn reload_current(self: &Rc<Self>) {
        let current = self.state.borrow().current.clone();
        if let Some(note) = current {
            self.show_remote_body(&note);
        }
        self.note_meta_changed();
    }

    pub fn client(&self) -> Option<Arc<Client>> {
        self.state.borrow().client.clone()
    }

    async fn start(self: Rc<Self>) {
        let settings = self.settings();
        let token = if settings.server_url.is_empty() { None } else { config::load_token(&settings.server_url).await };
        match token {
            Some(token) => self.connect(token),
            None => {
                self.set_status_text("未登録");
                settings_dialog::open(&self, None);
            }
        }
    }

    /// Starts syncing with a device token (after registering, or on launch).
    pub fn connect(self: &Rc<Self>, token: String) {
        self.disconnect();
        let settings = self.settings();
        let (tx, rx) = async_channel::unbounded();
        let config = ClientConfig {
            server_url: settings.server_url.clone(),
            device_token: token,
            data_dir: config::data_dir().to_string_lossy().into_owned(),
        };
        match Client::new(config, Arc::new(Listener(tx))) {
            Ok(client) => {
                let cached = client.cached_notes().unwrap_or_default();
                {
                    let mut st = self.state.borrow_mut();
                    st.client = Some(client);
                    st.notes = cached;
                }
                self.render_list();
                let weak = Rc::downgrade(self);
                glib::spawn_future_local(async move {
                    while let Ok(event) = rx.recv().await {
                        let Some(app) = weak.upgrade() else { break };
                        app.handle(event);
                    }
                });
                self.schedule_refresh();
            }
            Err(e) => self.toast(&format!("開始できませんでした: {e}")),
        }
    }

    pub fn disconnect(&self) {
        self.close_current();
        if let Some(client) = self.state.borrow_mut().client.take() {
            client.shutdown();
        }
    }

    /// Called when this device's registration is gone: forget the token and
    /// ask to register again.
    pub fn forget_registration(self: &Rc<Self>, message: &str) {
        self.disconnect();
        let server_url = self.settings().server_url;
        glib::spawn_future_local(async move { config::clear_token(&server_url).await });
        self.set_status_text("未登録");
        settings_dialog::open(self, Some(message));
    }

    fn handle(self: &Rc<Self>, event: Event) {
        match event {
            Event::Status(status) => self.on_status(status),
            Event::NotesChanged => self.schedule_refresh(),
            Event::NoteChanged(id) => {
                let current = self.state.borrow().current.clone();
                if let Some(note) = current.filter(|n| n.id() == id) {
                    self.show_remote_body(&note);
                    self.note_meta_changed();
                }
            }
        }
    }

    fn on_status(self: &Rc<Self>, status: SyncStatus) {
        self.ui.banner.set_revealed(false);
        match status {
            SyncStatus::Online => {
                self.set_status_text("同期中");
                self.schedule_refresh();
            }
            SyncStatus::Connecting => self.set_status_text("接続中…"),
            SyncStatus::Offline => self.set_status_text("オフライン"),
            SyncStatus::RateLimited => {
                self.set_status_text("一時停止中");
                self.ui.banner.set_title("認証の失敗が続いたため、サーバーが一時的に受け付けを停止しています");
                self.ui.banner.set_revealed(true);
            }
            SyncStatus::Unauthorized => self.forget_registration(
                "この端末の登録が解除されたか、無効になっています。登録用トークンで登録し直してください。",
            ),
        }
    }

    fn set_status_text(&self, text: &str) {
        self.ui.status_title.set_subtitle(text);
    }

    pub fn schedule_refresh(self: &Rc<Self>) {
        if let Some(id) = self.refresh_pending.take() {
            id.remove();
        }
        let weak = Rc::downgrade(self);
        let id = glib::timeout_add_local_once(Duration::from_millis(300), move || {
            if let Some(app) = weak.upgrade() {
                app.refresh_pending.set(None);
                glib::spawn_future_local(async move { app.refresh().await });
            }
        });
        self.refresh_pending.set(Some(id));
    }

    async fn refresh(self: Rc<Self>) {
        let Some(client) = self.client() else { return };
        match client.notes().await {
            Ok(notes) => {
                self.state.borrow_mut().notes = notes;
                if !self.ui.search.text().is_empty() {
                    self.clone().run_search().await;
                }
                self.render_list();
            }
            Err(CoreError::Unauthorized) => {}
            Err(e) => self.toast(&format!("一覧を取得できませんでした: {e}")),
        }
    }

    fn schedule_search(self: &Rc<Self>) {
        if let Some(id) = self.search_pending.take() {
            id.remove();
        }
        let weak = Rc::downgrade(self);
        let id = glib::timeout_add_local_once(Duration::from_millis(200), move || {
            if let Some(app) = weak.upgrade() {
                app.search_pending.set(None);
                glib::spawn_future_local(async move {
                    app.clone().run_search().await;
                    app.render_list();
                });
            }
        });
        self.search_pending.set(Some(id));
    }

    async fn run_search(self: Rc<Self>) {
        let query = self.ui.search.text().trim().to_owned();
        let client = self.client();
        if query.is_empty() || client.is_none() {
            self.state.borrow_mut().search = None;
            return;
        }
        let hits = client.unwrap().search(query.clone()).await;
        // A newer query may have started while this one ran.
        if self.ui.search.text().trim() != query {
            return;
        }
        self.state.borrow_mut().search =
            hits.ok().map(|h| (query, h.into_iter().map(|h| (h.id, h.snippet)).collect()));
    }

    fn visible_notes(&self) -> Vec<(NoteSummary, Option<String>)> {
        let st = self.state.borrow();
        let query = self.ui.search.text().trim().to_lowercase();
        let terms: Vec<&str> = query.split_whitespace().collect();
        let hits = st.search.as_ref().filter(|(q, _)| q.to_lowercase() == query).map(|(_, h)| h);
        let current_body = st.current.as_ref().map(|n| (n.id(), n.body().to_lowercase()));
        // Without a search: the notes (or the trash, or a tag), or the shown
        // month's diary entries. A search covers notes and diary entries alike.
        if terms.is_empty() && st.mode == Mode::Diary {
            let month = format!("{:04}-{:02}-", self.ui.calendar.year(), self.ui.calendar.month() + 1);
            let mut entries: Vec<(NoteSummary, Option<String>)> = st
                .notes
                .iter()
                .filter(|n| is_written(n) && diary_date(n.id.clone()).is_some_and(|d| d.starts_with(&month)))
                .map(|n| (n.clone(), None))
                .collect();
            entries.sort_by(|a, b| b.0.id.cmp(&a.0.id));
            return entries;
        }
        let filter = if st.mode == Mode::Notes { st.filter.clone() } else { Filter::All };
        st.notes
            .iter()
            .filter(|n| match diary_date(n.id.clone()) {
                Some(_) => !terms.is_empty() && filter != Filter::Trash && is_written(n),
                None if filter == Filter::Trash => n.deleted,
                None => !n.deleted,
            })
            .filter(|n| match &filter {
                Filter::Tag(t) => n.tags.contains(t),
                _ => true,
            })
            .filter_map(|n| {
                if terms.is_empty() {
                    return Some((n.clone(), None));
                }
                let snippet = hits.and_then(|h| h.get(&n.id)).cloned();
                // Locally: the summary, plus the full text of the open note.
                let mut haystack = format!("{}\n{}\n{}", n.title, n.preview, n.tags.join("\n")).to_lowercase();
                if let Some((id, body)) = &current_body {
                    if *id == n.id {
                        haystack.push_str(body);
                    }
                }
                let local = terms.iter().all(|t| haystack.contains(t));
                (snippet.is_some() || local).then(|| (n.clone(), snippet))
            })
            .collect()
    }

    pub fn render_list(self: &Rc<Self>) {
        while let Some(child) = self.ui.list.first_child() {
            self.ui.list.remove(&child);
        }
        let current_id = self.state.borrow().current.as_ref().map(|n| n.id());
        let searching = !self.ui.search.text().trim().is_empty();
        let visible = self.visible_notes();
        if visible.is_empty() && !searching && self.state.borrow().mode == Mode::Diary {
            let label = gtk::Label::builder()
                .label("この月の日記はまだありません。カレンダーの日付を選ぶと書けます")
                .wrap(true)
                .margin_top(12)
                .margin_start(12)
                .margin_end(12)
                .build();
            label.add_css_class("dim-label");
            let row = gtk::ListBoxRow::builder().child(&label).activatable(false).selectable(false).build();
            self.ui.list.append(&row);
        }
        for (note, snippet) in visible {
            let date = diary_date(note.id.clone());
            let (title_text, preview_text, kind) = match &date {
                Some(date) => {
                    let body = [note.title.as_str(), note.preview.as_str()].join(" ");
                    (format_diary_date(date), snippet.unwrap_or(body), if searching { "日記".to_owned() } else { String::new() })
                }
                None => (
                    if note.title.is_empty() { "（無題）".to_owned() } else { note.title.clone() },
                    snippet.unwrap_or_else(|| note.preview.clone()),
                    format_date(note.updated_at),
                ),
            };
            let title = gtk::Label::builder()
                .label(&title_text)
                .xalign(0.0)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .build();
            title.add_css_class("heading");
            let preview = gtk::Label::builder()
                .label(&preview_text)
                .xalign(0.0)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .build();
            preview.add_css_class("dim-label");
            let tags: Vec<String> = note.tags.iter().map(|t| format!("#{t}")).collect();
            let meta = gtk::Label::builder()
                .label(format!("{kind}  {}", tags.join(" ")).trim())
                .xalign(0.0)
                .ellipsize(gtk::pango::EllipsizeMode::End)
                .build();
            meta.add_css_class("dim-label");
            meta.add_css_class("caption");
            let row_box = gtk::Box::new(gtk::Orientation::Vertical, 2);
            row_box.set_margin_top(6);
            row_box.set_margin_bottom(6);
            row_box.append(&title);
            row_box.append(&preview);
            row_box.append(&meta);
            let row = gtk::ListBoxRow::builder().child(&row_box).name(&note.id).build();
            self.ui.list.append(&row);
            if current_id.as_deref() == Some(note.id.as_str()) {
                self.ui.list.select_row(Some(&row));
            }
        }
        self.render_tag_bar();
        self.render_mode();
    }

    fn set_mode(self: &Rc<Self>, mode: Mode) {
        let settings = {
            let mut st = self.state.borrow_mut();
            if st.mode == mode {
                return;
            }
            st.mode = mode;
            st.settings.diary_mode = mode == Mode::Diary;
            st.settings.clone()
        };
        settings.save();
        self.render_list();
    }

    /// Shows the controls of the current tab, and marks the written days of
    /// the calendar's month.
    fn render_mode(&self) {
        // Read the state first: setting the tabs runs their handlers.
        let month = format!("{:04}-{:02}-", self.ui.calendar.year(), self.ui.calendar.month() + 1);
        let (diary, written): (bool, Vec<u32>) = {
            let st = self.state.borrow();
            let days = st
                .notes
                .iter()
                .filter(|n| is_written(n))
                .filter_map(|n| diary_date(n.id.clone())?.strip_prefix(&month)?.parse().ok())
                .collect();
            (st.mode == Mode::Diary, days)
        };
        self.ui.notes_tab.set_active(!diary);
        self.ui.diary_tab.set_active(diary);
        self.ui.status_title.set_title(if diary { "日記" } else { "メモ" });
        self.ui.tag_scroll.set_visible(!diary);
        self.ui.calendar.set_visible(diary);
        self.ui.new_button.set_icon_name(if diary { "x-office-calendar-symbolic" } else { "list-add-symbolic" });
        self.ui.new_button.set_tooltip_text(Some(if diary { "今日の日記" } else { "新規ノート" }));
        self.ui.empty.set_title(if diary {
            "カレンダーの日付を選ぶと、その日の日記を書けます"
        } else {
            "ノートを選択するか、新規作成してください"
        });
        if !diary {
            return;
        }
        self.ui.calendar.clear_marks();
        for day in written {
            self.ui.calendar.mark_day(day);
        }
    }

    /// Re-renders the list when the calendar shows another month; true if it did.
    fn calendar_month_changed(self: &Rc<Self>) -> bool {
        let month = (self.ui.calendar.year(), self.ui.calendar.month());
        if self.ui.shown_month.replace(month) == month {
            return false;
        }
        self.render_list();
        true
    }

    /// Opens the diary entry for a date ("YYYY-MM-DD"), switching to the diary tab.
    fn open_diary(self: &Rc<Self>, date: &str) {
        let Some(id) = diary_note_id(date.to_owned()) else { return };
        if let Ok(d) = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d") {
            use chrono::Datelike;
            let shown = self.ui.calendar.date();
            if (shown.year(), shown.month(), shown.day_of_month()) != (d.year(), d.month() as i32, d.day() as i32) {
                if let Ok(dt) = glib::DateTime::from_local(d.year(), d.month() as i32, d.day() as i32, 0, 0, 0.0) {
                    // The month is recorded first, so the selection is not taken as a move.
                    self.ui.shown_month.set((d.year(), d.month0() as i32));
                    self.ui.calendar.select_day(&dt);
                }
            }
        }
        self.set_mode(Mode::Diary);
        self.select_note(&id);
        self.render_list();
    }

    fn render_tag_bar(self: &Rc<Self>) {
        while let Some(child) = self.ui.tag_bar.first_child() {
            self.ui.tag_bar.remove(&child);
        }
        let (mut tags, filter): (Vec<String>, Filter) = {
            let st = self.state.borrow();
            let mut t: Vec<String> = st
                .notes
                .iter()
                .filter(|n| !n.deleted && diary_date(n.id.clone()).is_none())
                .flat_map(|n| n.tags.clone())
                .collect();
            t.sort();
            t.dedup();
            (t, st.filter.clone())
        };
        let mut chips = vec![("すべて".to_owned(), Filter::All)];
        chips.extend(tags.drain(..).map(|t| (format!("#{t}"), Filter::Tag(t))));
        chips.push(("ゴミ箱".to_owned(), Filter::Trash));
        for (label, value) in chips {
            let button = gtk::ToggleButton::builder().label(&label).active(value == filter).build();
            button.add_css_class("chip");
            let weak = Rc::downgrade(self);
            button.connect_clicked(move |_| {
                if let Some(app) = weak.upgrade() {
                    app.state.borrow_mut().filter = value.clone();
                    app.render_list();
                }
            });
            self.ui.tag_bar.append(&button);
        }
    }

    fn show_note_ui(&self, shown: bool) {
        self.ui.stack.set_visible_child_name(if shown { "editor" } else { "empty" });
        for name in ["history", "export-note", "toggle-trash"] {
            if let Some(a) = self.ui.window.lookup_action(name) {
                a.downcast::<gio::SimpleAction>().unwrap().set_enabled(shown);
            }
        }
    }

    fn close_current(&self) {
        let (client, note) = {
            let mut st = self.state.borrow_mut();
            (st.client.clone(), st.current.take())
        };
        if let (Some(client), Some(note)) = (client, note) {
            client.close_note(note.id());
        }
        self.set_buffer_text("");
        self.ui.content_page.set_title("");
        self.show_note_ui(false);
    }

    fn select_note(self: &Rc<Self>, id: &str) {
        let Some(client) = self.client() else { return };
        if self.state.borrow().current.as_ref().is_some_and(|n| n.id() == id) {
            self.ui.split.set_show_content(true);
            return;
        }
        self.close_current();
        match client.open_note(id.to_owned()) {
            Ok(note) => self.show_note(note),
            Err(e) => self.toast(&format!("開けませんでした: {e}")),
        }
    }

    fn new_note(self: &Rc<Self>) {
        if self.state.borrow().mode == Mode::Diary {
            self.open_diary(&today());
            return;
        }
        let Some(client) = self.client() else { return };
        self.close_current();
        let filter = {
            let mut st = self.state.borrow_mut();
            if st.filter == Filter::Trash {
                st.filter = Filter::All;
            }
            st.filter.clone()
        };
        match client.create_note() {
            Ok(note) => {
                if let Filter::Tag(tag) = filter {
                    note.add_tag(tag);
                }
                self.show_note(note);
                self.ui.view.grab_focus();
            }
            Err(e) => self.toast(&format!("作成できませんでした: {e}")),
        }
    }

    fn show_note(self: &Rc<Self>, note: Arc<Note>) {
        self.state.borrow_mut().current = Some(note.clone());
        self.set_buffer_text(&note.body());
        self.show_note_ui(true);
        self.note_meta_changed();
        self.update_current_summary();
        self.ui.split.set_show_content(true);
    }

    /// Sets the editor text without treating it as an edit.
    fn set_buffer_text(&self, text: &str) {
        let handler = self.ui.changed_handler.borrow();
        if let Some(h) = handler.as_ref() {
            self.ui.buffer.block_signal(h);
        }
        self.ui.buffer.set_text(text);
        if let Some(h) = handler.as_ref() {
            self.ui.buffer.unblock_signal(h);
        }
        self.style_title_line();
    }

    /// Applies a change from another device, touching only the part that
    /// differs. The cursor and selection keep their place in the surrounding
    /// text, even when the change touches several places; a remote insertion
    /// right at the cursor does not push it along.
    fn show_remote_body(self: &Rc<Self>, note: &Note) {
        let buffer = &self.ui.buffer;
        let old = buffer.text(&buffer.start_iter(), &buffer.end_iter(), false).to_string();
        // Read the body once: another change may arrive at any moment.
        let new = note.body();
        let Some((start, removed, inserted)) = char_span(&old, &new) else { return };
        let marks = [
            buffer.iter_at_mark(&buffer.get_insert()).offset() as usize,
            buffer.iter_at_mark(&buffer.selection_bound()).offset() as usize,
        ];
        let mapped = remap_char_offsets(&old, &new, &marks);
        let (cursor, bound) = (mapped[0] as i32, mapped[1] as i32);
        let handler = self.ui.changed_handler.borrow();
        if let Some(h) = handler.as_ref() {
            buffer.block_signal(h);
        }
        let mut from = buffer.iter_at_offset(start);
        let mut to = buffer.iter_at_offset(start + removed);
        buffer.delete(&mut from, &mut to);
        let mut at = buffer.iter_at_offset(start);
        buffer.insert(&mut at, &inserted);
        buffer.select_range(&buffer.iter_at_offset(cursor), &buffer.iter_at_offset(bound));
        if let Some(h) = handler.as_ref() {
            buffer.unblock_signal(h);
        }
        drop(handler);
        self.style_title_line();
        self.update_current_summary();
    }

    fn current_diary_date(&self) -> Option<String> {
        self.state.borrow().current.as_ref().and_then(|n| diary_date(n.id()))
    }

    /// The first line is the title; show it larger. A diary entry has none.
    fn style_title_line(&self) {
        let buffer = &self.ui.buffer;
        buffer.remove_tag_by_name("title", &buffer.start_iter(), &buffer.end_iter());
        if self.current_diary_date().is_some() {
            return;
        }
        let start = buffer.start_iter();
        let mut end = start;
        end.forward_to_line_end();
        buffer.apply_tag_by_name("title", &start, &end);
    }

    /// Reflects the open note's title and tags in the list right away.
    fn update_current_summary(self: &Rc<Self>) {
        let Some(note) = self.state.borrow().current.clone() else { return };
        let summary = note.summary();
        match diary_date(summary.id.clone()) {
            Some(date) => self.ui.content_page.set_title(&format_diary_date(&date)),
            None => self.ui.content_page.set_title(if summary.title.is_empty() { "（無題）" } else { &summary.title }),
        }
        {
            let mut st = self.state.borrow_mut();
            match st.notes.iter_mut().find(|n| n.id == summary.id) {
                Some(n) if *n == summary => return,
                Some(n) => *n = summary,
                None => st.notes.insert(0, summary),
            }
            st.notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        }
        self.render_list();
    }

    /// Re-renders tags, dates, and the trash button for the open note.
    pub fn note_meta_changed(self: &Rc<Self>) {
        let Some(note) = self.state.borrow().current.clone() else { return };
        while let Some(child) = self.ui.tags_flow.first_child() {
            self.ui.tags_flow.remove(&child);
        }
        for tag in note.tags() {
            let chip = gtk::Button::builder().label(format!("#{tag}  ✕")).tooltip_text("タグを外す").build();
            chip.add_css_class("chip");
            let weak = Rc::downgrade(self);
            chip.connect_clicked(move |_| {
                if let Some(app) = weak.upgrade() {
                    let current = app.state.borrow().current.clone();
                    if let Some(note) = current {
                        note.remove_tag(tag.clone());
                    }
                    app.note_meta_changed();
                }
            });
            self.ui.tags_flow.append(&chip);
        }
        let summary = note.summary();
        match diary_date(summary.id.clone()) {
            Some(date) => {
                let updated = if summary.updated_at > 0 {
                    format!("　更新: {}", format_date(summary.updated_at))
                } else {
                    String::new()
                };
                self.ui.dates.set_label(&format!("{}の日記{updated}", format_diary_date(&date)));
            }
            None => self.ui.dates.set_label(&format!(
                "作成: {}　更新: {}",
                format_date(summary.created_at),
                format_date(summary.updated_at)
            )),
        }
        // Diary entries do not go to the trash.
        self.ui.trash_button.set_visible(diary_date(summary.id.clone()).is_none());
        let deleted = note.is_deleted();
        self.ui.trash_button.set_icon_name(if deleted { "edit-undo-symbolic" } else { "user-trash-symbolic" });
        self.ui.trash_button.set_tooltip_text(Some(if deleted { "ゴミ箱から戻す" } else { "ゴミ箱へ" }));
        self.update_current_summary();
    }

    fn toggle_trash(self: &Rc<Self>) {
        let Some(note) = self.state.borrow().current.clone() else { return };
        let deleted = !note.is_deleted();
        note.set_deleted(deleted);
        self.note_meta_changed();
        self.toast(if deleted { "ゴミ箱に移しました" } else { "ゴミ箱から戻しました" });
    }

    async fn save_dialog(&self, name: &str) -> Option<std::path::PathBuf> {
        let dialog = gtk::FileDialog::builder().initial_name(name).modal(true).build();
        dialog.save_future(Some(&self.ui.window)).await.ok().and_then(|f| f.path())
    }

    async fn export_note(self: Rc<Self>) {
        let Some(note) = self.state.borrow().current.clone() else { return };
        if let Some(date) = diary_date(note.id()) {
            if let Some(path) = self.save_dialog(&format!("{date}.txt")).await {
                match std::fs::write(&path, note.body()) {
                    Ok(()) => self.toast("書き出しました"),
                    Err(e) => self.toast(&format!("書き出せませんでした: {e}")),
                }
            }
            return;
        }
        let title = note.summary().title;
        let safe: String = title
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
            .take(80)
            .collect();
        let name = format!("{}.txt", if safe.trim().is_empty() { "untitled" } else { safe.trim() });
        if let Some(path) = self.save_dialog(&name).await {
            match std::fs::write(&path, note.body()) {
                Ok(()) => self.toast("書き出しました"),
                Err(e) => self.toast(&format!("書き出せませんでした: {e}")),
            }
        }
    }

    async fn export_all(self: Rc<Self>) {
        let Some(client) = self.client() else { return };
        let name = format!("notes-{}.zip", chrono::Local::now().format("%Y-%m-%d"));
        if let Some(path) = self.save_dialog(&name).await {
            match client.export_zip(path.to_string_lossy().into_owned(), false).await {
                Ok(()) => self.toast("書き出しました"),
                Err(e) => self.toast(&format!("書き出せませんでした: {e}")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn char_span_counts_characters() {
        assert_eq!(super::char_span("a😀b", "a😀Xb"), Some((2, 0, "X".into())));
        assert_eq!(super::char_span("日本語", "日語"), Some((1, 1, String::new())));
        assert_eq!(super::char_span("same", "same"), None);
    }
}
