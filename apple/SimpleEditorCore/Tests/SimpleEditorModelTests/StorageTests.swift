import XCTest
import SimpleEditorCore
@testable import SimpleEditorModel

final class StorageTests: XCTestCase {
    func testServerURLNormalization() {
        XCTAssertEqual(normalizeServerURL(" 192.168.1.10/ "), "https://192.168.1.10")
        XCTAssertEqual(normalizeServerURL("http://localhost:8080"), "http://localhost:8080")
    }

    func testSettingsRoundTrip() {
        let defaults = UserDefaults(suiteName: "se-test-\(UUID().uuidString)")!
        let settings = StoredSettings(serverURL: "https://a", deviceID: "id", deviceName: "Mac")
        settings.save(to: defaults)
        XCTAssertEqual(StoredSettings.load(from: defaults), settings)
    }

    func testMemoryTokenStore() throws {
        let store = MemoryTokenStore()
        try store.save(server: "s", token: "t")
        XCTAssertEqual(store.load(server: "s"), "t")
        store.delete(server: "s")
        XCTAssertNil(store.load(server: "s"))
    }

    func testCoreRemapsSelectionAcrossSeveralEdits() {
        // The cursor at the end stays before text appended right there.
        let old = "Title\nbody"
        let new = "Title (x)\nbody\nmore"
        let end = UInt32(old.utf16.count)
        XCTAssertEqual(remapOffsets(old: old, new: new, offsets: [end]), [end + 4])
    }
}
