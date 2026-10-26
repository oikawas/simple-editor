import SwiftUI
import UniformTypeIdentifiers

/// A note's text, for the save panel.
struct TextFile: FileDocument {
    static let readableContentTypes: [UTType] = [.plainText]
    var text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        text = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }

    /// The title with characters file systems reject replaced.
    static func filename(for title: String) -> String {
        let banned = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
        let cleaned = String(title.unicodeScalars.map { banned.contains($0) ? "_" : Character($0) }.prefix(80))
            .trimmingCharacters(in: .whitespaces)
        return (cleaned.isEmpty ? "untitled" : cleaned) + ".txt"
    }
}

/// All notes exported by the server.
struct ZipFile: FileDocument {
    static let readableContentTypes: [UTType] = [.zip]
    var data: Data
    var filename: String

    init(data: Data, filename: String) {
        self.data = data
        self.filename = filename
    }

    init(configuration: ReadConfiguration) throws {
        data = configuration.file.regularFileContents ?? Data()
        filename = configuration.file.filename ?? "notes.zip"
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: data)
    }
}
