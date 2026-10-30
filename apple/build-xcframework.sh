#!/usr/bin/env bash
# Builds the Rust core for macOS (Apple silicon and Intel), iOS, and the iOS
# simulator, and packs it as SimpleEditorCore/simple_editor_coreFFI.xcframework.
# Run on a Mac with Xcode and rustup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGETS=(aarch64-apple-darwin x86_64-apple-darwin aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios)
rustup target add "${TARGETS[@]}"

export MACOSX_DEPLOYMENT_TARGET=14.0
export IPHONEOS_DEPLOYMENT_TARGET=17.0
for target in "${TARGETS[@]}"; do
  cargo build --release -p simple-editor-core --lib --target "$target"
done

# Bindings come from a build for this Mac.
"$ROOT/apple/generate-bindings.sh" release

WORK="target/xcframework"
rm -rf "$WORK"
mkdir -p "$WORK/headers" "$WORK/macos" "$WORK/ios-sim"
cp target/bindings/swift/simple_editor_coreFFI.h "$WORK/headers/"
cat > "$WORK/headers/module.modulemap" <<'MAP'
module simple_editor_coreFFI {
    header "simple_editor_coreFFI.h"
    export *
}
MAP

lib() { echo "target/$1/release/libsimple_editor_core.a"; }
lipo -create "$(lib aarch64-apple-darwin)" "$(lib x86_64-apple-darwin)" -output "$WORK/macos/libsimple_editor_core.a"
lipo -create "$(lib aarch64-apple-ios-sim)" "$(lib x86_64-apple-ios)" -output "$WORK/ios-sim/libsimple_editor_core.a"

OUTPUT="apple/SimpleEditorCore/simple_editor_coreFFI.xcframework"
rm -rf "$OUTPUT"
xcodebuild -create-xcframework \
  -library "$WORK/macos/libsimple_editor_core.a" -headers "$WORK/headers" \
  -library "$(lib aarch64-apple-ios)" -headers "$WORK/headers" \
  -library "$WORK/ios-sim/libsimple_editor_core.a" -headers "$WORK/headers" \
  -output "$OUTPUT"
echo "Built $OUTPUT"
