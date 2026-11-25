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
    case editors(String, [String])
}

final class Listener: ClientListener, @unchecked Sendable {
    let continuation: AsyncStream<CoreEvent>.Continuation

    init(_ continuation: AsyncStream<CoreEvent>.Continuation) {
        self.continuation = continuation
    }

    func onStatus(status: SyncStatus) { continuation.yield(.status(status)) }
    func onNotesChanged() { continuation.yield(.notesChanged) }
    func onNoteChanged(id: String) { continuation.yield(.noteChanged(id)) }
    func onEditorsChanged(id: String, names: [String]) { continuation.yield(.editors(id, names)) }
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
    /// Notes created in a year and/or month; not kept.
    public var createdFilter = CreatedFilter()
    /// Tags whose notes are left out of the notes tab; kept per device.
    public var excludedTags: [String] = [] {
        didSet { defaults.set(excludedTags, forKey: Self.excludedTagsKey) }
    }
    /// Notes or the diary; kept per device.
    public var mode: SidebarMode = .notes {
        didSet { defaults.set(mode.rawValue, forKey: Self.modeKey) }
    }
    /// The month the diary's calendar shows.
    public var shownMonth = YearMonth(date: Diary.today)!
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
    @ObservationIgnored private let cursors: CursorMemory
    /// Other devices editing each note, as the core last reported.
    @ObservationIgnored private var editorsByNote: [String: [String]] = [:]
    @ObservationIgnored private let dataDirectory: URL
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    @ObservationIgnored private var reopenedLastNote = false
    private static let modeKey = "sidebarMode"
    static let excludedTagsKey = "simple-editor.excludedTags"
    /// The note open on this device when the app was last used, reopened at launch.
    static let lastNoteKey = "simple-editor.lastNote"
    /// Seconds between reconnection attempts while the server stays out of
    /// reach. A dropped connection is first retried after 1 second; asking to
    /// refresh, the network coming back, or returning to the app retries at once.
    public static let retryIntervalSeconds: UInt32 = 15 * 60

