import Foundation
#if canImport(Security)
import Security
#endif

/// Where this device's token is kept.
public protocol TokenStore: Sendable {
    func load(server: String) -> String?
    func save(server: String, token: String) throws
    func delete(server: String)
}

#if canImport(Security)
/// The Keychain, one item per server.
public struct KeychainTokenStore: TokenStore {
    let service = "io.github.oikawas.SimpleEditor.device-token"

    public init() {}

    private func query(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server]
    }

    public func load(server: String) -> String? {
        var q = query(server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func save(server: String, token: String) throws {
        delete(server: server)
        var q = query(server)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    public func delete(server: String) {
        SecItemDelete(query(server) as CFDictionary)
    }
}
#endif

/// Keeps tokens in memory only; for tests.
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [String: String] = [:]

    public init() {}

    public func load(server: String) -> String? {
        lock.withLock { tokens[server] }
    }

    public func save(server: String, token: String) throws {
        lock.withLock { tokens[server] = token }
    }

    public func delete(server: String) {
        _ = lock.withLock { tokens.removeValue(forKey: server) }
    }
}

/// Server and device details, kept in UserDefaults. The token is not here.
public struct StoredSettings: Codable, Equatable, Sendable {
    public var serverURL: String = ""
    public var deviceID: String = ""
    public var deviceName: String = ""

    static let key = "simple-editor.settings"

    static func load(from defaults: UserDefaults) -> StoredSettings {
        guard let data = defaults.data(forKey: key),
              let settings = try? JSONDecoder().decode(StoredSettings.self, from: data) else { return StoredSettings() }
        return settings
    }

    func save(to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: Self.key)
        }
    }
}

/// "https://" is assumed when no scheme is given; trailing slashes are dropped.
public func normalizeServerURL(_ raw: String) -> String {
    var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while url.hasSuffix("/") { url.removeLast() }
    if !url.isEmpty, !url.contains("://") { url = "https://" + url }
    return url
}
