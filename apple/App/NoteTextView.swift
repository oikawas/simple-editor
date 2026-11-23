import SimpleEditorModel
import SwiftUI
#if os(macOS)
import AppKit
typealias PlatformFont = NSFont
#else
import UIKit
typealias PlatformFont = UIFont
#endif

/// The note body in the platform's own text view.
///
/// SwiftUI's TextEditor gives no way to tell input-method composition (such as
/// Japanese conversion) from committed text, and redrawing it while composing
/// drops the input. This view sends only committed text to the note, and holds
/// back changes from other devices while composing; they are merged when the
/// composition is committed.
@MainActor
struct NoteTextView {
    let note: OpenNote
    let font: PlatformFont
    /// Line height as a multiple of the font size.
    let lineHeight: Double
    /// Search words to highlight in the text (macOS).
    var highlight: String = ""
    /// Ruled lines and marks for spaces and line breaks.
    var decorations = TextDecorations()
    let onEdit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    @MainActor
    final class Coordinator: NSObject {
        var parent: NoteTextView
        #if os(macOS)
        weak var textView: NSTextView?
        #else
        weak var textView: UITextView?
        #endif
        /// The text the view and the note last agreed on.
        var syncedText: String
        var appliedRevision: Int
        /// Set while the view is updated in code, so that is not taken as typing.
        var isApplying = false
        /// The font and line height last applied to the text.
        private var appliedStyle: (PlatformFont, Double)?
        #if os(macOS)
        /// Where the first line ended when it was last styled, so restyling
        /// only touches the top of the text.
        private var styledTitleEnd = 0
        /// The search last highlighted.
        private var appliedHighlight: String?
        #endif

        init(_ parent: NoteTextView) {
            self.parent = parent
            self.syncedText = parent.note.text
            self.appliedRevision = parent.note.externalRevision
        }

        /// Applies the font and line height to the text and to what is typed
        /// next. Changing the text's attributes would break a composition, so
        /// that waits until it is committed.
        func applyStyle(force: Bool = false) {
            guard let textView else { return }
            // Only drawn, never part of the text, so this is safe while composing.
            (textView.layoutManager as? DecoratingLayoutManager)?.decorations = parent.decorations
            guard !composing else { return }
            let font = parent.font
            if !force, case let (applied, height)? = appliedStyle, applied == font, height == parent.lineHeight { return }
            appliedStyle = (font, parent.lineHeight)
            let style = paragraphStyle(for: font)
            bodyParagraph = style
            isApplying = true
            defer { isApplying = false }
            #if os(macOS)
            textView.defaultParagraphStyle = style
            let storage = textView.textStorage
            #else
            let storage: NSTextStorage? = textView.textStorage
            #endif
            textView.font = font
            if let storage {
                let range = NSRange(location: 0, length: storage.length)
                storage.addAttributes([.font: font, .paragraphStyle: style], range: range)
            }
            textView.typingAttributes[.font] = font
            textView.typingAttributes[.paragraphStyle] = style
            #if os(macOS)
            styledTitleEnd = storage?.length ?? 0
            styleTitle()
            highlightSearch(force: true)
            #endif
        }

        /// The paragraph style that gives every line the same height: the font
        /// size times the line height, but not less than the font's natural
        /// line height. Without a fixed height, a line holding Japanese (set
        /// in a fallback font with taller metrics) would be taller than an
        /// empty line or one of Latin letters.
        private func paragraphStyle(for font: PlatformFont) -> NSParagraphStyle {
            #if os(macOS)
            let natural = NSLayoutManager().defaultLineHeight(for: font)
            #else
            let natural = font.lineHeight
            #endif
            let height = max(font.pointSize * parent.lineHeight, natural).rounded()
            let style = NSMutableParagraphStyle()
            style.minimumLineHeight = height
            style.maximumLineHeight = height
            return style
        }

        /// The paragraph style of the body text.
        private var bodyParagraph = NSParagraphStyle()

        #if os(macOS)
        private var titleFont: NSFont {
            let font = parent.font
            let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
            return NSFont(descriptor: bold.fontDescriptor, size: font.pointSize * Self.titleScale) ?? bold
        }

        /// How much larger the title (the first line) is set than the text.
        static let titleScale: CGFloat = 1.5

        /// Shows the first line, the note's title, bold and titleScale times as large,
        /// as the web and Linux apps do; not in diary entries. Only attributes
        /// change, so this waits while composing.
        func styleTitle() {
            guard let textView, let storage = textView.textStorage, !composing else { return }
            let text = storage.string as NSString
            let newline = text.range(of: "\n")
            let titleEnd = newline.location == NSNotFound ? text.length : newline.location
            let reset = NSRange(location: 0, length: min(text.length, max(styledTitleEnd, titleEnd) + 1))
            let hasTitle = parent.note.diaryDate == nil
            let wasApplying = isApplying
            isApplying = true
            defer { isApplying = wasApplying }
            storage.beginEditing()
            storage.addAttributes([.font: parent.font, .paragraphStyle: bodyParagraph], range: reset)
            if hasTitle, titleEnd > 0 {
                storage.addAttribute(.font, value: titleFont, range: NSRange(location: 0, length: titleEnd))
                // The title's line is as much taller as its type.
                let paragraph = NSRange(location: 0, length: min(text.length, titleEnd + 1))
                storage.addAttribute(.paragraphStyle, value: paragraphStyle(for: titleFont), range: paragraph)
            }
            storage.endEditing()
            styledTitleEnd = titleEnd
            updateTypingFont()
        }

