import SimpleEditorModel
import SwiftUI

struct EditorView: View {
    @Environment(AppModel.self) private var model
    let note: OpenNote
    @State private var selection: TextSelection?
    @State private var newTag = ""
    @State private var showHistory = false
    @State private var exporting = false
    @AppStorage(EditorFont.familyKey) private var fontFamily = ""
    @AppStorage(EditorFont.sizeKey) private var fontSize = EditorFont.defaultSize

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            tagBar
            Text("作成: \(note.createdAt.formatted(date: .numeric, time: .shortened))　更新: \(note.updatedAt.formatted(date: .numeric, time: .shortened))")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            TextEditor(text: text, selection: $selection)
                .font(EditorFont.font(family: fontFamily, size: fontSize))
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 8)
        }
        .navigationTitle(note.title.isEmpty ? "（無題）" : note.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup {
                Button("編集履歴", systemImage: "clock.arrow.circlepath") { showHistory = true }
                Button("テキストとして書き出し", systemImage: "square.and.arrow.up") { exporting = true }
                Button(note.deleted ? "ゴミ箱から戻す" : "ゴミ箱へ",
                       systemImage: note.deleted ? "arrow.uturn.backward" : "trash") {
                    note.setDeleted(!note.deleted)
                    model.currentNoteChanged()
                }
            }
        }
        .onChange(of: selection) { _, new in
            if let range = utf16Range(new) { note.selection = range }
        }
        .onChange(of: note.externalRevision) {
            // The text changed on another device; put the cursor back where it was.
            selection = textSelection(note.selection)
        }
        .sheet(isPresented: $showHistory) {
            HistoryView(note: note)
        }
        .fileExporter(isPresented: $exporting, document: TextFile(text: note.text), contentType: .plainText,
                      defaultFilename: TextFile.filename(for: note.title)) { result in
            if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
        }
    }

    private var text: Binding<String> {
        Binding(get: { note.text }, set: { newValue in
            note.edit(newValue)
            model.currentNoteChanged()
        })
    }

    private var tagBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(note.tags, id: \.self) { tag in
                    Button {
                        note.removeTag(tag)
                        model.currentNoteChanged()
                    } label: {
                        Label("#\(tag)", systemImage: "xmark")
                            .labelStyle(TrailingIconLabelStyle())
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .help("タグを外す")
                }
                TextField("タグを追加", text: $newTag)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 140)
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                    .onSubmit {
                        note.addTag(newTag)
                        newTag = ""
                        model.currentNoteChanged()
                    }
            }
            .padding(.horizontal)
            .padding(.top, 8)
        }
    }

    /// The selection in UTF-16 offsets, as the model and core count.
    private func utf16Range(_ selection: TextSelection?) -> Range<Int>? {
        guard case .selection(let range) = selection?.indices else { return nil }
        let text = note.text
        guard range.lowerBound <= text.endIndex, range.upperBound <= text.endIndex else { return nil }
        return range.lowerBound.utf16Offset(in: text)..<range.upperBound.utf16Offset(in: text)
    }

    private func textSelection(_ range: Range<Int>) -> TextSelection {
        let text = note.text
        let count = text.utf16.count
        let lower = String.Index(utf16Offset: min(range.lowerBound, count), in: text)
        let upper = String.Index(utf16Offset: min(range.upperBound, count), in: text)
        return lower == upper ? TextSelection(insertionPoint: lower) : TextSelection(range: lower..<upper)
    }
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon.imageScale(.small)
        }
    }
}
