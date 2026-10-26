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
