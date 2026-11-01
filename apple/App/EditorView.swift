import SimpleEditorModel
import SwiftUI

struct EditorView: View {
    @Environment(AppModel.self) private var model
    let note: OpenNote
    @State private var newTag = ""
    @State private var showHistory = false
    @State private var exporting = false
    @AppStorage(EditorFont.familyKey) private var fontFamily = ""
    @AppStorage(EditorFont.sizeKey) private var fontSize = EditorFont.defaultSize
    @AppStorage(EditorFont.lineHeightKey) private var lineHeight = EditorFont.defaultLineHeight

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            tagBar
            Text(datesLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
            NoteTextView(
                note: note,
                font: EditorFont.platformFont(family: fontFamily, size: fontSize),
                lineHeight: lineHeight,
                onEdit: { model.currentNoteChanged() }
            )
        }
        .navigationTitle(note.diaryDate.map(Diary.format) ?? (note.title.isEmpty ? "（無題）" : note.title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup {
                Button("編集履歴", systemImage: "clock.arrow.circlepath") { showHistory = true }
                Button("テキストとして書き出し", systemImage: "square.and.arrow.up") { exporting = true }
                // Diary entries do not go to the trash.
                if note.diaryDate == nil {
                    Button(note.deleted ? "ゴミ箱から戻す" : "ゴミ箱へ",
                           systemImage: note.deleted ? "arrow.uturn.backward" : "trash") {
                        note.setDeleted(!note.deleted)
                        model.currentNoteChanged()
                    }
                }
            }
        }
        .sheet(isPresented: $showHistory) {
            HistoryView(note: note)
        }
        .fileExporter(isPresented: $exporting, document: TextFile(text: note.text), contentType: .plainText,
                      defaultFilename: note.diaryDate.map { "\($0).txt" } ?? TextFile.filename(for: note.title)) { result in
            if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
        }
    }

    private var datesLine: String {
        let created = note.createdAt.formatted(date: .numeric, time: .shortened)
        let updated = note.updatedAt.formatted(date: .numeric, time: .shortened)
        guard let date = note.diaryDate else { return "作成: \(created)　更新: \(updated)" }
        // An entry not written yet has no times.
        let written = note.updatedAt.timeIntervalSince1970 > 0
        return "\(Diary.format(date))の日記" + (written ? "　更新: \(updated)" : "")
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
}

private struct TrailingIconLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon.imageScale(.small)
        }
    }
}
