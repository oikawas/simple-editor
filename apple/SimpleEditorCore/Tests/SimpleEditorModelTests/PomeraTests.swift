import Foundation
import XCTest
@testable import SimpleEditorModel
#if canImport(CoreImage)
import CoreImage
import CoreImage.CIFilterBuiltins
#endif

final class PomeraTests: XCTestCase {
    /// The data codewords of a pomera code (version 27) for "これはテスト",
    /// read from a photo of the device's screen; the rest is padding.
    static let sample: Data = {
        let head: [UInt8] = [
            0x40, 0x01, 0xb4, 0xb4, 0xa3, 0xa3, 0x03, 0x13, 0x03, 0x1e, 0x38, 0x19, 0x3e, 0x38, 0x28,
            0xce, 0x38, 0x1a, 0xfe, 0x38, 0x38, 0x6e, 0x38, 0x2b, 0x9e, 0x38, 0x38, 0x80, 0xd0, 0xa0,
        ]
        var bytes = head
        while bytes.count < 1128 { bytes += [0xec, 0x11] }
        return Data(bytes.prefix(1128))
    }()

    func testDecodesThePomeraSample() throws {
        let payload = try XCTUnwrap(QRPayload.text(codewords: Self.sample, version: 27))
        XCTAssertTrue(payload.hasPrefix("KJ:0101これはテスト"), payload)
        let part = try XCTUnwrap(PomeraPart(payload))
        XCTAssertEqual(part.index, 1)
        XCTAssertEqual(part.total, 1)
        var scan = PomeraScan()
        XCTAssertEqual(scan.add(part), .new)
        XCTAssertTrue(scan.isComplete)
        XCTAssertEqual(scan.text, "これはテスト")
    }

    func testReadsTheHeaderInEitherOrder() throws {
        let a = try XCTUnwrap(PomeraPart("KJ:0103本文"))
        XCTAssertEqual([a.index, a.total], [1, 3])
        XCTAssertEqual(a.text, "本文")
        let b = try XCTUnwrap(PomeraPart("KJ:0301本文"))
        XCTAssertEqual([b.index, b.total], [1, 3])
        let plain = try XCTUnwrap(PomeraPart("ふつうの QR"))
        XCTAssertEqual([plain.index, plain.total], [1, 1])
        XCTAssertEqual(plain.text, "ふつうの QR")
        XCTAssertNil(PomeraPart(""))
    }

    func testAssemblesPartsInAnyOrder() throws {
        var scan = PomeraScan()
        XCTAssertEqual(scan.add(try XCTUnwrap(PomeraPart("KJ:0303三つ目\r\n"))), .new)
        XCTAssertEqual(scan.add(try XCTUnwrap(PomeraPart("KJ:0103一つ目\r\n"))), .new)
        XCTAssertFalse(scan.isComplete)
        XCTAssertEqual(scan.missing, [2])
        XCTAssertEqual(scan.add(try XCTUnwrap(PomeraPart("KJ:0103一つ目\r\n"))), .again)
        XCTAssertEqual(scan.add(try XCTUnwrap(PomeraPart("KJ:0102別の文書"))), .otherText)
        XCTAssertEqual(scan.add(try XCTUnwrap(PomeraPart("KJ:0203二つ目\r"))), .new)
        XCTAssertTrue(scan.isComplete)
        XCTAssertEqual(scan.text, "一つ目\n二つ目\n三つ目")
    }

    func testDecodesOtherSegmentModes() throws {
        // Numeric "0123" (version 1): mode 1, count 4 (10 bits), "012" in 10 bits, "3" in 4 bits.
        var bits = "0001" + "0000000100" + "0000001100" + "0011" + "0000"
        XCTAssertEqual(QRPayload.text(codewords: Self.pack(bits), version: 1), "0123")
        // Alphanumeric "AB:" : mode 2, count 3 (9 bits), "AB" = 10*45+11 in 11 bits, ":" = 44 in 6 bits.
        bits = "0010" + "000000011" + String(461, radix: 2).leftPad(11) + String(44, radix: 2).leftPad(6) + "0000"
        XCTAssertEqual(QRPayload.text(codewords: Self.pack(bits), version: 1), "AB:")
        // Kanji "点" (Shift_JIS 0x935F): mode 8, count 1 (8 bits), 13 bits.
        let v = (0x935F - 0x8140) >> 8 * 0xC0 + (0x935F - 0x8140) & 0xFF
        bits = "1000" + "00000001" + String(v, radix: 2).leftPad(13) + "0000"
        XCTAssertEqual(QRPayload.text(codewords: Self.pack(bits), version: 1), "点")
    }

    #if canImport(CoreImage)
    /// Generates a code with Core Image and reads it back through its codewords.
    func testRoundTripsGeneratedCodes() throws {
        for message in ["KJ:0102あいうえお\r\n改行も", String(repeating: "長い文章。", count: 100)] {
            let filter = CIFilter.qrCodeGenerator()
            filter.message = Data(message.utf8)
            filter.correctionLevel = "M"
            let image = try XCTUnwrap(filter.outputImage).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
            let detector = try XCTUnwrap(CIDetector(ofType: CIDetectorTypeQRCode, context: nil))
            let feature = try XCTUnwrap(detector.features(in: image).first as? CIQRCodeFeature)
            let descriptor = try XCTUnwrap(feature.symbolDescriptor)
            XCTAssertEqual(
                QRPayload.text(codewords: descriptor.errorCorrectedPayload, version: descriptor.symbolVersion),
                message
            )
        }
    }
    #endif

    static func pack(_ bits: String) -> Data {
        var padded = Array(bits)
        while padded.count % 8 != 0 { padded.append("0") }
        var bytes: [UInt8] = stride(from: 0, to: padded.count, by: 8).map { UInt8(String(padded[$0..<$0 + 8]), radix: 2)! }
        bytes += [0xec, 0x11, 0xec, 0x11]
        return Data(bytes)
    }
}

private extension String {
    func leftPad(_ width: Int) -> String { String(repeating: "0", count: max(0, width - count)) + self }
}
