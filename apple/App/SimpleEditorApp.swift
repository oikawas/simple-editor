import SimpleEditorModel
import SwiftUI
#if os(iOS)
import UIKit
#endif

@main
struct SimpleEditorApp: App {
    @State private var model = AppModel(
        tokens: KeychainTokenStore(),
        dataDirectory: URL.applicationSupportDirectory.appending(path: "SimpleEditor"),
        defaultDeviceName: Self.deviceName
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task { model.start() }
        }
        #if os(macOS)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新規ノート") { model.createNote() }
                    .keyboardShortcut("n")
                    .disabled(model.phase != .ready)
            }
        }
        #endif
    }

    @MainActor static var deviceName: String {
        #if os(iOS)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }
}