        /// What is typed next takes the title's font on the first line.
        func updateTypingFont() {
            guard let textView, !composing else { return }
            let inTitle = parent.note.diaryDate == nil && textView.selectedRange().location <= styledTitleEnd
            textView.typingAttributes[.font] = inTitle ? titleFont : parent.font
            textView.typingAttributes[.paragraphStyle] = inTitle ? paragraphStyle(for: titleFont) : bodyParagraph
        }

        /// Marks where the searched words appear. The marks are drawn over the
        /// text and are not part of it.
        func highlightSearch(force: Bool = false) {
            guard let textView else { return }
            let query = parent.highlight
            if !force, query == appliedHighlight { return }
            appliedHighlight = query
            let ranges = SearchMatch.ranges(of: query, in: textView.string)
            let marks: [NSAttributedString.Key: Any] = [
                .backgroundColor: NSColor.systemYellow.withAlphaComponent(0.55),
                .foregroundColor: NSColor.black,
            ]
            if let layout = textView.textLayoutManager, let content = layout.textContentManager {
                for key in marks.keys { layout.removeRenderingAttribute(key, for: layout.documentRange) }
                let start = content.documentRange.location
                for r in ranges {
                    guard let from = content.location(start, offsetBy: r.location),
                          let to = content.location(from, offsetBy: r.length),
                          let range = NSTextRange(location: from, end: to) else { continue }
                    for (key, value) in marks { layout.addRenderingAttribute(key, value: value, for: range) }
                }
            } else if let layout = textView.layoutManager {
                let all = NSRange(location: 0, length: (textView.string as NSString).length)
                for key in marks.keys { layout.removeTemporaryAttribute(key, forCharacterRange: all) }
                for r in ranges { layout.addTemporaryAttributes(marks, forCharacterRange: r) }
            }
        }

        /// Brings the first searched word into view, e.g. when a note is opened from search results.
        func revealFirstMatch() {
            guard let textView, let first = SearchMatch.ranges(of: parent.highlight, in: textView.string, limit: 1).first else { return }
            textView.scrollRangeToVisible(first)
        }
        #endif

        /// Puts the cursor where the note has it: where it was last left on
        /// this device, when the note was just opened.
        func restoreSelection() {
            guard let textView else { return }
            let range = clamped(parent.note.selection, to: viewText.utf16.count)
            isApplying = true
            defer { isApplying = false }
            #if os(macOS)
            textView.setSelectedRange(range)
            updateTypingFont()
            #else
            textView.selectedRange = range
            #endif
        }

        /// Brings the cursor into view.
        func revealSelection() {
            guard let textView else { return }
            #if os(macOS)
            textView.scrollRangeToVisible(textView.selectedRange())
            #else
            textView.scrollRangeToVisible(textView.selectedRange)
            #endif
        }

        private func clamped(_ selection: Range<Int>, to length: Int) -> NSRange {
            let lower = min(selection.lowerBound, length)
            return NSRange(location: lower, length: min(selection.upperBound, length) - lower)
        }

        private var composing: Bool {
            #if os(macOS)
            textView?.hasMarkedText() ?? false
            #else
            textView?.markedTextRange != nil
            #endif
        }

        private var viewText: String {
            #if os(macOS)
            textView?.string ?? ""
            #else
            textView?.text ?? ""
            #endif
        }

        /// Sends committed text to the note.
        func textChanged() {
            guard !isApplying, !composing else { return }
            // A style change held back during a composition.
            applyStyle()
            let edited = viewText
            guard edited != syncedText else { return }
            parent.note.applyEdit(from: syncedText, to: edited)
            syncedText = edited
            appliedRevision = parent.note.externalRevision
            parent.onEdit()
            // Changes from elsewhere were merged in: show the result.
            if parent.note.text != edited { show(parent.note.text, selection: parent.note.selection) }
            #if os(macOS)
            styleTitle()
            highlightSearch(force: true)
            #endif
        }

        func selectionChanged(_ range: NSRange) {
            guard !isApplying, !composing, range.location != NSNotFound else { return }
            parent.note.selection = range.location..<(range.location + range.length)
            #if os(macOS)
            updateTypingFont()
            #endif
        }

        /// Shows a change from another device, unless the user is composing.
        func applyExternalChange() {
            guard parent.note.externalRevision != appliedRevision, !composing else { return }
            appliedRevision = parent.note.externalRevision
            show(parent.note.text, selection: parent.note.selection)
        }

        private func show(_ text: String, selection: Range<Int>) {
            guard let textView else { return }
            isApplying = true
            defer { isApplying = false }
            let range = clamped(selection, to: text.utf16.count)
            #if os(macOS)
            textView.string = text
            #else
            textView.text = text
            #endif
            applyStyle(force: true)
            #if os(macOS)
            textView.setSelectedRange(range)
            #else
            textView.selectedRange = range
            #endif
            syncedText = text
        }
    }
}

