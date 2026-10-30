import SimpleEditorModel
import SwiftUI

struct ContentView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false

    var body: some View {
        NavigationSplitView {
            NoteListView(showSettings: $showSettings)
                .navigationSplitViewColumnWidth(min: 240, ideal: 300)
        } detail: {
            if let note = model.current {
                EditorView(note: note)
                    .id(note.id)
            } else {
                ContentUnavailableView("ノートを選択するか、新規作成してください", systemImage: "note.text")
            }
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
