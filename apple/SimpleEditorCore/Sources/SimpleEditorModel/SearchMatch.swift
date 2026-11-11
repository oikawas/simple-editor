import Foundation

/// Where the words of a search appear in a text, for highlighting them.
/// Matching follows the search itself: whitespace separates the words, and
/// case is ignored.
public enum SearchMatch {
    public static func terms(_ query: String) -> [String] {
        query.split(whereSeparator: \.isWhitespace).map(String.init)
    }

    /// The ranges (UTF-16, as NSRange) where any of the words appear, in
    /// order and without overlaps; at most `limit` of them.
    public static func ranges(of query: String, in text: String, limit: Int = 2000) -> [NSRange] {
        let terms = terms(query)
        guard !terms.isEmpty else { return [] }
        let ns = text as NSString
        var found: [NSRange] = []
        for term in terms {
            var from = 0
            while from < ns.length, found.count < limit * 2 {
                let r = ns.range(of: term, options: [.caseInsensitive], range: NSRange(location: from, length: ns.length - from))
                guard r.location != NSNotFound, r.length > 0 else { break }
                found.append(r)
                from = NSMaxRange(r)
            }
        }
        // Merge overlapping matches of different words.
        var merged: [NSRange] = []
        for r in found.sorted(by: { $0.location < $1.location }) {
            if let last = merged.last, r.location < NSMaxRange(last) {
                merged[merged.count - 1] = NSUnionRange(last, r)
            } else {
                merged.append(r)
            }
        }
        return Array(merged.prefix(limit))
    }
}