#if os(macOS)
extension NoteTextView: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
        // TextKit 1, with a layout manager that draws the ruled lines and
        // the marks for spaces and line breaks behind the text.
        let storage = NSTextStorage()
        let layout = DecoratingLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(containerSize: NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        let textView = NSTextView(frame: .zero, textContainer: container)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.minSize = .zero
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.documentView = textView
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.textColor = .labelColor
        textView.font = font
        textView.textContainerInset = NSSize(width: 8, height: 8)
        // Plain text: no smart quotes, dashes, or replacements.
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.string = note.text
        context.coordinator.textView = textView
        context.coordinator.applyStyle()
        context.coordinator.restoreSelection()
        // Once laid out, show the cursor, or the first searched word when
        // the note was opened from search results.
        let coordinator = context.coordinator
        DispatchQueue.main.async {
            coordinator.revealSelection()
            coordinator.revealFirstMatch()
        }
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyStyle()
        context.coordinator.applyExternalChange()
        context.coordinator.highlightSearch()
    }
}

extension NoteTextView.Coordinator: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) {
        textChanged()
    }

    func textViewDidChangeSelection(_ notification: Notification) {
        if let textView { selectionChanged(textView.selectedRange()) }
    }
}
#else
extension NoteTextView: UIViewRepresentable {
    func makeUIView(context: Context) -> UITextView {
        // TextKit 1. With TextKit 2, tapping blank space in a run of empty
        // lines could put the caret on the last line and scroll there (seen
        // when the iOS app runs on a Mac): its estimated line heights put the
        // tap below the end of the text. The layout manager also draws the
        // ruled lines and the marks for spaces and line breaks.
        let storage = NSTextStorage()
        let layout = DecoratingLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        let textView = BandTextView(frame: .zero, textContainer: container)
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.textColor = .label
        textView.font = font
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 24, right: 8)
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.alwaysBounceVertical = true
        textView.keyboardDismissMode = .interactive
        textView.text = note.text
        context.coordinator.textView = textView
        context.coordinator.applyStyle()
        context.coordinator.restoreSelection()
        let coordinator = context.coordinator
        DispatchQueue.main.async { coordinator.revealSelection() }
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.applyStyle()
        context.coordinator.applyExternalChange()
    }
}

/// A text view whose caret and selection cover the text's band of each line
/// (the font's height, see DecoratingLayoutManager.textBand) instead of the
/// whole line, which is taller with the line height.
final class BandTextView: UITextView {
    private var decorating: DecoratingLayoutManager? { layoutManager as? DecoratingLayoutManager }

    /// The text's band of the line holding the character at `index`, in
    /// this view's coordinates.
    private func band(atCharacter index: Int) -> CGRect? {
        guard let layout = decorating else { return nil }
        let length = textStorage.length
        let used: CGRect
        if index >= length, !layout.extraLineFragmentRect.isEmpty {
            used = layout.extraLineFragmentUsedRect
        } else if length > 0 {
            used = layout.lineFragmentUsedRect(forGlyphAt: layout.glyphIndexForCharacter(at: min(index, length - 1)), effectiveRange: nil)
        } else {
            return nil
        }
        return used.offsetBy(dx: textContainerInset.left, dy: textContainerInset.top)
    }

    override func caretRect(for position: UITextPosition) -> CGRect {
        let caret = super.caretRect(for: position)
        guard let band = band(atCharacter: offset(from: beginningOfDocument, to: position)) else { return caret }
        return CGRect(x: caret.minX, y: band.minY, width: caret.width, height: band.height)
    }

    override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
        super.selectionRects(for: range).map { rect in
            guard let layout = decorating, let container = layout.textContainers.first, !rect.rect.isEmpty else { return rect }
            let point = CGPoint(x: rect.rect.minX - textContainerInset.left, y: rect.rect.midY - textContainerInset.top)
            let glyph = layout.glyphIndex(for: point, in: container)
            guard let band = band(atCharacter: layout.characterIndexForGlyph(at: glyph)) else { return rect }
            return BandSelectionRect(base: rect, rect: CGRect(x: rect.rect.minX, y: band.minY, width: rect.rect.width, height: band.height))
        }
    }
}

/// A selection rect moved to the text's band.
private final class BandSelectionRect: UITextSelectionRect {
    private let base: UITextSelectionRect
    private let bandRect: CGRect

    init(base: UITextSelectionRect, rect: CGRect) {
        self.base = base
        self.bandRect = rect
    }

    override var rect: CGRect { bandRect }
    override var writingDirection: NSWritingDirection { base.writingDirection }
    override var containsStart: Bool { base.containsStart }
    override var containsEnd: Bool { base.containsEnd }
    override var isVertical: Bool { base.isVertical }
}

extension NoteTextView.Coordinator: UITextViewDelegate {
    func textViewDidChange(_ textView: UITextView) {
        textChanged()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        selectionChanged(textView.selectedRange)
    }
}
#endif
