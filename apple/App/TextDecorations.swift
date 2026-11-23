import SwiftUI
#if os(macOS)
import AppKit
typealias PlatformColor = NSColor
#else
import UIKit
typealias PlatformColor = UIColor
#endif

/// The style of the rule drawn under every line of the text.
enum RuledLineStyle: String, CaseIterable, Identifiable {
    case none, solid, dashed, dotted

    var id: String { rawValue }

    var label: String {
        switch self {
        case .none: "なし"
        case .solid: "実線"
        case .dashed: "破線"
        case .dotted: "点線"
        }
    }

    /// The dash pattern; empty for a solid line.
    var dashes: [CGFloat] {
        switch self {
        case .none, .solid: []
        case .dashed: [6, 4]
        case .dotted: [1.5, 2.5]
        }
    }
}

/// What is drawn behind the text besides the text itself, kept per device.
struct TextDecorations: Equatable {
    static let ruledLinesKey = "editorRuledLines"
    static let fullWidthSpacesKey = "editorShowFullWidthSpaces"
    static let halfWidthSpacesKey = "editorShowHalfWidthSpaces"
    static let lineBreaksKey = "editorShowLineBreaks"

    var ruledLines: RuledLineStyle = .none
    var fullWidthSpaces = false
    var halfWidthSpaces = false
    var lineBreaks = false

    var marksAnything: Bool { fullWidthSpaces || halfWidthSpaces || lineBreaks }
}

/// Draws the ruled lines and the marks for spaces and line breaks behind the
/// text. They are only drawn, so they are not part of the text: copying,
/// saving, and syncing see the text alone.
final class DecoratingLayoutManager: NSLayoutManager, NSLayoutManagerDelegate {
    override init() {
        super.init()
        delegate = self
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        delegate = self
    }

    var decorations = TextDecorations() {
        didSet {
            guard decorations != oldValue, let length = textStorage?.length else { return }
            invalidateDisplay(forCharacterRange: NSRange(location: 0, length: length))
        }
    }

    private var context: CGContext? {
        #if os(macOS)
        NSGraphicsContext.current?.cgContext
        #else
        UIGraphicsGetCurrentContext()
        #endif
    }

    private static var markColor: PlatformColor {
        #if os(macOS)
        .tertiaryLabelColor
        #else
        .tertiaryLabel
        #endif
    }

    private static var ruleColor: PlatformColor {
        #if os(macOS)
        NSColor.labelColor.withAlphaComponent(0.35)
        #else
        UIColor.label.withAlphaComponent(0.35)
        #endif
    }

    // MARK: The text's band in each line

    /// The part of a line the text takes: the font's height, centered in the
    /// line. Lines have a fixed height (see NoteTextView's paragraph style);
    /// the caret and the selection cover this band, not the whole line.
    static func textBand(ofLine line: CGRect, font: PlatformFont) -> CGRect {
        let height = font.ascender - font.descender
        return CGRect(x: line.minX, y: line.minY + ((line.height - height) / 2).rounded(), width: line.width, height: height)
    }

    /// The font a line is set in: that of its first character.
    func lineFont(atCharacter index: Int) -> PlatformFont {
        guard let storage = textStorage, storage.length > 0 else { return typingFont }
        return storage.attribute(.font, at: min(index, storage.length - 1), effectiveRange: nil) as? PlatformFont ?? typingFont
    }

    /// Centers the text in its line and records its band as the used rect.
    func layoutManager(
        _ layoutManager: NSLayoutManager,
        shouldSetLineFragmentRect lineFragmentRect: UnsafeMutablePointer<CGRect>,
        lineFragmentUsedRect: UnsafeMutablePointer<CGRect>,
        baselineOffset: UnsafeMutablePointer<CGFloat>,
        in textContainer: NSTextContainer,
        forGlyphRange glyphRange: NSRange
    ) -> Bool {
        let font = lineFont(atCharacter: characterIndexForGlyph(at: glyphRange.location))
        let line = lineFragmentRect.pointee
        let band = Self.textBand(ofLine: line, font: font)
        baselineOffset.pointee = band.minY - line.minY + font.ascender
        let used = lineFragmentUsedRect.pointee
        lineFragmentUsedRect.pointee = CGRect(x: used.minX, y: band.minY, width: used.width, height: band.height)
        return true
    }

