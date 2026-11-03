import Network
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

    @Environment(\.scenePhase) private var scenePhase
    @State private var network = NetworkWatcher()
    @State private var backgroundSince: Date?

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(model)
                .task {
                    model.start()
                    network.start { model.reconnectNow() }
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                backgroundSince = Date()
            case .active:
                // While suspended the app sends no keepalives, so the server
                // may have closed the connection without the app noticing.
                if let since = backgroundSince,
                   Date().timeIntervalSince(since) >= Self.staleAfter || model.status != .online {
                    model.reconnectNow()
                }
                backgroundSince = nil
            default:
                break
            }
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

    /// Time in the background after which the connection is assumed lost.
    static let staleAfter: TimeInterval = 20

    @MainActor static var deviceName: String {
        #if os(iOS)
        UIDevice.current.name
        #else
        Host.current().localizedName ?? "Mac"
        #endif
    }
}

/// Reports when the network comes back: the path becomes usable again, or a
/// usable path moves to other interfaces (Wi-Fi to cellular, say), which
/// leaves the old connection dead.
@MainActor
final class NetworkWatcher {
    private let monitor = NWPathMonitor()
    private var wasSatisfied: Bool?
    private var interfaces: [String] = []
    private var started = false

    /// Starts watching; later calls do nothing.
    func start(onReturn: @escaping @MainActor () -> Void) {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let interfaces = path.availableInterfaces.map(\.name)
            Task { @MainActor in
                guard let self else { return }
                defer {
                    self.wasSatisfied = satisfied
                    self.interfaces = interfaces
                }
                // The first report only says how things stand at launch.
                guard let was = self.wasSatisfied, satisfied else { return }
                if !was || interfaces != self.interfaces { onReturn() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "simple-editor.network"))
    }
}
