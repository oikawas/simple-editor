import SwiftUI
#if os(macOS)
import AppKit
private typealias PlatformColor = NSColor
#else
import UIKit
private typealias PlatformColor = UIColor
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
final class DecoratingLayoutManager: NSLayoutManager {
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
        .separatorColor
        #else
        .separator
        #endif
    }

    override func drawBackground(forGlyphRange glyphsToShow: NSRange, at origin: CGPoint) {
        super.drawBackground(forGlyphRange: glyphsToShow, at: origin)
        guard let context else { return }
        context.saveGState()
        defer { context.restoreGState() }
        if decorations.ruledLines != .none { drawRules(glyphsToShow, at: origin, in: context) }
        if decorations.marksAnything { drawMarks(glyphsToShow, at: origin, in: context) }
    }

    /// A rule on the baseline of every line fragment, so wrapped rows get one each.
    private func drawRules(_ glyphs: NSRange, at origin: CGPoint, in context: CGContext) {
        context.setStrokeColor(Self.ruleColor.cgColor)
        context.setLineWidth(0.5)
        context.setLineDash(phase: 0, lengths: decorations.ruledLines.dashes)
        func rule(at y: CGFloat, across rect: CGRect, padding: CGFloat) {
            context.move(to: CGPoint(x: origin.x + rect.minX + padding, y: origin.y + y))
            context.addLine(to: CGPoint(x: origin.x + rect.maxX - padding, y: origin.y + y))
        }
        enumerateLineFragments(forGlyphRange: glyphs) { rect, _, container, range, _ in
            // A glyph's location is its baseline point within the fragment.
            rule(at: rect.minY + self.location(forGlyphAt: range.location).y, across: rect, padding: container.lineFragmentPadding)
        }
        // The empty line after a final line break, set in the typing font.
        if NSMaxRange(glyphs) >= numberOfGlyphs, !extraLineFragmentRect.isEmpty {
            let rect = extraLineFragmentRect
            let font = typingFont
            rule(at: rect.minY + font.ascender, across: rect, padding: extraLineFragmentTextContainer?.lineFragmentPadding ?? 0)
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
            let baseline = origin.y + line.minY + location(forGlyphAt: glyph).y
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
                let mark = NSAttributedString(string: "↵", attributes: [.font: font, .foregroundColor: Self.markColor])
                mark.draw(at: CGPoint(x: end + 1, y: baseline - font.ascender))
            }
        }
    }
}
