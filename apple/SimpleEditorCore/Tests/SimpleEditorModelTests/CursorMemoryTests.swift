import XCTest
@testable import SimpleEditorModel

final class CursorMemoryTests: XCTestCase {
    private func memory() -> CursorMemory {
        CursorMemory(defaults: UserDefaults(suiteName: "se-test-\(UUID().uuidString)")!)
    }

    func testReturnsTheSavedSelection() {
        let m = memory()
        XCTAssertNil(m.load(id: "a", length: 100))
        m.save(id: "a", selection: 12..<20)
        XCTAssertEqual(m.load(id: "a", length: 100), 12..<20)
    }

    func testFitsTheSelectionToAShorterText() {
        let m = memory()
        m.save(id: "a", selection: 50..<80)
        XCTAssertEqual(m.load(id: "a", length: 60), 50..<60)
        XCTAssertEqual(m.load(id: "a", length: 10), 10..<10)
    }

    func testACursorAtTheStartIsNotKept() {
        let m = memory()
        m.save(id: "a", selection: 5..<5)
        m.save(id: "a", selection: 0..<0)
        XCTAssertNil(m.load(id: "a", length: 10))
    }

    func testDropsTheOldestBeyondTheLimit() {
        let m = memory()
        for i in 0...CursorMemory.limit {
            m.save(id: "n\(i)", selection: 1..<1, now: Date(timeIntervalSince1970: Double(i)))
        }
        XCTAssertNil(m.load(id: "n0", length: 10))
        XCTAssertEqual(m.load(id: "n1", length: 10), 1..<1)
        XCTAssertEqual(m.load(id: "n\(CursorMemory.limit)", length: 10), 1..<1)
    }
}
