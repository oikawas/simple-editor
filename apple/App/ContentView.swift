import SimpleEditorModel
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    /// On iPhone, which column is shown; opening a note (or a day from the
    /// calendar, which is not a list selection) shows the editor.
    @State private var compactColumn = NavigationSplitViewColumn.sidebar

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            NoteListView(showSettings: $showSettings)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300)
        } detail: {
            if let note = model.current {
                EditorView(note: note)
                    .id(note.id)
            } else {
                if model.mode == .diary {
                    ContentUnavailableView("カレンダーの日付を選ぶと、その日の日記を書けます", systemImage: "calendar")
                } else {
                    ContentUnavailableView("ノートを選択するか、新規作成してください", systemImage: "note.text")
                }
            }
        }
        .onChange(of: model.current?.id) { _, id in
            if id != nil { compactColumn = .detail }
        }
        .sheet(isPresented: registrationShown) {
            RegistrationView()
                .interactiveDismissDisabled()
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .alert("エラー", isPresented: errorShown) {
            Button("OK") { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private var registrationShown: Binding<Bool> {
        Binding(
            get: { if case .needsRegistration = model.phase { true } else { false } },
            set: { _ in }
        )
    }

    private var errorShown: Binding<Bool> {
        Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })
    }
}
