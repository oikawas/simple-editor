import Foundation
import SimpleEditorCore

/// What the sidebar shows.
public enum SidebarMode: String, Sendable {
    case notes
    case diary
}

/// A calendar month, for the diary.
public struct YearMonth: Hashable, Sendable {
    public var year: Int
    public var month: Int  // 1-12

    public init(year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    /// The month of a date ("YYYY-MM-DD").
    public init?(date: String) {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        self.init(year: parts[0], month: parts[1])
    }

    public func adding(months: Int) -> YearMonth {
        let index = year * 12 + (month - 1) + months
        return YearMonth(year: index / 12, month: index % 12 + 1)
    }

    /// "2024-01-" — the prefix of this month's dates.
    var prefix: String { String(format: "%04d-%02d-", year, month) }

    public func contains(_ date: String) -> Bool { date.hasPrefix(prefix) }

    public func date(day: Int) -> String { prefix + String(format: "%02d", day) }

    public var numberOfDays: Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let first = calendar.date(from: DateComponents(year: year, month: month, day: 1))!
        return calendar.range(of: .day, in: .month, for: first)!.count
    }

    /// The weekday of the 1st, 0 for Sunday.
    public var firstWeekday: Int {
        Diary.weekday(of: date(day: 1))
    }
}

/// Diary dates are the device's local dates, as "YYYY-MM-DD".
public enum Diary {
    public static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    public static func date(of day: Date, in timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day], from: day)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    public static var today: String { date(of: Date()) }

    /// 0 for Sunday.
    static func weekday(of date: String) -> Int {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return 0 }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        guard let d = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return 0 }
        return calendar.component(.weekday, from: d) - 1
    }

    /// "2024年1月2日（火）"
    public static func format(_ date: String) -> String {
        let parts = date.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return date }
        return "\(parts[0])年\(parts[1])月\(parts[2])日（\(weekdays[weekday(of: date)])）"
    }

    /// The date of a diary entry's id, or nil for an ordinary note.
    public static func date(ofNote id: String) -> String? {
        diaryDate(id: id)
    }
}
