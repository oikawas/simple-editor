import SimpleEditorModel
import SwiftUI

/// Registers this device with the server's registration token.
struct RegistrationView: View {
    @Environment(AppModel.self) private var model
    @State private var serverURL = ""
    @State private var deviceName = ""
    @State private var registrationToken = ""
    @State private var error: String?
    @State private var working = false

    var body: some View {
        NavigationStack {
            Form {
                if case .needsRegistration(let reason?) = model.phase {
                    Section { Text(reason) }
                }
                Section {
                    TextField("サーバー URL", text: $serverURL, prompt: Text("https://192.168.1.10"))
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        #endif
                    TextField("この端末の名前", text: $deviceName)
                    SecureField("登録用トークン", text: $registrationToken)
                } footer: {
                    Text("登録用トークンはサーバーの AUTH_TOKEN の値です。この端末を登録するために一度だけ使い、端末には保存しません。")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("この端末を登録")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if working {
                        ProgressView()
                    } else {
                        Button("登録") { register() }
                            .disabled(serverURL.isEmpty || registrationToken.isEmpty)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 360)
        #endif
        .onAppear {
            serverURL = model.settings.serverURL
            deviceName = model.settings.deviceName
        }
    }

    private func register() {
        working = true
        error = nil
        Task {
            do {
                try await model.register(serverURL: serverURL, deviceName: deviceName, registrationToken: registrationToken)
                registrationToken = ""
            } catch {
                self.error = AppModel.describe(error, registering: true)
            }
            working = false
        }
    }
}
