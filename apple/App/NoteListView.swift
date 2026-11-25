import SimpleEditorCore
import SimpleEditorModel
import SwiftUI

struct NoteListView: View {
    @Environment(AppModel.self) private var model
    @Binding var showSettings: Bool
    @State private var exportedZip: ZipFile?
    @State private var exporting = false
    @State private var importingFromPomera = false

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
                    Text("日記").tag(SidebarMode.diary)
                    Text("メモ").tag(SidebarMode.notes)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.horizontal)
                .padding(.top, 4)
                if model.mode == .notes {
                    TagFilterBar()
                    #if os(macOS)
                    // The iPhone keeps the list short: no year, month, or excluded tags.
                    ListFilterBar()
                    #endif
                } else {
                    DiaryCalendarView()
                }
            }
            .background(.bar)
        }
        #if os(macOS)
        .safeAreaInset(edge: .bottom) { StatusBar() }
        #endif
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
        #if os(iOS)
        // A large title would leave a tall empty band above the tabs; the
        // tabs already say which list this is.
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            #if os(iOS)
            // The sync status and the build number sit at the top left.
            ToolbarItem(placement: .topBarLeading) { StatusBar(compact: true) }
            #endif
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
                #if os(macOS)
                // Exporting everything is in the File menu (SimpleEditorApp).
                Button("設定と端末", systemImage: "gearshape") { showSettings = true }
                    .help("設定と端末")
                    .disabled(model.phase != .ready)
                #else
                Menu("その他", systemImage: "ellipsis.circle") {
                    Button("設定と端末", systemImage: "gearshape") { showSettings = true }
                    Button("すべて書き出し (.zip)", systemImage: "square.and.arrow.up") { exportAll() }
                    Button("ポメラから取り込み", systemImage: "qrcode.viewfinder") { importingFromPomera = true }
                }
                .disabled(model.phase != .ready)
                #endif
            }
        }
        #if os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: .exportAllRequested)) { _ in exportAll() }
        #endif
        .refreshable { await model.refreshByUser() }
        #if os(iOS)
        .fullScreenCover(isPresented: $importingFromPomera) {
            PomeraImportView(target: model.mode == .diary ? .diary : .newNote).environment(model)
        }
        #endif
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

extension Notification.Name {
    /// File > Export All, on macOS; the note list does the export.
    static let exportAllRequested = Notification.Name("SimpleEditor.exportAllRequested")
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
                Text(highlighted(item.snippet ?? [item.summary.title, item.summary.preview].filter { !$0.isEmpty }.joined(separator: " ")))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else {
                Text(item.summary.title.isEmpty ? AttributedString("（無題）") : highlighted(item.summary.title))
                    .font(.headline)
                    .lineLimit(1)
                Text(highlighted(item.snippet ?? item.summary.preview))
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

    /// The text with the searched words marked, as in the web app.
    private func highlighted(_ text: String) -> AttributedString {
        var attributed = AttributedString(text)
        for match in SearchMatch.ranges(of: query, in: text, limit: 50) {
            guard let range = Range(match, in: text),
                  let lower = AttributedString.Index(range.lowerBound, within: attributed),
                  let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
            attributed[lower..<upper].backgroundColor = Color.yellow.opacity(0.4)
            attributed[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
        }
        return attributed
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

/// The creation year and month, and the tags whose notes are left out.
private struct ListFilterBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text("作成").font(.caption).foregroundStyle(.secondary)
                Picker("作成年", selection: $model.createdFilter.year) {
                    Text("すべての年").tag(Int?.none)
                    ForEach(model.createdYears, id: \.self) { Text(verbatim: "\($0)年").tag(Int?.some($0)) }
                }
                Picker("作成月", selection: $model.createdFilter.month) {
                    Text("すべての月").tag(Int?.none)
                    ForEach(1...12, id: \.self) { Text(verbatim: "\($0)月").tag(Int?.some($0)) }
                }
                Spacer(minLength: 0)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Text("除外").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.excludedTags, id: \.self) { tag in
                        Button { model.include(tag: tag) } label: {
                            Label("#\(tag)", systemImage: "xmark").labelStyle(TrailingIcon())
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(Color.accentColor)
                        .help("#\(tag) の除外をやめる")
                        .accessibilityLabel("#\(tag) の除外をやめる")
                    }
                    let candidates = model.allTags.filter { !model.excludedTags.contains($0) }
                    if !candidates.isEmpty {
                        Menu("＋ タグ") {
                            ForEach(candidates, id: \.self) { tag in
                                Button("#\(tag)") { model.exclude(tag: tag) }
                            }
                        }
                        .accessibilityLabel("除外するタグ")
                        .fixedSize()
                    } else if model.excludedTags.isEmpty {
                        Text("タグなし").font(.caption).foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .pickerStyle(.menu)
        .labelsHidden()
        .controlSize(.small)
        .padding(.horizontal)
        .padding(.bottom, 6)
        .background(.bar)
    }

    /// The title, then the icon: "#tag ×".
    private struct TrailingIcon: LabelStyle {
        func makeBody(configuration: Configuration) -> some View {
            HStack(spacing: 3) {
                configuration.title
                configuration.icon.imageScale(.small)
            }
        }
    }
}

private struct StatusBar: View {
    @Environment(AppModel.self) private var model
    /// Small, for the navigation bar: short texts on one line each.
    var compact = false

    var body: some View {
        if compact { compactBody } else { fullBody }
    }

    private var compactBody: some View {
        Button { model.retryIfOffline() } label: {
            VStack(alignment: .leading, spacing: 0) {
                // Full contrast: the navigation bar's material washes out
                // the secondary styles.
                HStack(spacing: 4) {
                    Circle().fill(color).frame(width: 7, height: 7)
                    Text(shortText).font(.caption.weight(.semibold)).foregroundStyle(.primary)
                    if model.status == .offline {
                        Image(systemName: "arrow.clockwise").font(.caption2.weight(.semibold)).foregroundStyle(.primary)
                    }
                }
                Text("build \(BuildInfo.number)").font(.caption2.weight(.medium)).foregroundStyle(.primary)
            }
            .lineLimit(1)
            .fixedSize()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(text)
        .accessibilityHint(model.status == .offline ? "タップすると今すぐ接続し直します" : "")
    }

    private var shortText: String {
        if case .needsRegistration = model.phase { return "未登録" }
        switch model.status {
        case .offline: return "オフライン"
        case .rateLimited: return "一時停止中"
        default: return text
        }
    }

    private var fullBody: some View {
        // While offline, tapping tries to connect at once instead of waiting
        // for the next retry.
        Button { model.retryIfOffline() } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle().fill(color).frame(width: 8, height: 8)
                    Text(text).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    if model.status == .offline {
                        Image(systemName: "arrow.clockwise").font(.caption).foregroundStyle(.secondary)
                    }
                }
                // Generated for every build (the Build number script phase).
                Text("build \(BuildInfo.number)").font(.caption2).foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(model.status == .offline ? "タップすると今すぐ接続し直します" : "")
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
