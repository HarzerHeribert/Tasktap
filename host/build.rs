fn main() {
    // The build name of the bundled core, written by scripts/build-core.sh: the host copies the
    // core into <data>/bin/<build>/ and retires a running core of another build.
    println!("cargo:rerun-if-changed=binaries/build.txt");
    let build = std::fs::read_to_string("binaries/build.txt").unwrap_or_else(|_| "unbuilt".into());
    println!("cargo:rustc-env=TASKTAP_CORE_BUILD={}", build.trim());
    tauri_build::build()
}
