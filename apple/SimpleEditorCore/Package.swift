// swift-tools-version:6.0
// The Rust core's Swift bindings (SimpleEditorCore) and the app's
// platform-independent model (SimpleEditorModel).
//
// On Apple platforms the core comes from simple_editor_coreFFI.xcframework
// (../build-xcframework.sh). On Linux it links the library built by
// ../generate-bindings.sh, so the model and its tests also run there.
import PackageDescription

#if os(Linux)
let rustLibDir = Context.packageDirectory + "/../../target/debug"
let ffi: Target = .systemLibrary(name: "simple_editor_coreFFI", path: "Sources/simple_editor_coreFFI")
let coreLinker: [LinkerSetting] = [
    .unsafeFlags(["-L\(rustLibDir)", "-Xlinker", "-rpath", "-Xlinker", rustLibDir]),
]
#else
let ffi: Target = .binaryTarget(name: "simple_editor_coreFFI", path: "simple_editor_coreFFI.xcframework")
let coreLinker: [LinkerSetting] = [
    .linkedFramework("Security"),
    .linkedFramework("SystemConfiguration"),
]
#endif

let package = Package(
    name: "SimpleEditorCore",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "SimpleEditorCore", targets: ["SimpleEditorCore"]),
        .library(name: "SimpleEditorModel", targets: ["SimpleEditorModel"]),
    ],
    targets: [
        ffi,
        .target(
            name: "SimpleEditorCore",
            dependencies: ["simple_editor_coreFFI"],
            path: "Sources/SimpleEditorCore",
            linkerSettings: coreLinker
        ),
        .target(name: "SimpleEditorModel", dependencies: ["SimpleEditorCore"]),
        .testTarget(name: "SimpleEditorModelTests", dependencies: ["SimpleEditorModel"]),
    ]
)
