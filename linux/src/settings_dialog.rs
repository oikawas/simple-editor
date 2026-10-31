//! Registering this device, renaming it, and managing registered devices.

use crate::config::{self, Settings};
use crate::window::App;
use adw::prelude::*;
use gtk::glib;
use simple_editor_core::client::register_device;
use simple_editor_core::error::CoreError;
use std::rc::Rc;

fn describe(e: &CoreError, registering: bool) -> String {
    match e {
        CoreError::Unauthorized if registering => "登録用トークンが違います。".into(),
        CoreError::Unauthorized => "この端末の登録が無効になっています。".into(),
        CoreError::RateLimited { retry_after_secs } => format!(
            "失敗が続いたため、一時的に受け付けを停止しています。{} 分ほど待ってから試してください。",
            retry_after_secs.div_ceil(60)
        ),
        CoreError::Network { message } => {
            format!("サーバーに接続できません。URL とネットワークを確認してください。\n（{message}）")
        }
        other => format!("エラー: {other}"),
    }
}

fn normalize_url(raw: &str) -> String {
    let url = raw.trim().trim_end_matches('/');
    if url.contains("://") {
        url.to_owned()
    } else {
        format!("https://{url}")
    }
}

pub fn open(app: &Rc<App>, message: Option<&str>) {
    let settings = app.settings();
    let registered = app.client().is_some();
    let dialog = adw::PreferencesDialog::builder().title("設定").content_height(560).build();
    let page = adw::PreferencesPage::new();
    dialog.add(&page);

    let server = adw::PreferencesGroup::builder().title("サーバー").build();
    if let Some(m) = message {
        server.set_description(Some(m));
    }
    let url_row = adw::EntryRow::builder()
        .title("サーバー URL")
        .text(if settings.server_url.is_empty() { "https://" } else { &settings.server_url })
        .build();
    let name_row = adw::EntryRow::builder().title("この端末の名前").text(&settings.device_name).build();
    let token_row = adw::PasswordEntryRow::builder().title("登録用トークン").build();
    let register_button = gtk::Button::builder().label("登録").valign(gtk::Align::Center).build();
    register_button.add_css_class("suggested-action");
    let register_row = adw::ActionRow::builder()
        .title("この端末を登録")
        .subtitle("登録用トークン（サーバーの AUTH_TOKEN）は登録に一度だけ使い、保存しません")
        .build();
    register_row.add_suffix(&register_button);
    server.add(&url_row);
    server.add(&name_row);
    server.add(&token_row);
    server.add(&register_row);
    page.add(&server);

    page.add(&display_group(app));

    let devices = adw::PreferencesGroup::builder().title("登録済みの端末").build();
    page.add(&devices);

    // Registration is needed when this device has no token, or for another server.
    let update = {
        let (url_row, token_row, register_row, devices) =
            (url_row.clone(), token_row.clone(), register_row.clone(), devices.clone());
        let current_url = settings.server_url.clone();
        move || {
            let needs = !registered || normalize_url(&url_row.text()) != current_url;
            token_row.set_visible(needs);
            register_row.set_visible(needs);
            devices.set_visible(!needs);
        }
    };
    update();
    url_row.connect_changed(move |_| update());

    // Renaming applies right away once registered.
    if registered {
        name_row.set_show_apply_button(true);
        let app = app.clone();
        let dialog_ref = dialog.clone();
        name_row.connect_apply(move |row| {
            let name = row.text().trim().to_owned();
            let (app, dialog) = (app.clone(), dialog_ref.clone());
            glib::spawn_future_local(async move {
                let Some(client) = app.client() else { return };
                match client.rename_this_device(name.clone()).await {
                    Ok(()) => {
                        let mut s = app.settings();
                        s.device_name = name;
                        s.save();
                        app.set_settings(s);
                        dialog.add_toast(adw::Toast::new("名前を変更しました"));
                        load_devices(&app, &dialog, &devices_group(&dialog));
                    }
                    Err(e) => dialog.add_toast(adw::Toast::new(&describe(&e, false))),
                }
            });
        });
    }

    {
        let app = app.clone();
        let dialog_ref = dialog.clone();
        let (url_row, name_row, token_row) = (url_row.clone(), name_row.clone(), token_row.clone());
        register_button.connect_clicked(move |button| {
            let server_url = normalize_url(&url_row.text());
            let name = Some(name_row.text().trim().to_owned()).filter(|n| !n.is_empty()).unwrap_or_else(config::default_device_name);
            let token = token_row.text().trim().to_owned();
            let (app, dialog, button) = (app.clone(), dialog_ref.clone(), button.clone());
            button.set_sensitive(false);
            glib::spawn_future_local(async move {
                match register_device(server_url.clone(), token, name.clone()).await {
                    Ok(creds) => {
                        let settings = Settings {
                            server_url: server_url.clone(),
                            device_id: creds.id,
                            device_name: name,
                            ..app.settings()
                        };
                        settings.save();
                        config::save_token(&server_url, &creds.token).await;
                        app.set_settings(settings);
                        app.connect(creds.token);
                        dialog.close();
                        app.toast("この端末を登録しました");
                    }
                    Err(e) => dialog.add_toast(adw::Toast::new(&describe(&e, true))),
                }
                button.set_sensitive(true);
            });
        });
    }

    if registered {
        load_devices(app, &dialog, &devices);
    }
    devices.set_widget_name("devices");
    dialog.present(Some(&app.ui.window));
}

