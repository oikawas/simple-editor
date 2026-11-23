//! Takes the next build number (scripts/next-build-number.sh) for the app to
//! show. The counter changes on every build, which makes Cargo run this
//! again on the next build too.

use std::path::Path;
use std::process::Command;

fn main() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let number = Command::new("sh")
        .arg(root.join("scripts/next-build-number.sh"))
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|| "?".into());
    println!("cargo:rustc-env=SIMPLE_EDITOR_BUILD_NUMBER={number}");
    println!("cargo:rerun-if-changed={}", root.join(".build-number").display());
}
