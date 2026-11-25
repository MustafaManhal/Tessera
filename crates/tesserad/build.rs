//! Embeds an Info.plist in the macOS binary. The session daemon runs every shell and agent, so when a program in a
//! terminal asks for the microphone, camera or a protected folder, macOS may ask on behalf of this program. A bare
//! command-line binary has nowhere to keep the permission text, and macOS then refuses without asking.
fn main() {
    println!("cargo:rerun-if-changed=Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let dir = std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir");
        println!("cargo:rustc-link-arg-bins=-Wl,-sectcreate,__TEXT,__info_plist,{dir}/Info.plist");
    }
}
