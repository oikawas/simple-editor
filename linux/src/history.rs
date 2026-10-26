//! Browsing a note's history and restoring a version.

use crate::window::{format_time_precise as format_date, App};
use adw::prelude::*;
use gtk::glib;
use simple_editor_core::api::Version;
use simple_editor_core::client::{Client, Note};
use simple_editor_core::diff::{line_diff, DiffKind};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

struct View {
    note: Arc<Note>,
    text: gtk::TextBuffer,
    meta: gtk::Label,
    restore: gtk::Button,
    diff_mode: gtk::ToggleButton,
    shown: RefCell<Option<Version>>,
    request: Cell<u32>,
}

impl View {
    fn render(&self) {
        let buffer = &self.text;
        buffer.set_text("");
        let Some(v) = self.shown.borrow().clone() else {
            self.meta.set_label("");
            self.restore.set_sensitive(false);
            return;
        };
        self.restore.set_sensitive(true);
        let tags = if v.tags.is_empty() { "なし".to_owned() } else { v.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ") };
        self.meta.set_label(&format!("{} の版　タグ: {}", format_date(v.saved_at), tags));
        let diff = if self.diff_mode.is_active() { line_diff(self.note.body(), v.body.clone()) } else { None };
        let mut end = buffer.end_iter();
        match diff {
            Some(lines) if lines.iter().all(|l| l.kind == DiffKind::Same) => {
                buffer.insert_with_tags_by_name(&mut end, "現在の本文と同じです", &["notice"]);
            }
            Some(lines) => {
                buffer.insert_with_tags_by_name(&mut end, "＋ 戻すと加わる行　− 戻すと消える行\n", &["notice"]);
                for line in lines {
                    let mut end = buffer.end_iter();
                    match line.kind {
                        DiffKind::Same => buffer.insert(&mut end, &format!("  {}\n", line.text)),
                        DiffKind::Added => buffer.insert_with_tags_by_name(&mut end, &format!("+ {}\n", line.text), &["added"]),
                        DiffKind::Removed => buffer.insert_with_tags_by_name(&mut end, &format!("− {}\n", line.text), &["removed"]),
                    }
                }
            }
            None => {
                if self.diff_mode.is_active() {
                    buffer.insert_with_tags_by_name(&mut end, "差分を表示するには大きすぎるため、全文を表示しています\n", &["notice"]);
                }
                let mut end = buffer.end_iter();
                buffer.insert(&mut end, &v.body);
            }
        }
    }
}

pub fn open(app: &Rc<App>, client: Arc<Client>, note: Arc<Note>) {
    let text = gtk::TextBuffer::new(None);
    text.create_tag(Some("added"), &[("paragraph-background", &"rgba(46,160,67,0.18)")]);
    text.create_tag(Some("removed"), &[("paragraph-background", &"rgba(248,81,73,0.18)"), ("strikethrough", &true)]);
    text.create_tag(Some("notice"), &[("foreground", &"gray"), ("scale", &0.9f64)]);
    let text_view = gtk::TextView::builder()
        .buffer(&text)
        .editable(false)
        .cursor_visible(false)
        .wrap_mode(gtk::WrapMode::WordChar)
        .left_margin(12)
        .right_margin(12)
        .top_margin(8)
        .build();
    let meta = gtk::Label::builder().xalign(0.0).margin_start(12).margin_top(8).build();
    meta.add_css_class("dim-label");
    meta.add_css_class("caption");

    let diff_mode = gtk::ToggleButton::builder().label("現在との差分").active(true).build();
    let full_mode = gtk::ToggleButton::builder().label("この版の全文").group(&diff_mode).build();
    let modes = gtk::Box::new(gtk::Orientation::Horizontal, 0);
    modes.add_css_class("linked");
    modes.append(&diff_mode);
    modes.append(&full_mode);
    let restore = gtk::Button::builder().label("この版に戻す").sensitive(false).build();
    restore.add_css_class("suggested-action");
    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(&modes));
    header.pack_end(&restore);