fn devices_group(dialog: &adw::PreferencesDialog) -> adw::PreferencesGroup {
    // The group is the page's last child; find it by name to rebuild its rows.
    let mut widget = dialog.first_child();
    while let Some(w) = widget {
        if let Some(found) = find_named(&w, "devices") {
            return found.downcast().unwrap();
        }
        widget = w.next_sibling();
    }
    unreachable!("devices group")
}

fn find_named(widget: &gtk::Widget, name: &str) -> Option<gtk::Widget> {
    if widget.widget_name() == name {
        return Some(widget.clone());
    }
    let mut child = widget.first_child();
    while let Some(c) = child {
        if let Some(found) = find_named(&c, name) {
            return Some(found);
        }
        child = c.next_sibling();
    }
    None
}

fn load_devices(app: &Rc<App>, dialog: &adw::PreferencesDialog, group: &adw::PreferencesGroup) {
    let (app, dialog, group) = (app.clone(), dialog.clone(), group.clone());
    glib::spawn_future_local(async move {
        let Some(client) = app.client() else { return };
        let list = match client.devices().await {
            Ok(list) => list,
            Err(e) => {
                group.set_description(Some(&describe(&e, false)));
                return;
            }
        };
        group.set_description(None);
        // Rows added earlier hang off a private list box; rebuild the group's rows.
        for row in group_rows(&group) {
            group.remove(&row);
        }
        for d in list {
            let title = if d.current { format!("{}（この端末）", d.name) } else { d.name.clone() };
            let row = adw::ActionRow::builder()
                .title(glib::markup_escape_text(&title).as_str())
                .subtitle(format!(
                    "最終接続 {} · 登録 {}",
                    crate::window::format_date_pub(d.last_seen_at),
                    crate::window::format_date_pub(d.created_at)
                ))
                .build();
            let revoke = gtk::Button::builder().label("登録解除").valign(gtk::Align::Center).build();
            revoke.add_css_class("destructive-action");
            let (app_c, dialog_c, group_c) = (app.clone(), dialog.clone(), group.clone());
            revoke.connect_clicked(move |_| {
                let (app, dialog, group, d) = (app_c.clone(), dialog_c.clone(), group_c.clone(), d.clone());
                glib::spawn_future_local(async move {
                    let body = if d.current {
                        "この端末の登録を解除しますか？ もう一度使うには登録用トークンが必要です。".to_owned()
                    } else {
                        format!("「{}」の登録を解除しますか？ その端末はすぐに同期できなくなります。", d.name)
                    };
                    let alert = adw::AlertDialog::new(Some("登録解除"), Some(&body));
                    alert.add_responses(&[("cancel", "キャンセル"), ("revoke", "登録解除")]);
                    alert.set_response_appearance("revoke", adw::ResponseAppearance::Destructive);
                    alert.set_default_response(Some("cancel"));
                    if alert.choose_future(Some(&dialog)).await != "revoke" {
                        return;
                    }
                    let Some(client) = app.client() else { return };
                    match client.revoke_device(d.id.clone()).await {
                        Ok(()) if d.current => {
                            dialog.close();
                            app.forget_registration("この端末の登録を解除しました。");
                        }
                        Ok(()) => load_devices(&app, &dialog, &group),
                        Err(e) => dialog.add_toast(adw::Toast::new(&describe(&e, false))),
                    }
                });
            });
            row.add_suffix(&revoke);
            group.add(&row);
        }
    });
}

