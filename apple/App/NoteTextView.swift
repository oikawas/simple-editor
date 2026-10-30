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

        init(_ parent: NoteTextView) {
            self.parent = parent
            self.syncedText = parent.note.text
            self.appliedRevision = parent.note.externalRevision
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
            let edited = viewText
            guard edited != syncedText else { return }
            parent.note.applyEdit(from: syncedText, to: edited)
            syncedText = edited
            appliedRevision = parent.note.externalRevision
            parent.onEdit()
            // Changes from elsewhere were merged in: show the result.
            if parent.note.text != edited { show(parent.note.text, selection: parent.note.selection) }
        }

        func selectionChanged(_ range: NSRange) {
            guard !isApplying, !composing, range.location != NSNotFound else { return }
            parent.note.selection = range.location..<(range.location + range.length)
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
            let length = text.utf16.count
            let lower = min(selection.lowerBound, length)
            let range = NSRange(location: lower, length: min(selection.upperBound, length) - lower)
            #if os(macOS)
            textView.string = text
            textView.font = parent.font
            textView.setSelectedRange(range)
            #else
            textView.text = text
            textView.font = parent.font
            textView.selectedRange = range
            #endif
            syncedText = text
        }
    }
}

#if os(macOS)
extension NoteTextView: NSViewRepresentable {
    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.drawsBackground = false
        let textView = scrollView.documentView as! NSTextView
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
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        context.coordinator.parent = self
        if let textView = context.coordinator.textView, textView.font != font {
            textView.font = font
        }
        context.coordinator.applyExternalChange()
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
        let textView = UITextView()
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
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        context.coordinator.parent = self
        if textView.font != font {
            textView.font = font
        }
        context.coordinator.applyExternalChange()
    }
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