    let versions = gtk::ListBox::new();
    versions.add_css_class("navigation-sidebar");
    let versions_scroll = gtk::ScrolledWindow::builder().child(&versions).width_request(240).build();
    let right = gtk::Box::new(gtk::Orientation::Vertical, 0);
    right.append(&meta);
    right.append(&gtk::ScrolledWindow::builder().child(&text_view).vexpand(true).hexpand(true).build());
    let paned = gtk::Paned::builder().start_child(&versions_scroll).end_child(&right).position(260).build();
    let hint = gtk::Label::builder()
        .label("戻すと、本文とタグがこの版の内容に置き換わります。置き換える前の内容も履歴に残ります。")
        .wrap(true)
        .xalign(0.0)
        .margin_start(12)
        .margin_end(12)
        .margin_top(6)
        .margin_bottom(8)
        .build();
    hint.add_css_class("dim-label");
    hint.add_css_class("caption");
    let body = gtk::Box::new(gtk::Orientation::Vertical, 0);
    body.append(&paned);
    body.append(&hint);
    paned.set_vexpand(true);
    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&header);
    toolbar.set_content(Some(&body));
    let dialog = adw::Dialog::builder().title("編集履歴").content_width(900).content_height(620).child(&toolbar).build();

    let view = Rc::new(View {
        note: note.clone(),
        text,
        meta,
        restore: restore.clone(),
        diff_mode: diff_mode.clone(),
        shown: RefCell::new(None),
        request: Cell::new(0),
    });
    {
        let view = view.clone();
        diff_mode.connect_toggled(move |_| view.render());
    }
    {
        let (view, app, dialog) = (view.clone(), app.clone(), dialog.clone());
        restore.connect_clicked(move |_| {
            if let Some(v) = view.shown.borrow().clone() {
                view.note.restore(v);
                app.reload_current();
                dialog.close();
                app.toast("この版に戻しました");
            }
        });
    }
    {
        let (view, client, note) = (view.clone(), client.clone(), note.clone());
        versions.connect_row_activated(move |_, row| {
            let Ok(version_id) = row.widget_name().parse::<i64>() else { return };
            let request = view.request.get() + 1;
            view.request.set(request);
            let (view, client, note_id) = (view.clone(), client.clone(), note.id());
            glib::spawn_future_local(async move {
                let result = client.version(note_id, version_id).await;
                if view.request.get() != request {
                    return; // a newer selection is on its way
                }
                *view.shown.borrow_mut() = result.ok();
                view.render();
            });
        });
    }

    let (app_ref, versions_ref) = (app.clone(), versions.clone());
    glib::spawn_future_local(async move {
        match client.versions(note.id()).await {
            Ok(list) if list.is_empty() => {
                versions_ref.append(&gtk::Label::new(Some("まだ履歴がありません")));
            }
            Ok(list) => {
                for (i, v) in list.iter().enumerate() {
                    let when = gtk::Label::builder()
                        .label(format!("{}{}", format_date(v.saved_at), if i == 0 { "（最新）" } else { "" }))
                        .xalign(0.0)
                        .build();
                    when.add_css_class("heading");
                    let what = gtk::Label::builder()
                        .label(format!("{} · {} 文字", if v.title.is_empty() { "（無題）" } else { &v.title }, v.length))
                        .xalign(0.0)
                        .ellipsize(gtk::pango::EllipsizeMode::End)
                        .build();
                    what.add_css_class("dim-label");
                    let b = gtk::Box::new(gtk::Orientation::Vertical, 2);
                    b.set_margin_top(4);
                    b.set_margin_bottom(4);
                    b.append(&when);
                    b.append(&what);
                    let row = gtk::ListBoxRow::builder().child(&b).name(v.id.to_string()).build();
                    versions_ref.append(&row);
                }
                // The newest version is usually what is on screen; start with the one before it.
                let index = if list.len() > 1 { 1 } else { 0 };
                if let Some(row) = versions_ref.row_at_index(index) {
                    versions_ref.select_row(Some(&row));
                    row.emit_activate();
                }
            }
            Err(e) => {
                versions_ref.append(&gtk::Label::new(Some("履歴を読み込めませんでした")));
                app_ref.toast(&format!("履歴を読み込めませんでした: {e}"));
            }
        }
    });

    dialog.present(Some(&app.ui.window));
}
