import Foundation
import Observation
import SimpleEditorCore

public enum NoteFilter: Hashable, Sendable {
    case all
    case tag(String)
    case trash
}

/// A note in the list, with the search excerpt when it matched on the server.
public struct ListedNote: Identifiable, Sendable {
    public let summary: NoteSummary
    public let snippet: String?
    public var id: String { summary.id }
}

/// Core events, delivered to the main actor.
enum CoreEvent: Sendable {
    case status(SyncStatus)
    case notesChanged
    case noteChanged(String)
}

final class Listener: ClientListener, @unchecked Sendable {
    let continuation: AsyncStream<CoreEvent>.Continuation

    init(_ continuation: AsyncStream<CoreEvent>.Continuation) {
        self.continuation = continuation
    }

    func onStatus(status: SyncStatus) { continuation.yield(.status(status)) }
    func onNotesChanged() { continuation.yield(.notesChanged) }
    func onNoteChanged(id: String) { continuation.yield(.noteChanged(id)) }
}

/// Everything the app shows and does, independent of the UI toolkit.
@MainActor
@Observable
public final class AppModel {
    public enum Phase: Equatable, Sendable {
        case starting
        /// This device has to be registered; the message says why, if there is a reason.
        case needsRegistration(String?)
        case ready
    }

    public private(set) var phase: Phase = .starting
    public private(set) var status: SyncStatus = .connecting
    public private(set) var settings: StoredSettings
    public private(set) var notes: [NoteSummary] = []
    public private(set) var current: OpenNote?
    public var filter: NoteFilter = .all
    public var searchText = "" {
        didSet { if searchText != oldValue { searchChanged() } }
    }
    /// Server-side matches for `searchText`: note id -> excerpt.
    public private(set) var searchHits: [String: String]?
    /// An error to show the user.
    public var errorMessage: String?

    @ObservationIgnored private var client: Client?
    @ObservationIgnored private let tokens: TokenStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let dataDirectory: URL
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?

    public init(tokens: TokenStore, defaults: UserDefaults = .standard, dataDirectory: URL, defaultDeviceName: String) {
        self.tokens = tokens
        self.defaults = defaults
        self.dataDirectory = dataDirectory
        var settings = StoredSettings.load(from: defaults)
        if settings.deviceName.isEmpty { settings.deviceName = defaultDeviceName }
        self.settings = settings
    }

    /// Connects with the stored token, or asks for registration.
    public func start() {
        guard phase == .starting else { return }
        if !settings.serverURL.isEmpty, let token = tokens.load(server: settings.serverURL) {
            connect(token: token)
        } else {
            phase = .needsRegistration(nil)
        }
    }

    // MARK: Registration and connection

    /// Registers this device with the server's registration token. The
    /// registration token is not kept; the device token goes to the TokenStore.
    public func register(serverURL: String, deviceName: String, registrationToken: String) async throws {
        let url = normalizeServerURL(serverURL)
        let name = deviceName.trimmingCharacters(in: .whitespaces).isEmpty ? settings.deviceName : deviceName
        let credentials = try await registerDevice(serverUrl: url, registrationToken: registrationToken, deviceName: name)
        try tokens.save(server: url, token: credentials.token)
        settings = StoredSettings(serverURL: url, deviceID: credentials.id, deviceName: name)
        settings.save(to: defaults)
        connect(token: credentials.token)
    }

    private func connect(token: String) {
        disconnect()
        let (stream, continuation) = AsyncStream.makeStream(of: CoreEvent.self)
        let config = ClientConfig(serverUrl: settings.serverURL, deviceToken: token, dataDir: dataDirectory.path)
        do {
            let client = try Client(config: config, listener: Listener(continuation))
            self.client = client
            notes = (try? client.cachedNotes()) ?? []
            phase = .ready
            eventTask = Task { [weak self] in
                for await event in stream {
                    self?.handle(event)
                }
            }
            scheduleRefresh()
        } catch {
            errorMessage = Self.describe(error)
            phase = .needsRegistration(nil)
        }
    }

    private func disconnect() {
        closeCurrent()
        eventTask?.cancel()
        client?.shutdown()
        client = nil
    }

    /// This device's registration is gone: forget the token and ask again.
    private func forgetRegistration(_ message: String) {
        disconnect()
        tokens.delete(server: settings.serverURL)
        phase = .needsRegistration(message)
    }

    func handle(_ event: CoreEvent) {
        switch event {
        case .status(let s):
            status = s
            if s == .online { scheduleRefresh() }
            if s == .unauthorized {
                forgetRegistration("この端末の登録が解除されたか、無効になっています。登録用トークンで登録し直してください。")
            }
        case .notesChanged:
            scheduleRefresh()
        case .noteChanged(let id):
            if let current, current.id == id {
                current.applyRemote()
                updateListEntry(current.summary)
            }
        }
    }

    // MARK: Note list and search

