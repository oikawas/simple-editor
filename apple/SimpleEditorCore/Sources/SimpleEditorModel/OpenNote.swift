import Foundation
import Observation
import SimpleEditorCore

/// The note shown in the editor.
@MainActor
@Observable
public final class OpenNote: Identifiable {
    public let id: String
    @ObservationIgnored let note: Note

    public private(set) var text: String
    /// The text view's selection, in UTF-16 offsets.
    public var selection: Range<Int> = 0..<0
    /// Increases whenever `text` (and `selection`) changed from outside the
    /// editor, so the view knows to push them into the text view.
    public private(set) var externalRevision = 0
    public private(set) var title = ""
    public private(set) var tags: [String] = []
    public private(set) var deleted = false
    public private(set) var createdAt: Date = .distantPast
    public private(set) var updatedAt: Date = .distantPast

    init(note: Note) {
        self.id = note.id()
        self.note = note
        self.text = note.body()
        reloadMeta()
    }

    /// The user typed: record the change.
    public func edit(_ newText: String) {
        guard newText != text else { return }
        text = newText
        note.setBody(body: newText)
        reloadMeta()
    }

    /// The editor's text went from `base` (what it last showed) to `edited`.
    /// Applies that change even if changes from other devices arrived
    /// meanwhile (say, while an input method was composing): the edited span
    /// is located in the current text by a diff, so neither change is lost.
    /// Afterwards `text` is the merged result and the cursor follows the edit.
    public func applyEdit(from base: String, to edited: String) {
        guard let (start, removed, inserted) = Self.differingSpan(base, edited) else { return }
        let current = note.body()
        let mapped = remapOffsets(
            old: base, new: current,
            offsets: [UInt32(start), UInt32(start + removed)]
        )
        note.editBody(start: mapped[0], delete: mapped[1] - min(mapped[0], mapped[1]), insert: inserted)
        let caret = Int(mapped[0]) + inserted.utf16.count
        text = note.body()
        selection = caret..<caret
        reloadMeta()
    }

    /// The span where two texts differ, in UTF-16 units: start, removed
    /// length, inserted text. It never splits a surrogate pair.
    static func differingSpan(_ old: String, _ new: String) -> (Int, Int, String)? {
        if old == new { return nil }
        let a = Array(old.utf16)
        let b = Array(new.utf16)
        var start = 0
        while start < a.count, start < b.count, a[start] == b[start] { start += 1 }
        if start > 0, start < a.count, UTF16.isTrailSurrogate(a[start]) { start -= 1 }
        var end = 0
        while end < a.count - start, end < b.count - start, a[a.count - 1 - end] == b[b.count - 1 - end] { end += 1 }
        if end > 0, end < a.count, UTF16.isTrailSurrogate(a[a.count - end]) { end -= 1 }
        let inserted = String(decoding: b[start..<(b.count - end)], as: UTF16.self)
        return (start, a.count - end - start, inserted)
    }

    /// Another device changed the note: take its text, keeping the selection
    /// where it was relative to the surrounding text.
    func applyRemote() {
        let newText = note.body()
        if newText != text {
            let mapped = remapOffsets(
                old: text, new: newText,
                offsets: [UInt32(selection.lowerBound), UInt32(selection.upperBound)]
            ).map(Int.init)
            selection = mapped[0]..<max(mapped[0], mapped[1])
            text = newText
            externalRevision += 1
        }
        reloadMeta()
    }

    public func addTag(_ tag: String) {
        if note.addTag(tag: tag) { reloadMeta() }
    }

    public func removeTag(_ tag: String) {
        note.removeTag(tag: tag)
        reloadMeta()
    }

    public func setDeleted(_ deleted: Bool) {
        note.setDeleted(deleted: deleted)
        reloadMeta()
    }

    public func restore(_ version: Version) {
        note.restore(version: version)
        applyRemote()
    }

    public var summary: NoteSummary { note.summary() }

    func reloadMeta() {
        let s = note.summary()
        title = s.title
        tags = s.tags
        deleted = s.deleted
        createdAt = Date(timeIntervalSince1970: Double(s.createdAt) / 1000)
        updatedAt = Date(timeIntervalSince1970: Double(s.updatedAt) / 1000)
    }
}
