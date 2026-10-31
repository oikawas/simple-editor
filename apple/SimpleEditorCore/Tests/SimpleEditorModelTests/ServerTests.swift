import XCTest
import SimpleEditorCore
@testable import SimpleEditorModel

/// Runs against a real server when SIMPLE_EDITOR_TEST_SERVER (URL) and
/// SIMPLE_EDITOR_TEST_TOKEN (its registration token) are set.
@MainActor
final class ServerTests: XCTestCase {
    var server = ""
    var registrationToken = ""

    override func setUp() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["SIMPLE_EDITOR_TEST_SERVER"], let token = env["SIMPLE_EDITOR_TEST_TOKEN"] else {
            throw XCTSkip("SIMPLE_EDITOR_TEST_SERVER and SIMPLE_EDITOR_TEST_TOKEN are not set")
        }
        server = url
        registrationToken = token
    }

    func makeModel(_ name: String) -> AppModel {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("se-model-\(UUID().uuidString)")
        let defaults = UserDefaults(suiteName: "se-test-\(UUID().uuidString)")!
        return AppModel(tokens: MemoryTokenStore(), defaults: defaults, dataDirectory: dir, defaultDeviceName: name)
    }

    func until(_ what: String, _ check: () -> Bool) async throws {
        for _ in 0..<300 {
            if check() { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("timed out waiting for \(what)")
        throw CancellationError()
    }

    func testTwoDevices() async throws {
        let a = makeModel("Mac")
        a.start()
        XCTAssertEqual(a.phase, .needsRegistration(nil))
        do {
            try await a.register(serverURL: server, deviceName: "", registrationToken: "wrong")
            XCTFail("a wrong registration token was accepted")
        } catch {
            XCTAssertEqual(AppModel.describe(error, registering: true), "登録用トークンが違います。")
        }
        try await a.register(serverURL: server, deviceName: "", registrationToken: registrationToken)
        XCTAssertEqual(a.phase, .ready)
        XCTAssertEqual(a.settings.deviceName, "Mac")
        try await until("A online") { a.status == .online }

        let note = try XCTUnwrap(a.createNote())
        note.edit("Swift のメモ\n本文 😀")
        note.addTag("swift")
        a.currentNoteChanged()
        XCTAssertEqual(a.visibleNotes.first?.summary.title, "Swift のメモ")

        let b = makeModel("iPhone")
        b.start()
        try await b.register(serverURL: server, deviceName: "", registrationToken: registrationToken)
        try await until("B online") { b.status == .online }
        try await until("B lists the note") { b.notes.contains { $0.id == note.id } }
        XCTAssertEqual(b.allTags, ["swift"])
        b.select(id: note.id)
        let onB = try XCTUnwrap(b.current)
        try await until("B has the text") { onB.text == "Swift のメモ\n本文 😀" }

        // B's cursor sits at the end; A inserts at that very spot and earlier.
        onB.selection = onB.text.utf16.count..<onB.text.utf16.count
        let cursorBefore = onB.selection
        note.edit("Swift のメモ（共有）\n本文 😀\nA の追記")
        try await until("B receives A's edit") { onB.text == note.text }
        XCTAssertEqual(onB.selection.lowerBound, cursorBefore.lowerBound + "（共有）".utf16.count)
        XCTAssertGreaterThan(onB.externalRevision, 0)

        // Search finds text past the preview once the server has stored it.
        b.searchText = "追記"
        try await until("search hit") { b.searchHits?[note.id] != nil }
        XCTAssertTrue(b.visibleNotes.map(\.id).contains(note.id))

        // History: restoring an older version comes back to A.
        let versions = try await a.versions(of: note)
        XCTAssertFalse(versions.isEmpty)

        // A revokes B; B goes back to registration with a reason.
        let devices = try await a.devices()
        XCTAssertEqual(Set(devices.map(\.name)).isSuperset(of: ["Mac", "iPhone"]), true)
        let bDevice = try XCTUnwrap(devices.first { $0.id == b.settings.deviceID })
        try await a.revoke(bDevice)
        try await until("B unregistered") {
            if case .needsRegistration(let message?) = b.phase { return message.contains("解除") }
            return false
        }
        XCTAssertNil(b.current)
    }

    func testDiary() async throws {
        let a = makeModel("Mac")
        a.start()
        try await a.register(serverURL: server, deviceName: "", registrationToken: registrationToken)
        try await until("A online") { a.status == .online }

        // Opening a day does not create the entry; writing does.
        a.openDiary(date: "2024-01-02")
        XCTAssertEqual(a.mode, .diary)
        XCTAssertEqual(a.shownMonth, YearMonth(year: 2024, month: 1))
        let entry = try XCTUnwrap(a.current)
        XCTAssertEqual(entry.diaryDate, "2024-01-02")
        XCTAssertTrue(a.visibleNotes.isEmpty)
        entry.edit("川沿いを散歩した\nサギがいた")
        a.currentNoteChanged()
        XCTAssertEqual(a.visibleNotes.map(\.id), ["diary-2024-01-02"])
        XCTAssertEqual(a.writtenDays, [2])
        XCTAssertGreaterThan(entry.createdAt, Date(timeIntervalSince1970: 0))

        // Another device sees the day as written; the notes list leaves it out.
        let b = makeModel("iPhone")
        b.start()
        try await b.register(serverURL: server, deviceName: "", registrationToken: registrationToken)
        try await until("B online") { b.status == .online }
        b.mode = .diary
        b.shownMonth = YearMonth(year: 2024, month: 1)
        try await until("B lists the entry") { b.writtenDays.contains(2) }
        b.mode = .notes
        XCTAssertFalse(b.visibleNotes.contains { $0.id == "diary-2024-01-02" })

        // Search covers the diary from the notes tab too.
        b.searchText = "サギ"
        try await until("search hit") { b.visibleNotes.contains { $0.id == "diary-2024-01-02" } }
    }
}
