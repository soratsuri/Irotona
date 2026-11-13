fn main() {
    // Tauri embeds this ICO in the Windows executable. Rebuild the resource
    // when it changes, even if Cargo can reuse the rest of the build.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
