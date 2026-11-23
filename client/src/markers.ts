// Marks for spaces and line breaks in the editor. They are always added, and
// CSS shows them only when the display settings ask for them (see
// applyDisplay), so turning them on or off needs no change to the editor.

import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";

// Each space gets a mark of its own: equal marks next to each other would be
// joined into one element, and a run of spaces would show as one box.
const spaces = new MatchDecorator({
  regexp: /[ 　]/g,
  decoration: (m, _view, pos) =>
    Decoration.mark({
      class: m[0] === " " ? "cm-half-space" : "cm-full-space",
      attributes: { "data-at": String(pos) },
    }),
});

const spaceMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = spaces.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = spaces.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

class LineBreakWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-line-break";
    span.textContent = "↵";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

const lineBreak = Decoration.widget({ widget: new LineBreakWidget(), side: 1 });

function lineBreaks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  let last = -1; // visible ranges can share a line
  for (const { from, to } of view.visibleRanges) {
    let line = doc.lineAt(from);
    while (true) {
      // Every line but the last ends with a line break.
      if (line.number < doc.lines && line.to > last) {
        builder.add(line.to, line.to, lineBreak);
        last = line.to;
      }
      if (line.to >= to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  }
  return builder.finish();
}

const lineBreakMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = lineBreaks(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = lineBreaks(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

export const markers = [spaceMarks, lineBreakMarks];
