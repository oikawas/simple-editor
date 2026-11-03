import Foundation

// Text from the QR codes a pomera (King Jim's writing device) shows for a
// document. Each code holds "KJ:" and two 2-digit numbers (this code and the
// number of codes; "0101" for a text that fits in one) followed by the text,
// in UTF-8. Long texts are split over several codes.

/// Reads the text out of a QR code's data codewords
/// (`CIQRCodeDescriptor.errorCorrectedPayload`), so the bytes are decoded
/// as UTF-8 (or Shift_JIS) rather than whatever the system guesses.
public enum QRPayload {
    public static func text(codewords: Data, version: Int) -> String? {
        var bits = BitReader(codewords)
        var bytes: [UInt8] = []
        var shiftJIS = false
        var utf8 = false
        let group = version <= 9 ? 0 : version <= 26 ? 1 : 2
        while bits.remaining >= 4 {
            let mode = bits.read(4)
            switch mode {
            case 0:
                return decode(bytes, shiftJIS: shiftJIS, utf8: utf8)
            case 1: // numeric
                var count = bits.read([10, 12, 14][group])
                while count >= 3 { bytes += digits(bits.read(10), 3); count -= 3 }
                if count == 2 { bytes += digits(bits.read(7), 2) }
                if count == 1 { bytes += digits(bits.read(4), 1) }
            case 2: // alphanumeric
                let table = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:".utf8)
                var count = bits.read([9, 11, 13][group])
                while count >= 2 {
                    let v = bits.read(11)
                    guard v / 45 < 45 else { return nil }
                    bytes += [table[v / 45], table[v % 45]]
                    count -= 2
                }
                if count == 1 {
                    let v = bits.read(6)
                    guard v < 45 else { return nil }
                    bytes.append(table[v])
                }
            case 4: // bytes
                let count = bits.read([8, 16, 16][group])
                for _ in 0..<count { bytes.append(UInt8(bits.read(8))) }
            case 7: // ECI: 26 is UTF-8, 20 is Shift_JIS
                let first = bits.read(8)
                let eci = first & 0x80 == 0 ? first
                    : first & 0xC0 == 0x80 ? (first & 0x3F) << 8 | bits.read(8)
                    : (first & 0x1F) << 16 | bits.read(16)
                utf8 = eci == 26
                shiftJIS = eci == 20
            case 8: // kanji, as Shift_JIS
                let count = bits.read([8, 10, 12][group])
                for _ in 0..<count {
                    let v = bits.read(13)
                    var code = (v / 0xC0) << 8 | (v % 0xC0)
                    code += code < 0x1F00 ? 0x8140 : 0xC140
                    bytes += [UInt8(code >> 8), UInt8(code & 0xFF)]
                }
                shiftJIS = true
            default:
                return nil
            }
            if bits.overrun { return nil }
        }
        return decode(bytes, shiftJIS: shiftJIS, utf8: utf8)
    }

    private static func digits(_ value: Int, _ width: Int) -> [UInt8] {
        Array(String(format: "%0\(width)d", value).utf8)
    }

    private static func decode(_ bytes: [UInt8], shiftJIS: Bool, utf8: Bool) -> String? {
        let data = Data(bytes)
        if utf8 { return String(data: data, encoding: .utf8) }
        if !shiftJIS, let s = String(data: data, encoding: .utf8) { return s }
        return String(data: data, encoding: .shiftJIS) ?? String(data: data, encoding: .isoLatin1)
    }
}

private struct BitReader {
    let bytes: [UInt8]
    var position = 0
    var overrun = false

    init(_ data: Data) { bytes = [UInt8](data) }

    var remaining: Int { bytes.count * 8 - position }

    mutating func read(_ count: Int) -> Int {
        guard count <= remaining else {
            overrun = true
            position = bytes.count * 8
            return 0
        }
        var value = 0
        for _ in 0..<count {
            let bit = (bytes[position / 8] >> (7 - UInt8(position % 8))) & 1
            value = value << 1 | Int(bit)
            position += 1
        }
        return value
    }
}

/// One code of a pomera text.
public struct PomeraPart: Equatable, Sendable {
    /// 1-based position of this code.
    public var index: Int
    public var total: Int
    public var text: String

    /// Reads "KJ:<nn><nn><text>". A code without the header is taken as a
    /// whole text on its own. The two numbers are this code and the total;
    /// the smaller one is taken as the position, so their order does not matter.
    public init?(_ payload: String) {
        let chars = Array(payload)
        if chars.count >= 7, String(chars[0..<3]) == "KJ:",
           let a = Int(String(chars[3..<5])), let b = Int(String(chars[5..<7])),
           chars[3..<7].allSatisfy(\.isASCII), min(a, b) >= 1 {
            index = min(a, b)
            total = max(a, b)
            text = String(chars[7...])
        } else if !payload.isEmpty {
            index = 1
            total = 1
            text = payload
        } else {
            return nil
        }
    }
}

/// Collects the codes of one pomera text as they are scanned, in any order.
public struct PomeraScan: Sendable {
    public enum Added: Equatable, Sendable {
        case new
        /// Already scanned.
        case again
        /// From a text with a different number of codes; ignored.
        case otherText
    }

    public private(set) var total: Int?
    private var parts: [Int: String] = [:]

    public init() {}

    public var count: Int { parts.count }
    public var isComplete: Bool { total.map { parts.count == $0 } ?? false }

    public mutating func add(_ part: PomeraPart) -> Added {
        if let total, total != part.total { return .otherText }
        total = part.total
        guard parts[part.index] == nil else { return .again }
        parts[part.index] = part.text
        return .new
    }

    /// The positions not scanned yet.
    public var missing: [Int] {
        guard let total else { return [] }
        return (1...total).filter { parts[$0] == nil }
    }

    /// The whole text, with line breaks as "\n" and no line break at the end.
    public var text: String {
        let joined = parts.keys.sorted().compactMap { parts[$0] }.joined()
        var text = joined.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        while text.hasSuffix("\n") { text.removeLast() }
        return text
    }
}
