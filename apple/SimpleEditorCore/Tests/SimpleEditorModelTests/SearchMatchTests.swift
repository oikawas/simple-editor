import Foundation
import XCTest
@testable import SimpleEditorModel

final class SearchMatchTests: XCTestCase {
    func testFindsEveryWordIgnoringCase() {
        let text = "Hello world, hello 世界。HELLO"
        XCTAssertEqual(
            SearchMatch.ranges(of: "hello", in: text),
            [NSRange(location: 0, length: 5), NSRange(location: 13, length: 5), NSRange(location: 22, length: 5)]
        )
        XCTAssertEqual(SearchMatch.ranges(of: " 世界  world ", in: text), [NSRange(location: 6, length: 5), NSRange(location: 19, length: 2)])
    }

    func testMergesOverlapsAndCountsUTF16() {
        // "ab" and "bc" overlap in "abc"; the emoji takes two UTF-16 units.
        XCTAssertEqual(SearchMatch.ranges(of: "ab bc", in: "😀abc"), [NSRange(location: 2, length: 3)])
    }

    func testEmptyQueriesAndLimits() {
        XCTAssertEqual(SearchMatch.ranges(of: "  ", in: "text"), [])
        XCTAssertEqual(SearchMatch.ranges(of: "a", in: String(repeating: "a", count: 50), limit: 10).count, 10)
    }
}