/// The rows previously added to a preferences group.
fn group_rows(group: &adw::PreferencesGroup) -> Vec<gtk::Widget> {
    let mut rows = Vec::new();
    collect_rows(group.upcast_ref(), &mut rows);
    rows
}

fn collect_rows(widget: &gtk::Widget, rows: &mut Vec<gtk::Widget>) {
    let mut child = widget.first_child();
    while let Some(c) = child {
        if c.is::<adw::ActionRow>() {
            rows.push(c.clone());
        } else {
            collect_rows(&c, rows);
        }
        child = c.next_sibling();
    }
}

/// The editor font (typeface and size) and line height, kept on this device.
fn display_group(app: &Rc<App>) -> adw::PreferencesGroup {
    let group = adw::PreferencesGroup::builder().title("表示").build();
    let button = gtk::FontDialogButton::new(Some(gtk::FontDialog::builder().title("本文のフォント").build()));
    button.set_valign(gtk::Align::Center);
    button.set_font_desc(&current_font(&app.settings()));
    let reset = gtk::Button::builder().label("標準に戻す").valign(gtk::Align::Center).build();
    reset.add_css_class("flat");
    let row = adw::ActionRow::builder()
        .title("本文のフォント")
        .subtitle("書体と大きさ。この端末だけの設定で、すぐに反映されます")
        .build();
    row.add_suffix(&reset);
    row.add_suffix(&button);
    group.add(&row);

    let line_height = adw::SpinRow::builder()
        .title("行間")
        .subtitle("文字の大きさに対する行の高さ（標準は 1.2）")
        .adjustment(&gtk::Adjustment::new(app.settings().line_height(), 1.0, 3.0, 0.1, 0.5, 0.0))
        .digits(1)
        .build();
    {
        let app = app.clone();
        line_height.connect_value_notify(move |row| {
            let mut settings = app.settings();
            settings.line_height = (row.value() * 10.0).round() / 10.0;
            settings.save();
            app.set_settings(settings);
            app.apply_font();
        });
    }
    group.add(&line_height);

    // Set while the button is updated in code, so that is not saved as a choice.
    let resetting = Rc::new(std::cell::Cell::new(false));
    {
        let (app, resetting) = (app.clone(), resetting.clone());
        button.connect_font_desc_notify(move |button| {
            if resetting.get() {
                return;
            }
            if let Some(desc) = button.font_desc() {
                save_font(&app, desc.to_string());
            }
        });
    }
    {
        let (app, button) = (app.clone(), button.clone());
        reset.connect_clicked(move |_| {
            save_font(&app, String::new());
            resetting.set(true);
            button.set_font_desc(&current_font(&app.settings()));
            resetting.set(false);
        });
    }
    group
}

fn current_font(settings: &Settings) -> gtk::pango::FontDescription {
    if !settings.font.is_empty() {
        return gtk::pango::FontDescription::from_string(&settings.font);
    }
    let system = gtk::Settings::default().and_then(|s| s.gtk_font_name()).map(|n| n.to_string());
    gtk::pango::FontDescription::from_string(system.as_deref().unwrap_or("Sans 11"))
}

fn save_font(app: &Rc<App>, font: String) {
    let mut settings = app.settings();
    settings.font = font;
    settings.save();
    app.set_settings(settings);
    app.apply_font();
}