    override func setExtraLineFragmentRect(_ fragmentRect: CGRect, usedRect: CGRect, textContainer container: NSTextContainer) {
        let band = Self.textBand(ofLine: fragmentRect, font: typingFont)
        super.setExtraLineFragmentRect(fragmentRect, usedRect: CGRect(x: usedRect.minX, y: band.minY, width: usedRect.width, height: band.height), textContainer: container)
    }

    /// The origin of the drawing under way, for fillBackgroundRectArray.
    private var drawingOrigin = CGPoint.zero

    /// The selection (and other backgrounds) covers only the text's band of
    /// each line it spans.
    override func fillBackgroundRectArray(_ rectArray: UnsafePointer<CGRect>, count rectCount: Int, forCharacterRange charRange: NSRange, color: PlatformColor) {
        var bands: [CGRect] = []
        for i in 0..<rectCount {
            let rect = rectArray[i]
            let local = rect.offsetBy(dx: -drawingOrigin.x, dy: -drawingOrigin.y)
            guard let container = textContainers.first else { continue }
            let glyphs = glyphRange(forBoundingRect: local, in: container)
            var found = false
            enumerateLineFragments(forGlyphRange: glyphs) { line, used, _, _, _ in
                guard line.maxY > local.minY + 0.5, line.minY < local.maxY - 0.5 else { return }
                bands.append(CGRect(x: rect.minX, y: used.minY + self.drawingOrigin.y, width: rect.width, height: used.height))
                found = true
            }
            if !found, !extraLineFragmentRect.isEmpty, extraLineFragmentRect.intersects(local) {
                let used = extraLineFragmentUsedRect
                bands.append(CGRect(x: rect.minX, y: used.minY + drawingOrigin.y, width: rect.width, height: used.height))
                found = true
            }
            if !found { bands.append(rect) }
        }
        bands.withUnsafeBufferPointer { buffer in
            super.fillBackgroundRectArray(buffer.baseAddress!, count: buffer.count, forCharacterRange: charRange, color: color)
        }
    }

