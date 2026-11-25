import XCTest
@testable import SimpleEditorModel

final class CreatedFilterTests: XCTestCase {
    let tokyo: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return c
    }()

    func ms(_ y: Int, _ m: Int, _ d: Int, _ h: Int = 12) -> Int64 {
        let date = tokyo.date(from: DateComponents(year: y, month: m, day: d, hour: h))!
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    func testMatchesTheYearAndMonthInLocalTime() {
        let nov = ms(2025, 11, 15)
        XCTAssertTrue(CreatedFilter().matches(createdAt: nov, calendar: tokyo))
        XCTAssertTrue(CreatedFilter(year: 2025).matches(createdAt: nov, calendar: tokyo))
        XCTAssertTrue(CreatedFilter(month: 11).matches(createdAt: nov, calendar: tokyo))
        XCTAssertTrue(CreatedFilter(year: 2025, month: 11).matches(createdAt: nov, calendar: tokyo))
        XCTAssertFalse(CreatedFilter(year: 2024).matches(createdAt: nov, calendar: tokyo))
        XCTAssertFalse(CreatedFilter(year: 2025, month: 10).matches(createdAt: nov, calendar: tokyo))
        // Just after midnight on the 1st, local time (still October in UTC).
        XCTAssertTrue(CreatedFilter(month: 11).matches(createdAt: ms(2025, 11, 1, 0), calendar: tokyo))
    }

    func testANoteWithoutACreationTimeMatchesOnlyNoFilter() {
        XCTAssertTrue(CreatedFilter().matches(createdAt: 0))
        XCTAssertFalse(CreatedFilter(year: 1970).matches(createdAt: 0))
    }

    func testListsTheYearsNewestFirst() {
        XCTAssertEqual(CreatedFilter.years(of: [ms(2024, 3, 1), ms(2026, 1, 1), ms(2024, 9, 1), 0], calendar: tokyo), [2026, 2024])
    }
}
