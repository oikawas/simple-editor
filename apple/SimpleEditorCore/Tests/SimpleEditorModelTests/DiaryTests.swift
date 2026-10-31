import XCTest
@testable import SimpleEditorModel

final class DiaryTests: XCTestCase {
    func testDates() {
        XCTAssertEqual(Diary.format("2024-01-02"), "2024年1月2日（火）")
        XCTAssertEqual(Diary.format("2026-10-31"), "2026年10月31日（土）")
        XCTAssertEqual(Diary.date(ofNote: "diary-2024-02-29"), "2024-02-29")
        XCTAssertNil(Diary.date(ofNote: "diary-2023-02-29"))
        XCTAssertNil(Diary.date(ofNote: "0b5c8f3e-1111-4222-8333-944445555666"))
        let noon = Date(timeIntervalSince1970: 1_704_196_800)  // 2024-01-02 12:00 UTC
        XCTAssertEqual(Diary.date(of: noon, in: TimeZone(identifier: "Asia/Tokyo")!), "2024-01-02")
        XCTAssertEqual(Diary.date(of: noon, in: TimeZone(identifier: "Pacific/Kiritimati")!), "2024-01-03")
    }

    func testMonths() {
        let jan = YearMonth(year: 2024, month: 1)
        XCTAssertEqual(jan.adding(months: -1), YearMonth(year: 2023, month: 12))
        XCTAssertEqual(jan.adding(months: 13), YearMonth(year: 2025, month: 2))
        XCTAssertEqual(YearMonth(year: 2024, month: 2).numberOfDays, 29)
        XCTAssertEqual(YearMonth(year: 2023, month: 2).numberOfDays, 28)
        XCTAssertEqual(jan.firstWeekday, 1)  // Monday
        XCTAssertTrue(jan.contains("2024-01-31"))
        XCTAssertFalse(jan.contains("2024-02-01"))
        XCTAssertEqual(jan.date(day: 5), "2024-01-05")
        XCTAssertEqual(YearMonth(date: "2026-10-31"), YearMonth(year: 2026, month: 10))
    }
}
