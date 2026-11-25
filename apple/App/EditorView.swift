import SimpleEditorModel
import SwiftUI

struct EditorView: View {
    @Environment(AppModel.self) private var model
    let note: OpenNote
    @State private var newTag = ""
    @State private var showHistory = false
    @State private var exporting = false
    @State private var importingFromPomera = false
    @AppStorage(EditorFont.familyKey) private var fontFamily = ""
    @AppStorage(EditorFont.sizeKey) private var fontSize = EditorFont.defaultSize
    @AppStorage(EditorFont.lineHeightKey) private var lineHeight = EditorFont.defaultLineHeight
    @AppStorage(TextDecorations.ruledLinesKey) private var ruledLines = RuledLineStyle.none
    @AppStorage(TextDecorations.fullWidthSpacesKey) private var fullWidthSpaces = false
    @AppStorage(TextDecorations.halfWidthSpacesKey) private var halfWidthSpaces = false
    @AppStorage(TextDecorations.lineBreaksKey) private var lineBreaks = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            tagBar
            NoteTextView(
                note: note,
                font: EditorFont.platformFont(family: fontFamily, size: fontSize),
                lineHeight: lineHeight,
                highlight: model.searchText,
                decorations: TextDecorations(
                    ruledLines: ruledLines,
                    fullWidthSpaces: fullWidthSpaces,
                    halfWidthSpaces: halfWidthSpaces,
                    lineBreaks: lineBreaks
                ),
                onEdit: { model.currentNoteChanged() }
            )
            statusBar
        }
        #if os(macOS)
        .navigationTitle(note.diaryDate.map(Diary.format) ?? (note.title.isEmpty ? "（無題）" : note.title))
        #else
        // The iPhone shows no title above the text: a note's first line is
        // its title, set large, and a diary entry shows its date above the text.
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup {
                Button("編集履歴", systemImage: "clock.arrow.circlepath") { showHistory = true }
                Button("テキストとして書き出し", systemImage: "square.and.arrow.up") { exporting = true }
                #if os(iOS)
                Button("ポメラから取り込み", systemImage: "qrcode.viewfinder") { importingFromPomera = true }
                #endif
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
        #if os(iOS)
        .fullScreenCover(isPresented: $importingFromPomera) {
            PomeraImportView(target: .append(note)).environment(model)
        }
        #endif
        .fileExporter(isPresented: $exporting, document: TextFile(text: note.text), contentType: .plainText,
                      defaultFilename: note.diaryDate.map { "\($0).txt" } ?? TextFile.filename(for: note.title)) { result in
            if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
        }
    }

    /// Below the text: the length, other devices editing the note, and dates.
    /// On the iPhone: the sync status at the left, the update time at the right.
    private var statusBar: some View {
        VStack(spacing: 0) {
            Divider()
            #if os(iOS)
            HStack(spacing: 8) {
                // While offline, tapping tries to connect at once.
                Button { model.retryIfOffline() } label: {
                    HStack(spacing: 4) {
                        Circle().fill(model.syncColor).frame(width: 7, height: 7)
                        Text(model.syncShortText)
                        if model.status == .offline { Image(systemName: "arrow.clockwise").imageScale(.small) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(model.syncText)
                .accessibilityHint(model.status == .offline ? "タップすると今すぐ接続し直します" : "")
                Spacer(minLength: 8)
                // An entry not written yet has no update time.
                if note.updatedAt.timeIntervalSince1970 > 0 {
                    Text("更新: \(note.updatedAt.formatted(date: .numeric, time: .shortened))")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal)
            .padding(.vertical, 6)
            #else
            Text(statusLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                // Right-aligned and cut at the start, so the dates stay in view.
                .truncationMode(.head)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal)
                .padding(.vertical, 6)
            #endif
        }
        .background(.bar)
    }

    private var statusLine: String {
        var parts = ["\(note.characterCount.formatted()) 文字"]
        if !note.editors.isEmpty { parts.append("編集中: " + note.editors.joined(separator: "、")) }
        let created = note.createdAt.formatted(date: .numeric, time: .shortened)
        let updated = note.updatedAt.formatted(date: .numeric, time: .shortened)
        if let date = note.diaryDate {
            parts.append("\(Diary.format(date))の日記")
            // An entry not written yet has no times.
            if note.updatedAt.timeIntervalSince1970 > 0 { parts.append("更新: \(updated)") }
        } else {
            parts += ["作成: \(created)", "更新: \(updated)"]
        }
        return parts.joined(separator: "　")
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
