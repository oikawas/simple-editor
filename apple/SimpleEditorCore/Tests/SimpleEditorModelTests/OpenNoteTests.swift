import XCTest
import SimpleEditorCore
@testable import SimpleEditorModel

/// Edits merged with changes that arrived while the editor was not looking,
/// using an offline client (no server needed).
@MainActor
final class OpenNoteTests: XCTestCase {
    func makeNote() throws -> OpenNote {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("se-open-\(UUID().uuidString)")
        let config = ClientConfig(serverUrl: "http://127.0.0.1:9", deviceToken: "offline", dataDir: dir.path)
        let client = try Client(config: config, listener: NoopListener())
        return OpenNote(note: try client.createNote())
    }

    func testEditWithoutRemoteChanges() throws {
        let note = try makeNote()
        note.applyEdit(from: "", to: "日本語の入力")
        XCTAssertEqual(note.text, "日本語の入力")
        XCTAssertEqual(note.selection, 6..<6)
    }

    func testEditMergesWithAChangeThatArrivedMeanwhile() throws {
        let note = try makeNote()
        note.applyEdit(from: "", to: "Hello world")
        // Another device inserts a word while the user is composing at the end.
        note.note.setBody(body: "Hello brave world")
        note.applyEdit(from: "Hello world", to: "Hello world、変換した")
        XCTAssertEqual(note.text, "Hello brave world、変換した")
        XCTAssertEqual(note.selection.lowerBound, note.text.utf16.count)
        // A deletion made against the old text lands in the right place too.
        note.note.setBody(body: "X Hello brave world、変換した")
        note.applyEdit(from: "Hello brave world、変換した", to: "Hello world、変換した")
        XCTAssertEqual(note.text, "X Hello world、変換した")
    }

    func testDifferingSpanKeepsSurrogatePairsWhole() {
        let span = OpenNote.differingSpan("a😀b", "a😃b")
        XCTAssertEqual(span?.0, 1)
        XCTAssertEqual(span?.1, 2)
        XCTAssertEqual(span?.2, "😃")
    }
}

final class NoopListener: ClientListener, @unchecked Sendable {
    func onStatus(status: SyncStatus) {}
    func onNotesChanged() {}
    func onNoteChanged(id: String) {}
}
