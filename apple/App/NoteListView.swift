import SimpleEditorCore
import SimpleEditorModel
import SwiftUI

struct NoteListView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool
    @State private var exportedZip: ZipFile?
    @State private var exporting = false

    var body: some View {
        @Bindable var model = model
        List(selection: selection) {
            ForEach(model.visibleNotes) { item in
                NoteRow(item: item, query: model.searchText)
                    .tag(item.id)
            }
        }
        .searchable(text: $model.searchText, prompt: "検索（メモと日記）")
        .safeAreaInset(edge: .top) {
            VStack(spacing: 0) {
                Picker("表示", selection: $model.mode) {
                    Text("メモ").tag(SidebarMode.notes)
                    Text("日記").tag(SidebarMode.diary)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal)
                .padding(.top, 6)
                if model.mode == .notes {
                    TagFilterBar()
                } else {
                    DiaryCalendarView()
                }
            }
            .background(.bar)
        }
        .safeAreaInset(edge: .bottom) { StatusBar() }
        .overlay {
            if model.mode == .diary, model.searchText.isEmpty, model.visibleNotes.isEmpty {
                Text("この月の日記はまだありません。カレンダーの日付を選ぶと書けます")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
            }
        }
        .navigationTitle(model.mode == .diary ? "日記" : "メモ")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if model.mode == .diary {
                    Button("今日の日記", systemImage: "calendar") { model.openDiary(date: Diary.today) }
                        .disabled(model.phase != .ready)
                } else {
                    Button("新規ノート", systemImage: "square.and.pencil") { model.createNote() }
                        .disabled(model.phase != .ready)
                }
            }
            ToolbarItem {
                Menu("その他", systemImage: "ellipsis.circle") {
                    Button("設定と端末", systemImage: "gearshape") { showSettings = true }
                    Button("すべて書き出し (.zip)", systemImage: "square.and.arrow.up") { exportAll() }
                }
                .disabled(model.phase != .ready)
            }
        }
        .refreshable { await model.refresh() }
        .fileExporter(isPresented: $exporting, document: exportedZip, contentType: .zip,
                      defaultFilename: exportedZip?.filename) { result in
            if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
        }
    }

    private var selection: Binding<String?> {
        Binding(get: { model.current?.id }, set: { id in
            if let id, let date = Diary.date(ofNote: id) {
                model.openDiary(date: date)
            } else if let id {
                model.select(id: id)
            } else {
                model.closeCurrent()
            }
        })
    }

    private func exportAll() {
        Task {
            do {
                let url = try await model.exportAll()
                exportedZip = ZipFile(data: try Data(contentsOf: url), filename: url.lastPathComponent)
                exporting = true
            } catch {
                model.errorMessage = AppModel.describe(error)
            }
        }
    }
}

private struct NoteRow: View {
    let item: ListedNote
    let query: String

    var body: some View {
        let date = Diary.date(ofNote: item.id)
        VStack(alignment: .leading, spacing: 2) {
            if let date {
                Text(Diary.format(date))
                    .font(.headline)
                    .lineLimit(1)
                Text(item.snippet ?? [item.summary.title, item.summary.preview].filter { !$0.isEmpty }.joined(separator: " "))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text(item.summary.title.isEmpty ? "（無題）" : item.summary.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(item.snippet ?? item.summary.preview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                if date == nil {
                    Text(Date(timeIntervalSince1970: Double(item.summary.updatedAt) / 1000), format: .dateTime.year().month().day().hour().minute())
                } else if !query.isEmpty {
                    Text("日記")
                }
                ForEach(item.summary.tags, id: \.self) { Text("#\($0)") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

private struct TagFilterBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                chip("すべて", .all)
                ForEach(model.allTags, id: \.self) { chip("#\($0)", .tag($0)) }
                chip("ゴミ箱", .trash)
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
        .background(.bar)
    }

    private func chip(_ label: String, _ value: NoteFilter) -> some View {
        Button(label) { model.filter = value }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .tint(model.filter == value ? Color.accentColor : Color.secondary)
    }
}

private struct StatusBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text).font(.caption).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal)
        .padding(.vertical, 6)
        .background(.bar)
    }

    private var text: String {
        if case .needsRegistration = model.phase { return "未登録" }
        switch model.status {
        case .online: return "同期中"
        case .connecting: return "接続中…"
        case .offline: return "オフライン（変更はこの端末に保存され、接続後に送られます）"
        case .unauthorized: return "未登録"
        case .rateLimited: return "認証の失敗が続いたため一時停止中"
        }
    }

    private var color: Color {
        switch model.status {
        case .online: .green
        case .connecting, .offline: .orange
        case .unauthorized, .rateLimited: .red
        }
    }
}
