import Foundation

/// Where the cursor was in each note when it was last left, kept per device
/// in UserDefaults so a note opens where the user stopped. Offsets are in
/// UTF-16 units, as the text views count them.
public struct CursorMemory {
    /// How many notes' cursors are kept; the oldest are dropped beyond this.
    public static let limit = 500
    static let key = "simple-editor.cursors"

    private struct Entry: Codable {
        var lower: Int
        var upper: Int
        /// When it was saved, to drop the oldest entries first.
        var at: Double
    }

    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    private func read() -> [String: Entry] {
        guard let data = defaults.data(forKey: Self.key),
              let all = try? JSONDecoder().decode([String: Entry].self, from: data) else { return [:] }
        return all
    }

    /// The saved selection of a note, fitted to a text of `length` units.
    public func load(id: String, length: Int) -> Range<Int>? {
        guard let e = read()[id] else { return nil }
        let lower = min(max(0, e.lower), length)
        return lower..<min(max(lower, e.upper), length)
    }

    /// Saves a note's selection. One at the start is the default and is not kept.
    public func save(id: String, selection: Range<Int>, now: Date = Date()) {
        var all = read()
        if selection == 0..<0 {
            guard all.removeValue(forKey: id) != nil else { return }
        } else {
            all[id] = Entry(lower: selection.lowerBound, upper: selection.upperBound, at: now.timeIntervalSince1970)
        }
        if all.count > Self.limit {
            let oldest = all.sorted { $0.value.at > $1.value.at }.dropFirst(Self.limit)
            for (id, _) in oldest { all.removeValue(forKey: id) }
        }
        if let data = try? JSONEncoder().encode(all) {
            defaults.set(data, forKey: Self.key)
        }
    }
}