    // MARK: Drawing

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        drawingOrigin = origin
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let context else { return }
        context.saveGState()
        defer { context.restoreGState() }
        if decorations.ruledLines != .none { drawRules(glyphsToShow, at: origin, in: context) }
        if decorations.marksAnything { drawMarks(glyphsToShow, at: origin, in: context) }
    }

    /// How far below the baseline the rules are drawn.
    private static let ruleBelowBaseline: CGFloat = 4

    /// A rule just below the baseline of every line fragment, so wrapped rows get one each.
    private func drawRules(_ glyphs: NSRange, at origin: CGPoint, in context: CGContext) {
        context.setStrokeColor(Self.ruleColor.cgColor)
        context.setLineWidth(0.5)
        context.setLineDash(phase: 0, lengths: decorations.ruledLines.dashes)
        func rule(at y: CGFloat, across rect: CGRect, padding: CGFloat) {
            let y = origin.y + y + Self.ruleBelowBaseline
            context.move(to: CGPoint(x: origin.x + rect.minX + padding, y: y))
            context.addLine(to: CGPoint(x: origin.x + rect.maxX - padding, y: y))
        }
        enumerateLineFragments(forGlyphRange: glyphs) { rect, used, container, range, _ in
            let font = self.lineFont(atCharacter: self.characterIndexForGlyph(at: range.location))
            rule(at: used.minY + font.ascender, across: rect, padding: container.lineFragmentPadding)
        }
        // The empty line after a final line break, set in the typing font.
        if NSMaxRange(glyphs) >= numberOfGlyphs, !extraLineFragmentRect.isEmpty {
            let rect = extraLineFragmentRect
            rule(at: extraLineFragmentUsedRect.minY + typingFont.ascender, across: rect, padding: extraLineFragmentTextContainer?.lineFragmentPadding ?? 0)
        }
        context.strokePath()
    }

    /// The font of the end of the text, which an empty last line takes.
    private var typingFont: PlatformFont {
        guard let storage = textStorage, storage.length > 0,
              let font = storage.attribute(.font, at: storage.length - 1, effectiveRange: nil) as? PlatformFont
        else { return PlatformFont.systemFont(ofSize: PlatformFont.systemFontSize) }
        return font
    }

    /// Dotted boxes on spaces and an arrow at each line break.
    private func drawMarks(_ glyphs: NSRange, at origin: CGPoint, in context: CGContext) {
        guard let storage = textStorage else { return }
        let text = storage.string as NSString
        let chars = characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        context.setStrokeColor(Self.markColor.cgColor)
        context.setLineWidth(1)
        context.setLineDash(phase: 0, lengths: [1, 1.5])
        var lineBreakArrows: [(CGPoint, CGFloat)] = []
        for i in chars.location..<NSMaxRange(chars) {
            let c = text.character(at: i)
            let space = (c == 0x3000 && decorations.fullWidthSpaces) || (c == 0x20 && decorations.halfWidthSpaces)
            let lineBreak = c == 0x0A && decorations.lineBreaks
            guard space || lineBreak else { continue }
            let glyph = glyphIndexForCharacter(at: i)
            guard let container = textContainer(forGlyphAt: glyph, effectiveRange: nil) else { continue }
            let font = storage.attribute(.font, at: i, effectiveRange: nil) as? PlatformFont
                ?? PlatformFont.systemFont(ofSize: PlatformFont.systemFontSize)
            let line = lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            var lineStart = NSRange()
            _ = lineFragmentRect(forGlyphAt: glyph, effectiveRange: &lineStart)
            let baseline = origin.y + lineFragmentUsedRect(forGlyphAt: glyph, effectiveRange: nil).minY
                + lineFont(atCharacter: characterIndexForGlyph(at: lineStart.location)).ascender
            let box = boundingRect(forGlyphRange: NSRange(location: glyph, length: 1), in: container)
            let x = origin.x + box.minX
            if space {
                let height = (font.ascender - font.descender) * 0.8
                let middle = baseline - (font.ascender + font.descender) / 2
                context.stroke(CGRect(x: x + 1, y: middle - height / 2, width: max(box.width - 2, 1), height: height))
            } else {
                // Right after the character before it, or at the start of an
                // empty line. (The line break's own glyph box is no help: it
                // has a width, and for the text's final line break it sits
                // at the row's start.)
                let end: CGFloat
                if i > 0, text.character(at: i - 1) != 0x0A {
                    let before = NSRange(location: glyphIndexForCharacter(at: i - 1), length: 1)
                    end = origin.x + boundingRect(forGlyphRange: before, in: container).maxX
                } else {
                    end = origin.x + line.minX + container.lineFragmentPadding
                }
                lineBreakArrows.append((CGPoint(x: end, y: baseline), font.pointSize))
            }
        }
        context.setLineDash(phase: 0, lengths: [])
        for (point, size) in lineBreakArrows { drawLineBreakArrow(at: point, size: size, in: context) }
    }

    /// The line break mark: a ↵ arrow drawn as lines, half a character wide
    /// (as wide as a half-width character), standing on the baseline at `p`.
    private func drawLineBreakArrow(at p: CGPoint, size em: CGFloat, in context: CGContext) {
        let right = p.x + em * 0.38, left = p.x + em * 0.08
        let top = p.y - em * 0.62, bottom = p.y - em * 0.12
        let head = em * 0.12
        context.move(to: CGPoint(x: right, y: top))
        context.addLine(to: CGPoint(x: right, y: bottom))
        context.addLine(to: CGPoint(x: left, y: bottom))
        context.move(to: CGPoint(x: left + head, y: bottom - head))
        context.addLine(to: CGPoint(x: left, y: bottom))
        context.addLine(to: CGPoint(x: left + head, y: bottom + head))
        context.strokePath()
    }
}