    func scheduleRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            await self?.refresh()
        }
    }

    public func refresh() async {
        guard let client else { return }
        do {
            notes = try await client.notes()
            if let current { updateListEntry(current.summary) }
            if !searchText.isEmpty { await runSearch() }
        } catch CoreError.Unauthorized {
            // The sync status reports this too and triggers re-registration.
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    private func searchChanged() {
        searchTask?.cancel()
        searchTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            await self?.runSearch()
        }
    }

    private func runSearch() async {
        let query = searchText.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty, let client else {
            searchHits = nil
            return
        }
        let hits = try? await client.search(query: query)
        // A newer query may have started meanwhile.
        guard query == searchText.trimmingCharacters(in: .whitespaces) else { return }
        searchHits = hits.map { Dictionary($0.map { ($0.id, $0.snippet) }, uniquingKeysWith: { a, _ in a }) }
    }

    /// The notes to list for the current filter and search, newest first.
    /// Matches are the server's full-text hits plus local matches on title,
    /// preview, tags, and the open note's text (which also works offline).
    public var visibleNotes: [ListedNote] {
        let terms = searchText.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        let openBody = current.map { ($0.id, $0.text.lowercased()) }
        return notes
            .filter { filter == .trash ? $0.deleted : !$0.deleted }
            .filter { if case .tag(let t) = filter { return $0.tags.contains(t) } else { return true } }
            .compactMap { note in
                if terms.isEmpty { return ListedNote(summary: note, snippet: nil) }
                let snippet = searchHits?[note.id]
                var haystack = ([note.title, note.preview] + note.tags).joined(separator: "\n").lowercased()
                if let (id, body) = openBody, id == note.id { haystack += "\n" + body }
                let local = terms.allSatisfy { haystack.contains($0) }
                return snippet != nil || local ? ListedNote(summary: note, snippet: snippet) : nil
            }
    }

    /// Tags on notes outside the trash.
    public var allTags: [String] {
        Array(Set(notes.filter { !$0.deleted }.flatMap(\.tags))).sorted()
    }

    private func updateListEntry(_ summary: NoteSummary) {
        if let i = notes.firstIndex(where: { $0.id == summary.id }) {
            guard notes[i] != summary else { return }
            notes[i] = summary
        } else {
            notes.append(summary)
        }
        notes.sort { $0.updatedAt > $1.updatedAt }
    }

    // MARK: Editing

    public func select(id: String) {
        guard let client, current?.id != id else { return }
        closeCurrent()
        do {
            current = OpenNote(note: try client.openNote(id: id))
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    @discardableResult
    public func createNote() -> OpenNote? {
        guard let client else { return nil }
        closeCurrent()
        if filter == .trash { filter = .all }
        do {
            let open = OpenNote(note: try client.createNote())
            if case .tag(let tag) = filter { open.addTag(tag) }
            current = open
            updateListEntry(open.summary)
            return open
        } catch {
            errorMessage = Self.describe(error)
            return nil
        }
    }

    public func closeCurrent() {
        guard let current else { return }
        client?.closeNote(id: current.id)
        self.current = nil
    }

    /// The open note was edited: reflect it in the list.
    public func currentNoteChanged() {
        if let current { updateListEntry(current.summary) }
    }

    // MARK: Devices, history, export

    public func devices() async throws -> [DeviceInfo] {
        try await requireClient().devices()
    }

    public func renameDevice(_ name: String) async throws {
        let name = name.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        try await requireClient().renameThisDevice(name: name)
        settings.deviceName = name
        settings.save(to: defaults)
    }

    /// Revokes a device; revoking this one returns to registration.
    public func revoke(_ device: DeviceInfo) async throws {
        try await requireClient().revokeDevice(deviceId: device.id)
        if device.current {
            forgetRegistration("この端末の登録を解除しました。")
        }
    }

    public func versions(of note: OpenNote) async throws -> [VersionInfo] {
        try await requireClient().versions(noteId: note.id)
    }

    public func version(of note: OpenNote, id: Int64) async throws -> Version {
        try await requireClient().version(noteId: note.id, versionId: id)
    }

    /// Writes all notes as a zip to a temporary file and returns its URL.
    public func exportAll() async throws -> URL {
        let stamp = ISO8601DateFormatter.string(from: Date(), timeZone: .current, formatOptions: [.withFullDate])
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("notes-\(stamp).zip")
        try? FileManager.default.removeItem(at: url)
        try await requireClient().exportZip(path: url.path, includeTrash: false)
        return url
    }

    private func requireClient() throws -> Client {
        guard let client else { throw CoreError.Unauthorized }
        return client
    }

    /// A message for the user, in Japanese.
    public static func describe(_ error: Error, registering: Bool = false) -> String {
        switch error as? CoreError {
        case .Unauthorized?:
            return registering ? "登録用トークンが違います。" : "この端末の登録が無効になっています。"
        case .RateLimited(let seconds)?:
            return "失敗が続いたため、一時的に受け付けを停止しています。\((seconds + 59) / 60) 分ほど待ってから試してください。"
        case .Network(let message)?:
            return "サーバーに接続できません。URL とネットワークを確認してください。\n（\(message)）"
        case .NotFound?:
            return "見つかりませんでした。"
        case .Server(let status)?:
            return "サーバーでエラーが発生しました (\(status))。"
        case .Other(let message)?:
            return message
        case nil:
            return error.localizedDescription
        }
    }
}
