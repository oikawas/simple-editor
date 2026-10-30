import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The editor font, kept per device in UserDefaults.
enum EditorFont {
    static let familyKey = "editorFontFamily"
    static let sizeKey = "editorFontSize"
    static let lineHeightKey = "editorLineHeight"

    /// Line height as a multiple of the font size; about the font's own.
    static let defaultLineHeight = 1.2

    /// The platform's usual body size.
    static var defaultSize: Double {
        #if os(macOS)
        13
        #else
        17
        #endif
    }

    /// Installed font families, sorted.
    @MainActor static var families: [String] {
        #if os(macOS)
        NSFontManager.shared.availableFontFamilies.sorted()
        #else
        UIFont.familyNames.sorted()
        #endif
    }

    /// The editor's font for the platform text view; an empty family means
    /// the system font, and an unknown one falls back to it.
    @MainActor static func platformFont(family: String, size: Double) -> PlatformFont {
        #if os(macOS)
        if !family.isEmpty, let font = NSFontManager.shared.font(withFamily: family, traits: [], weight: 5, size: size) {
            return font
        }
        return .systemFont(ofSize: size)
        #else
        if !family.isEmpty {
            return UIFont(descriptor: UIFontDescriptor(fontAttributes: [.family: family]), size: size)
        }
        return .systemFont(ofSize: size)
        #endif
    }

    /// An empty family means the system font.
    static func font(family: String, size: Double) -> Font {
        family.isEmpty ? .system(size: size) : .custom(family, size: size)
    }
}

/// The Display section of the settings.
struct DisplaySettingsSection: View {
    @AppStorage(EditorFont.familyKey) private var family = ""
    @AppStorage(EditorFont.sizeKey) private var size = EditorFont.defaultSize
    @AppStorage(EditorFont.lineHeightKey) private var lineHeight = EditorFont.defaultLineHeight

    var body: some View {
        Section {
            Picker("書体", selection: $family) {
                Text("システム標準").tag("")
                ForEach(EditorFont.families, id: \.self) { name in
                    Text(name).font(.custom(name, size: 15)).tag(name)
                }
            }
            #if os(iOS)
            .pickerStyle(.navigationLink)
            #endif
            Stepper(value: $size, in: 9...40, step: 1) {
                LabeledContent("大きさ", value: "\(Int(size))")
            }
            Stepper(value: $lineHeight, in: 1.0...3.0, step: 0.1) {
                LabeledContent("行間", value: lineHeight.formatted(.number.precision(.fractionLength(1))))
            }
            Text("あいうえお 漢字 ABC abc 123")
                .font(EditorFont.font(family: family, size: size))
                .lineLimit(1)
            Button("標準に戻す") {
                family = ""
                size = EditorFont.defaultSize
                lineHeight = EditorFont.defaultLineHeight
            }
            .disabled(family.isEmpty && size == EditorFont.defaultSize && lineHeight == EditorFont.defaultLineHeight)
        } header: {
            Text("表示")
        } footer: {
            Text("本文の書体と大きさ、行間（文字の大きさに対する行の高さ）です。この端末だけの設定で、すぐに反映されます。")
        }
    }
}
