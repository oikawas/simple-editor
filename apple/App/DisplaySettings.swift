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

    /// An empty family means the system font.
    static func font(family: String, size: Double) -> Font {
        family.isEmpty ? .system(size: size) : .custom(family, size: size)
    }
}

/// The Display section of the settings.
struct DisplaySettingsSection: View {
    @AppStorage(EditorFont.familyKey) private var family = ""
    @AppStorage(EditorFont.sizeKey) private var size = EditorFont.defaultSize

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
            Text("あいうえお 漢字 ABC abc 123")
                .font(EditorFont.font(family: family, size: size))
                .lineLimit(1)
            Button("標準に戻す") {
                family = ""
                size = EditorFont.defaultSize
            }
            .disabled(family.isEmpty && size == EditorFont.defaultSize)
        } header: {
            Text("表示")
        } footer: {
            Text("本文の書体と大きさです。この端末だけの設定で、すぐに反映されます。")
        }
    }
}
