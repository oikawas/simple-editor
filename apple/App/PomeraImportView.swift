#if os(iOS)
@preconcurrency import AVFoundation
import CoreImage
import SimpleEditorModel
import SwiftUI
import UIKit

/// Reads the QR codes a pomera shows for a text with the main (wide) camera,
/// then saves the text as a new note or adds it to the open one.
struct PomeraImportView: View {
    enum Target {
        case newNote
        case append(OpenNote)
    }

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let target: Target
    @State private var scan = PomeraScan()
    @State private var notice: String?
    @State private var cameraDenied = false

    var body: some View {
        NavigationStack {
            Group {
                if scan.isComplete {
                    result
                } else if cameraDenied {
                    ContentUnavailableView(
                        "カメラを使えません",
                        systemImage: "camera.fill",
                        description: Text("設定アプリ → Simple Editor → カメラ をオンにしてください。")
                    )
                } else {
                    scanner
                }
            }
            .navigationTitle("ポメラから取り込み")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { dismiss() }
                }
            }
        }
        .task { cameraDenied = !(await CameraAccess.request()) }
    }

    private var scanner: some View {
        VStack(spacing: 12) {
            QRCameraView { codewords, version, string in received(codewords, version, string) }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)
            VStack(spacing: 4) {
                Text(progress).font(.headline)
                Text(notice ?? "ポメラの画面の QR コードを枠いっぱいに映してください。複数あるときは順に映します（順番は問いません）。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal)
            .padding(.bottom)
        }
    }

    private var progress: String {
        guard let total = scan.total else { return "読み取り待ち" }
        let rest = scan.missing.map(String.init).joined(separator: "・")
        return "\(scan.count) / \(total) 枚を読み取りました（残り \(rest) 枚目）"
    }

    private var result: some View {
        VStack(spacing: 12) {
            ScrollView {
                Text(scan.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                    .padding()
            }
            .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal)
            Text("\(scan.text.count) 文字").font(.caption).foregroundStyle(.secondary)
            switch target {
            case .newNote:
                Button("新規メモとして保存") {
                    model.createNote(text: scan.text)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            case .append(let note):
                Button("このノートの末尾に追加") {
                    if model.current?.id == note.id { model.appendToCurrent(scan.text) } else { note.append(scan.text) }
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
            Button("読み直す") {
                scan = PomeraScan()
                notice = nil
            }
            .padding(.bottom)
        }
    }

    private func received(_ codewords: Data?, _ version: Int, _ string: String?) {
        guard !scan.isComplete else { return }
        // The codewords give the bytes as written; the system's string is a fallback.
        let payload = codewords.flatMap { QRPayload.text(codewords: $0, version: version) } ?? string
        guard let payload, let part = PomeraPart(payload) else { return }
        switch scan.add(part) {
        case .new:
            notice = nil
            if scan.isComplete {
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            } else {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            }
        case .again:
            if !scan.isComplete, let first = scan.missing.first { notice = "\(part.index) 枚目は読み取り済みです。次は \(first) 枚目を映してください。" }
        case .otherText:
            notice = "別の文章の QR コードです（\(part.total) 枚組）。最初から読み直すときは、キャンセルしてやり直してください。"
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        }
    }
}

enum CameraAccess {
    static func request() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }
}

/// Camera preview that reports the QR codes it sees: their data codewords
/// and version (when available) and the system's decoded string.
struct QRCameraView: UIViewControllerRepresentable {
    let onCode: (Data?, Int, String?) -> Void

    func makeUIViewController(context: Context) -> QRCameraController {
        let controller = QRCameraController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: QRCameraController, context: Context) {
        controller.onCode = onCode
    }
}

final class QRCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((Data?, Int, String?) -> Void)?
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "simple-editor.camera")
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        // The main (wide-angle) camera, not a virtual device that might switch
        // to another lens.
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else { return }
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        if session.canAddInput(input) { session.addInput(input) }
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
        }
        session.commitConfiguration()
        configure(device)

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)
        self.preview = preview
    }

    /// Continuous autofocus, and enough zoom that a code filling most of the
    /// frame is no closer than the lens can focus (as in Apple's AVCamBarcode).
    private func configure(_ device: AVCaptureDevice) {
        guard (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
        let codeSize: Float = 80 // mm, about the size of the code on a pomera's screen
        let fill: Float = 0.8
        let fieldOfView = device.activeFormat.videoFieldOfView * .pi / 180
        let subjectDistance = (codeSize / fill / 2) / tan(fieldOfView / 2)
        let minimumFocus = Float(device.minimumFocusDistance)
        if minimumFocus > 0, subjectDistance < minimumFocus {
            let zoom = CGFloat(minimumFocus / subjectDistance)
            device.videoZoomFactor = min(zoom, device.activeFormat.videoMaxZoomFactor)
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // Starting and stopping block, so they run off the main thread, as Apple advises.
        nonisolated(unsafe) let session = self.session
        sessionQueue.async { if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Starting and stopping block, so they run off the main thread, as Apple advises.
        nonisolated(unsafe) let session = self.session
        sessionQueue.async { if session.isRunning { session.stopRunning() } }
    }

    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        let codes = objects.compactMap { $0 as? AVMetadataMachineReadableCodeObject }.map { code in
            let descriptor = code.descriptor as? CIQRCodeDescriptor
            return (descriptor?.errorCorrectedPayload, descriptor?.symbolVersion ?? 0, code.stringValue)
        }
        MainActor.assumeIsolated {
            for (codewords, version, string) in codes { onCode?(codewords, version, string) }
        }
    }
}
#endif
