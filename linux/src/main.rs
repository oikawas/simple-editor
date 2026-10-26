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
        let css = gtk::CssProvider::new();
        css.load_from_string(
            ".chip { padding: 2px 10px; min-height: 24px; border-radius: 999px; font-size: 0.9em; }",
        );
        gtk::style_context_add_provider_for_display(
            &gtk::gdk::Display::default().expect("display"),
            &css,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
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
