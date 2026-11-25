import Foundation

/// Narrows the notes list to those created in a year and/or month, in the
/// device's time zone. Nil means any year or any month.
public struct CreatedFilter: Equatable, Sendable {
    public var year: Int?
    /// 1 to 12.
    public var month: Int?

    public init(year: Int? = nil, month: Int? = nil) {
        self.year = year
        self.month = month
    }

    public var isEmpty: Bool { year == nil && month == nil }

    /// Whether a note created at `createdAt` (ms since 1970; 0 when unknown)
    /// matches. A note without a creation time matches only no filter.
    public func matches(createdAt: Int64, calendar: Calendar = .current) -> Bool {
        if isEmpty { return true }
        guard createdAt > 0 else { return false }
        let parts = calendar.dateComponents([.year, .month], from: Date(timeIntervalSince1970: Double(createdAt) / 1000))
        return (year == nil || parts.year == year) && (month == nil || parts.month == month)
    }

    /// The years notes were created in, newest first.
    public static func years(of createdAts: some Sequence<Int64>, calendar: Calendar = .current) -> [Int] {
        let years = Set(createdAts.filter { $0 > 0 }.map {
            calendar.component(.year, from: Date(timeIntervalSince1970: Double($0) / 1000))
        })
        return years.sorted(by: >)
    }
}