    public init(tokens: TokenStore, defaults: UserDefaults = .standard, dataDirectory: URL, defaultDeviceName: String) {
        self.tokens = tokens
        self.defaults = defaults
        self.cursors = CursorMemory(defaults: defaults)
        self.dataDirectory = dataDirectory
        var settings = StoredSettings.load(from: defaults)
        if settings.deviceName.isEmpty { settings.deviceName = defaultDeviceName }
        self.settings = settings
        self.mode = defaults.string(forKey: Self.modeKey).flatMap(SidebarMode.init) ?? .notes
        self.excludedTags = defaults.stringArray(forKey: Self.excludedTagsKey) ?? []
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
        let config = ClientConfig(
            serverUrl: settings.serverURL, deviceToken: token, dataDir: dataDirectory.path,
            retryIntervalSecs: Self.retryIntervalSeconds, deviceName: settings.deviceName
        )
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
            reopenLastNote()
        } catch {
            errorMessage = Self.describe(error)
            phase = .needsRegistration(nil)
        }
    }

    /// Connects again at once, e.g. when the network comes back or the app
    /// returns to the foreground, instead of waiting for the next retry.
    /// Skipped when the server refused this device or asked it to wait:
    /// trying again would only count as another failure.
    public func reconnectNow() {
        guard let client else { return }
        switch status {
        case .unauthorized, .rateLimited: return
        default: client.reconnect(deviceToken: nil)
        }
    }

    /// Tries to connect at once if offline, e.g. when the user asks to refresh.
    public func retryIfOffline() {
        if status == .offline { reconnectNow() }
    }

    /// A refresh the user asked for: reconnects if offline, then reloads the list.
    public func refreshByUser() async {
        retryIfOffline()
        await refresh()
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
        case .editors(let id, let names):
            editorsByNote[id] = names.isEmpty ? nil : names
            if let current, current.id == id { current.editors = names }
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

    /// The notes to list, newest first: without a search, the notes for the
    /// filter, or the shown month's diary entries (newest day first). A search
    /// covers notes and diary entries alike, in either mode. Matches are the
    /// server's full-text hits plus local matches on title, preview, tags, and
    /// the open note's text (which also works offline).
    public var visibleNotes: [ListedNote] {
        let terms = searchText.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        if terms.isEmpty && mode == .diary {
            return notes
                .filter { isWritten($0) && Diary.date(ofNote: $0.id).map(shownMonth.contains) == true }
                .sorted { $0.id > $1.id }
                .map { ListedNote(summary: $0, snippet: nil) }
        }
        let filter = mode == .notes ? self.filter : .all
        let openBody = current.map { ($0.id, $0.text.lowercased()) }
        return notes
            .filter { note in
                if Diary.date(ofNote: note.id) != nil { return !terms.isEmpty && filter != .trash && isWritten(note) }
                return filter == .trash ? note.deleted : !note.deleted
            }
            .filter { if case .tag(let t) = filter { return $0.tags.contains(t) } else { return true } }
            // The year, month, and excluded tags narrow the notes tab only, and
            // leave diary entries found by a search alone. The trash ignores
            // excluded tags.
            .filter { note in
                guard mode == .notes, Diary.date(ofNote: note.id) == nil else { return true }
                guard createdFilter.matches(createdAt: note.createdAt) else { return false }
                return filter == .trash || !note.tags.contains(where: excludedTags.contains)
            }
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
    /// The years memos were created in, newest first, with the chosen year
    /// kept even when no memo is left in it.
    public var createdYears: [Int] {
        let years = CreatedFilter.years(of: notes.filter { Diary.date(ofNote: $0.id) == nil }.map(\.createdAt))
        guard let year = createdFilter.year, !years.contains(year) else { return years }
        return (years + [year]).sorted(by: >)
    }

    public func exclude(tag: String) {
        guard !excludedTags.contains(tag) else { return }
        excludedTags = (excludedTags + [tag]).sorted()
    }

    public func include(tag: String) {
        excludedTags.removeAll { $0 == tag }
    }

    public var allTags: [String] {
        Array(Set(notes.filter { !$0.deleted && Diary.date(ofNote: $0.id) == nil }.flatMap(\.tags))).sorted()
    }

    /// A diary day counts as written once it has some text.
    private func isWritten(_ note: NoteSummary) -> Bool { !note.title.isEmpty }

    /// Days of the shown month with something written, for the calendar.
    public var writtenDays: Set<Int> {
        Set(notes.compactMap { note in
            guard isWritten(note), let date = Diary.date(ofNote: note.id), shownMonth.contains(date) else { return nil }
            return Int(date.suffix(2))
        })
    }

    /// Opens the diary entry for a date ("YYYY-MM-DD") and shows the diary.
    /// The entry is created by writing in it.
    public func openDiary(date: String) {
        guard let id = diaryNoteId(date: date) else { return }
        mode = .diary
        if let month = YearMonth(date: date) { shownMonth = month }
        select(id: id)
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

    /// Opens the note that was open on this device when the app was last
    /// used, once per launch. The note is read from the device, so one made
    /// just before quitting opens even if the cached list does not have it
    /// yet; a note in the trash is not reopened.
    private func reopenLastNote() {
        guard !reopenedLastNote else { return }
        reopenedLastNote = true
        guard current == nil, let id = defaults.string(forKey: Self.lastNoteKey) else { return }
        if let date = Diary.date(ofNote: id) {
            openDiary(date: date)
        } else {
            select(id: id)
            if let current, current.deleted { closeCurrent() }
        }
    }

    public func select(id: String) {
        guard let client, current?.id != id else { return }
        closeCurrent()
        do {
            let open = OpenNote(note: try client.openNote(id: id))
            // The note opens where the cursor was when it was last left on this device.
            if let saved = cursors.load(id: id, length: open.text.utf16.count) { open.selection = saved }
            show(open)
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    @discardableResult
    public func createNote() -> OpenNote? {
        guard let client else { return nil }
        closeCurrent()
        mode = .notes
        if filter == .trash { filter = .all }
        do {
            let open = OpenNote(note: try client.createNote())
            if case .tag(let tag) = filter { open.addTag(tag) }
            show(open)
            updateListEntry(open.summary)
            return open
        } catch {
            errorMessage = Self.describe(error)
            return nil
        }
    }

    public enum PomeraImportError: Error, Equatable {
        /// The text has no date on its last line, so no diary day to put it in.
        case noDate
    }

    /// Imports a pomera text as a new note. A date on its last line becomes
    /// the creation date.
    @discardableResult
    public func importPomeraNote(_ text: String) -> OpenNote? {
        guard let open = createNote(text: text) else { return nil }
        if let date = PomeraDate.lastLine(of: text), let created = PomeraDate.creationTime(for: date) {
            open.setCreatedAt(created)
            currentNoteChanged()
        }
        return open
    }

    /// Imports a pomera text into the diary entry of the date on its last
    /// line (added at the end if the day has text already), dated that day.
    /// Returns the date; throws `noDate` when there is none.
    @discardableResult
    public func importPomeraDiary(_ text: String) throws -> String {
        guard let date = PomeraDate.lastLine(of: text) else { throw PomeraImportError.noDate }
        openDiary(date: date)
        guard let current, current.diaryDate == date else { return date }
        current.append(text)
        if let created = PomeraDate.creationTime(for: date) { current.setCreatedAt(created) }
        currentNoteChanged()
        return date
    }

    /// A new note holding `text`, e.g. text imported from a pomera.
    @discardableResult
    public func createNote(text: String) -> OpenNote? {
        guard let open = createNote() else { return nil }
        open.append(text)
        currentNoteChanged()
        return open
    }

    /// Adds `text` at the end of the open note.
    public func appendToCurrent(_ text: String) {
        guard let current else { return }
        current.append(text)
        currentNoteChanged()
    }

    /// Shows a note, and tells other devices this one is editing it.
    private func show(_ open: OpenNote) {
        open.editors = editorsByNote[open.id] ?? []
        current = open
        client?.setActiveNote(id: open.id)
        defaults.set(open.id, forKey: Self.lastNoteKey)
    }

    public func closeCurrent() {
        guard let current else { return }
        rememberCursor()
        // Closed by the user (or replaced by another note): not reopened at launch.
        defaults.removeObject(forKey: Self.lastNoteKey)
        // A note with unsent changes stays open in the core, so say so apart.
        client?.setActiveNote(id: nil)
        client?.closeNote(id: current.id)
        self.current = nil
    }

    /// Saves where the cursor is in the open note, e.g. before the app goes
    /// to the background, where it may be ended without closing the note.
    public func rememberCursor() {
        guard let current else { return }
        cursors.save(id: current.id, selection: current.selection)
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
    /// What to do when the server's certificate is not trusted, which on a
    /// new device usually means its root certificate is not installed yet.
    static let certificateHelp = "サーバーの証明書を確認できません。この端末でサーバーのルート証明書（http://<サーバー>/ca.crt）を入れて信頼しているか確認してください。Mac はキーチェーンアクセスで「常に信頼」に、iPhone・iPad は「設定」→「一般」→「情報」→「証明書信頼設定」でオンにします。"

    public static func describe(_ error: Error, registering: Bool = false) -> String {
        switch error as? CoreError {
        case .Unauthorized?:
            return registering ? "登録用トークンが違います。" : "この端末の登録が無効になっています。"
        case .RateLimited(let seconds)?:
            return "失敗が続いたため、一時的に受け付けを停止しています。\((seconds + 59) / 60) 分ほど待ってから試してください。"
        case .Network(let message)?:
            return "サーバーに接続できません。URL とネットワークを確認してください。\n（\(message)）"
        case .Certificate(let message)?:
            return Self.certificateHelp + "\n（\(message)）"
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
