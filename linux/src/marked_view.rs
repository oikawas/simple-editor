//! The editor's text view: a GtkTextView that also draws, below the text,
//! ruled lines and marks for spaces and line breaks. They are only drawn and
//! never part of the text.

use crate::config::RuledLines;
use gtk::glib;
use gtk::prelude::*;
use gtk::subclass::prelude::*;
use gtk::graphene;
use std::cell::Cell;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Decorations {
    pub ruled_lines: RuledLines,
    pub full_width_spaces: bool,
    pub half_width_spaces: bool,
    pub line_breaks: bool,
}

impl Decorations {
    fn marks_anything(&self) -> bool {
        self.full_width_spaces || self.half_width_spaces || self.line_breaks
    }
}

mod imp {
    use super::*;

    #[derive(Default)]
    pub struct MarkedTextView {
        pub decorations: Cell<Decorations>,
    }

    #[glib::object_subclass]
    impl ObjectSubclass for MarkedTextView {
        const NAME: &'static str = "SimpleEditorMarkedTextView";
        type Type = super::MarkedTextView;
        type ParentType = gtk::TextView;
    }

    impl ObjectImpl for MarkedTextView {}
    impl WidgetImpl for MarkedTextView {}

    impl TextViewImpl for MarkedTextView {
        fn snapshot_layer(&self, layer: gtk::TextViewLayer, snapshot: gtk::Snapshot) {
            self.parent_snapshot_layer(layer, snapshot.clone());
            let d = self.decorations.get();
            if layer == gtk::TextViewLayer::BelowText && (d.ruled_lines != RuledLines::None || d.marks_anything()) {
                draw(&self.obj(), &snapshot, d);
            }
        }
    }
}

glib::wrapper! {
    pub struct MarkedTextView(ObjectSubclass<imp::MarkedTextView>)
        @extends gtk::TextView, gtk::Widget,
        @implements gtk::Accessible, gtk::Buildable, gtk::ConstraintTarget, gtk::Scrollable;
}

impl MarkedTextView {
    pub fn new(buffer: &gtk::TextBuffer) -> Self {
        glib::Object::builder().property("buffer", buffer).build()
    }

    pub fn set_decorations(&self, d: Decorations) {
        if self.imp().decorations.replace(d) != d {
            self.queue_draw();
        }
    }
}

/// Draws in buffer coordinates, over what is in view.
fn draw(view: &MarkedTextView, snapshot: &gtk::Snapshot, d: Decorations) {
    let visible = view.visible_rect();
    let (top, bottom) = (visible.y(), visible.y() + visible.height());
    // Above the first line (the top margin) there is no text: start there.
    let mut row = view.iter_at_location(0, top.max(0)).unwrap_or_else(|| view.buffer().start_iter());
    view.backward_display_line_start(&mut row);
    let end = view.iter_at_location(0, bottom).map(|mut it| {
        view.forward_display_line_end(&mut it);
        it
    });
    let bounds = graphene::Rect::new(visible.x() as f32, top as f32, visible.width() as f32, visible.height() as f32);
    let cr = snapshot.append_cairo(&bounds);
    let fg = view.color();
    let left = view.left_margin() as f64;
    let right = (visible.x() + visible.width() - view.right_margin()) as f64;

    if d.ruled_lines != RuledLines::None {
        cr.set_source_rgba(fg.red() as f64, fg.green() as f64, fg.blue() as f64, 0.22);
        cr.set_line_width(0.5);
        cr.set_dash(
            match d.ruled_lines {
                RuledLines::Dashed => &[6.0, 4.0],
                RuledLines::Dotted => &[1.5, 2.5],
                _ => &[],
            },
            0.0,
        );
        // GTK does not say where a row's baseline is. Line height spreads its
        // extra space evenly above and below, so the baseline sits where it
        // would in the row's text laid out on its own, centered in the row.
        // The row's own text matters: Japanese comes from a fallback font
        // with other metrics. The title line is set bold and 1.2 times as large.
        let title = view.buffer().tag_table().lookup("title");
        let title_attrs = gtk::pango::AttrList::new();
        title_attrs.insert(gtk::pango::AttrFloat::new_scale(1.2));
        title_attrs.insert(gtk::pango::AttrInt::new_weight(gtk::pango::Weight::Bold));
        // A rule on the baseline of every display line, wrapped rows included.
        let mut it = row;
        loop {
            let r = view.iter_location(&it);
            // An empty line is its own display line end; moving on from it
            // would take the next line's text.
            let mut row_end = it;
            if !it.ends_line() && !view.forward_display_line_end(&mut row_end) {
                row_end = view.buffer().end_iter();
            }
            let text = it.visible_text(&row_end);
            let text = text.split('\n').next().unwrap_or_default();
            let layout = view.create_pango_layout(Some(if text.trim().is_empty() { "Ag" } else { text }));
            if title.as_ref().is_some_and(|t| it.has_tag(t)) {
                layout.set_attributes(Some(&title_attrs));
            }
            let (_, height) = layout.pixel_size();
            let baseline = layout.baseline() as f64 / gtk::pango::SCALE as f64;
            let y = r.y() as f64 + (r.height() - height) as f64 / 2.0 + baseline;
            cr.move_to(left, y);
            cr.line_to(right, y);
            let mut next = it;
            // This returns false on reaching the end of the text, though it
            // moved there (onto the empty line after a final line break).
            view.forward_display_line(&mut next);
            if next == it || r.y() + r.height() >= bottom {
                break;
            }
            it = next;
        }
        let _ = cr.stroke();
    }

    if d.marks_anything() {
        let alpha = 0.4;
        cr.set_source_rgba(fg.red() as f64, fg.green() as f64, fg.blue() as f64, alpha);
        cr.set_line_width(1.0);
        cr.set_dash(&[1.0, 1.5], 0.0);
        let mut it = row;
        let mut breaks = Vec::new();
        while end.as_ref().is_none_or(|e| it < *e) {
            let c = it.char();
            let space = (c == '\u{3000}' && d.full_width_spaces) || (c == ' ' && d.half_width_spaces);
            if space || (c == '\n' && d.line_breaks) {
                let r = view.iter_location(&it);
                if space {
                    let height = r.height() as f64 * 0.7;
                    let y = r.y() as f64 + (r.height() as f64 - height) / 2.0;
                    cr.rectangle(r.x() as f64 + 0.5, y, (r.width() as f64 - 1.0).max(1.0), height);
                } else {
                    breaks.push(r);
                }
            }
            if !it.forward_char() {
                break;
            }
        }
        let _ = cr.stroke();
        drop(cr);
        let mut color = fg;
        color.set_alpha(alpha as f32);
        let layout = view.create_pango_layout(Some("↵"));
        let (_, height) = layout.pixel_size();
        for r in breaks {
            snapshot.save();
            let y = r.y() + (r.height() - height) / 2;
            snapshot.translate(&graphene::Point::new(r.x() as f32 + 1.0, y as f32));
            snapshot.append_layout(&layout, &color);
            snapshot.restore();
        }
    }
}
