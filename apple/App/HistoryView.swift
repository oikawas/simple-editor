import SimpleEditorCore
import SimpleEditorModel
import SwiftUI

/// A note's versions, with a diff against the current text, and restore.
struct HistoryView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let note: OpenNote
    @State private var versions: [VersionInfo] = []
    @State private var selected: Int64?
    @State private var shown: Version?
    @State private var showDiff = true
    @State private var message: String?

    var body: some View {
        NavigationStack {
            layout
                .navigationTitle("編集履歴")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("閉じる") { dismiss() }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("この版に戻す") {
                            if let shown {
                                note.restore(shown)
                                model.currentNoteChanged()
                                dismiss()
                            }
                        }
                        .disabled(shown == nil)
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 820, minHeight: 560)
        #endif
        .task { await load() }
        .onChange(of: selected) { _, id in
            guard let id else { return }
            Task {
                let version = try? await model.version(of: note, id: id)
                if selected == id { shown = version }
            }
        }
    }

    @ViewBuilder private var layout: some View {
        #if os(macOS)
        HStack(spacing: 0) {
            versionList.frame(width: 260)
            Divider()
            detail
        }
        #else
        VStack(spacing: 0) {
            versionList.frame(maxHeight: 240)
            Divider()
            detail
        }
        #endif
    }

    private var versionList: some View {
        List(selection: $selected) {
            if let message {
                Text(message).foregroundStyle(.secondary)
            }
            ForEach(Array(versions.enumerated()), id: \.element.id) { index, v in
                VStack(alignment: .leading, spacing: 2) {
                    Text(date(v.savedAt) + (index == 0 ? "（最新）" : "")).font(.headline)
                    Text("\(v.title.isEmpty ? "（無題）" : v.title) · \(v.length) 文字")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .tag(v.id)
            }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("表示", selection: $showDiff) {
                Text("現在との差分").tag(true)
                Text("この版の全文").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if let shown {
                Text("\(date(shown.savedAt)) の版　タグ: \(shown.tags.isEmpty ? "なし" : shown.tags.map { "#\($0)" }.joined(separator: " "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ScrollView {
                    lines(for: shown)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            } else {
                Spacer()
            }
            Text("戻すと、本文とタグがこの版の内容に置き換わります。置き換える前の内容も履歴に残ります。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
    }

    @ViewBuilder private func lines(for version: Version) -> some View {
        let diff = showDiff ? lineDiff(from: note.text, to: version.body) : nil
        VStack(alignment: .leading, spacing: 0) {
            if let diff, diff.allSatisfy({ $0.kind == .same }) {
                Text("現在の本文と同じです").foregroundStyle(.secondary)
            } else if let diff {
                Text("＋ 戻すと加わる行　− 戻すと消える行").font(.caption).foregroundStyle(.secondary).padding(.bottom, 4)
                ForEach(Array(diff.enumerated()), id: \.offset) { _, line in
                    row(line)
                }
            } else {
                if showDiff {
                    Text("差分を表示するには大きすぎるため、全文を表示しています").font(.caption).foregroundStyle(.secondary)
                }
                Text(version.body)
            }
        }
    }

    private func row(_ line: DiffLine) -> some View {
        let (prefix, color): (String, Color) = switch line.kind {
        case .same: ("  ", .clear)
        case .added: ("+ ", .green.opacity(0.18))
        case .removed: ("− ", .red.opacity(0.18))
        }
        return Text(prefix + (line.text.isEmpty ? " " : line.text))
            .strikethrough(line.kind == .removed)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(color)
    }

    private func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .numeric, time: .standard)
    }

    private func load() async {
        do {
            versions = try await model.versions(of: note)
            if versions.isEmpty { message = "まだ履歴がありません" }
            // The newest version is usually what is on screen; start with the one before it.
            selected = versions.count > 1 ? versions[1].id : versions.first?.id
        } catch {
            message = AppModel.describe(error)
        }
    }
}
