#!/usr/bin/env bash
# Builds the Rust core for this machine and generates its Swift bindings into
# the SimpleEditorCore package. Usage: generate-bindings.sh [debug|release]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-debug}"
cd "$ROOT"

FLAGS=()
[[ "$PROFILE" == release ]] && FLAGS=(--release)
cargo build "${FLAGS[@]}" -p simple-editor-core

LIB="target/$PROFILE/libsimple_editor_core.so"
[[ -f "target/$PROFILE/libsimple_editor_core.dylib" ]] && LIB="target/$PROFILE/libsimple_editor_core.dylib"

OUT="target/bindings/swift"
rm -rf "$OUT"
cargo run "${FLAGS[@]}" -q -p simple-editor-core --features bindgen --bin uniffi-bindgen -- \
  generate --library "$LIB" --language swift --out-dir "$OUT"

PKG="apple/SimpleEditorCore"
cp "$OUT/simple_editor_core.swift" "$PKG/Sources/SimpleEditorCore/SimpleEditorCore.swift"
cp "$OUT/simple_editor_coreFFI.h" "$PKG/Sources/simple_editor_coreFFI/simple_editor_coreFFI.h"
echo "Swift bindings written to $PKG"
