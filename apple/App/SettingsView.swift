import SimpleEditorCore
import SimpleEditorModel
import SwiftUI

/// Renaming this device and managing registered devices.
struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var deviceName = ""
    @State private var devices: [DeviceInfo] = []
    @State private var message: String?
    @State private var revoking: DeviceInfo?

    var body: some View {
        NavigationStack {
            Form {
                Section("サーバー") {
                    LabeledContent("URL", value: model.settings.serverURL)
                    HStack {
                        TextField("この端末の名前", text: $deviceName)
                        Button("変更") { rename() }
                            .disabled(deviceName.trimmingCharacters(in: .whitespaces).isEmpty
                                      || deviceName == model.settings.deviceName)
                    }
                }
                Section("登録済みの端末") {
                    ForEach(devices, id: \.id) { device in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(device.current ? "\(device.name)（この端末）" : device.name)
                                Text("最終接続 \(date(device.lastSeenAt)) · 登録 \(date(device.createdAt))")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("登録解除", role: .destructive) { revoking = device }
                        }
                    }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.secondary) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("設定と端末")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
            .confirmationDialog("登録解除", isPresented: revokeShown, presenting: revoking) { device in
                Button("登録解除", role: .destructive) { revoke(device) }
            } message: { device in
                Text(device.current
                     ? "この端末の登録を解除しますか？ もう一度使うには登録用トークンが必要です。"
                     : "「\(device.name)」の登録を解除しますか？ その端末はすぐに同期できなくなります。")
            }
        }
        #if os(macOS)
        .frame(minWidth: 520, minHeight: 440)
        #endif
        .task {
            deviceName = model.settings.deviceName
            await load()
        }
    }

    private var revokeShown: Binding<Bool> {
        Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })
    }

    private func date(_ ms: Int64) -> String {
        Date(timeIntervalSince1970: Double(ms) / 1000).formatted(date: .numeric, time: .shortened)
    }

    private func load() async {
        do {
            devices = try await model.devices()
        } catch {
            message = AppModel.describe(error)
        }
    }

    private func rename() {
        Task {
            do {
                try await model.renameDevice(deviceName)
                message = "名前を変更しました"
                await load()
            } catch {
                message = AppModel.describe(error)
            }
        }
    }

    private func revoke(_ device: DeviceInfo) {
        Task {
            do {
                try await model.revoke(device)
                if device.current { dismiss() } else { await load() }
            } catch {
                message = AppModel.describe(error)
            }
        }
    }
}
