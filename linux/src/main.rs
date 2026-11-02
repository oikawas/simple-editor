mod calendar;
mod config;
mod history;
mod settings_dialog;
mod window;

use adw::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

thread_local! {
    static APP: RefCell<Option<Rc<window::App>>> = const { RefCell::new(None) };
}

fn main() -> gtk::glib::ExitCode {
    let app = adw::Application::builder().application_id(config::APP_ID).build();
    app.connect_startup(|_| {
        // Installed with the .desktop file (see the README).
        gtk::Window::set_default_icon_name(config::APP_ID);
        let display = gtk::gdk::Display::default().expect("display");
        let css = gtk::CssProvider::new();
        css.load_from_string(&format!(
            ".chip {{ padding: 2px 10px; min-height: 24px; border-radius: 999px; font-size: 0.9em; }}\n{}",
            calendar::CSS
        ));
        gtk::style_context_add_provider_for_display(&display, &css, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        // Lighter weekend and holiday colors on a dark background, swapped with the theme.
        let dark = gtk::CssProvider::new();
        dark.load_from_string(calendar::CSS_DARK);
        let apply = move |manager: &adw::StyleManager| {
            if manager.is_dark() {
                gtk::style_context_add_provider_for_display(&display, &dark, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION + 1);
            } else {
                gtk::style_context_remove_provider_for_display(&display, &dark);
            }
        };
        let manager = adw::StyleManager::default();
        apply(&manager);
        manager.connect_dark_notify(apply);
    });
    app.connect_activate(|app| {
        if let Some(existing) = APP.with(|a| a.borrow().clone()) {
            existing.ui.window.present();
            return;
        }
        let window = window::build(app);
        window.ui.window.present();
        APP.with(|a| a.replace(Some(window)));
    });
    app.run()
}
