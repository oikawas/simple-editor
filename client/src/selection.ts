// The selection drawn as tall as the text, not the line: CodeMirror's own
// selection fills whole lines, line spacing included. This asks the browser
// for the boxes of the selected text, which are as tall as the font, and
// fills those; a selected line break fills from the end of its line to the
// right edge at the same height. CodeMirror's selection layer is hidden in
// style.css; its caret is already as tall as the text.

import { EditorView, RectangleMarker, layer } from "@codemirror/view";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// The origin CodeMirror positions layer markers from.
function base(view: EditorView): { left: number; top: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

// The boxes of the text between two positions: text nodes only, since an
// element wholly inside the range (a line) would report its full height.
function textBoxes(view: EditorView, from: number, to: number): Box[] {
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const boxes: Box[] = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let node = walker.currentNode; node; node = walker.nextNode() as Node) {
    if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) continue;
    // Text inside widgets (the marks) is not part of the note.
    if (!node.parentElement?.closest(".cm-line") || node.parentElement.closest(".cm-line-break")) continue;
    const part = document.createRange();
    part.selectNodeContents(node);
    if (node === range.startContainer) part.setStart(node, range.startOffset);
    if (node === range.endContainer) part.setEnd(node, range.endOffset);
    for (const r of part.getClientRects()) if (r.width > 0 && r.height > 0) boxes.push(r);
  }
  return boxes;
}

export const bandSelection = layer({
  above: false,
  class: "cm-bandSelectionLayer",
  update: (u) => u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged,
  markers(view) {
    const origin = base(view);
    const content = view.contentDOM.getBoundingClientRect();
    const right = content.right - parseFloat(getComputedStyle(view.contentDOM).paddingRight || "0");
    const markers: RectangleMarker[] = [];
    const add = (b: Box) =>
      markers.push(
        new RectangleMarker(
          "cm-bandSelection",
          (b.left - origin.left) / view.scaleX,
          (b.top - origin.top) / view.scaleY,
          (b.right - b.left) / view.scaleX,
          (b.bottom - b.top) / view.scaleY,
        ),
      );
    const doc = view.state.doc;
    for (const sel of view.state.selection.ranges) {
      const from = Math.max(sel.from, view.viewport.from);
      const to = Math.min(sel.to, view.viewport.to);
      if (from >= to) continue;
      textBoxes(view, from, to).forEach(add);
      // Selected line breaks: from the end of the line to the right edge.
      for (let line = doc.lineAt(from); line.to < to; line = doc.line(line.number + 1)) {
        const end = view.coordsAtPos(line.to, -1);
        if (end && end.right < right) add({ left: end.right, top: end.top, right, bottom: end.bottom });
      }
    }
    return markers;
  },
});
