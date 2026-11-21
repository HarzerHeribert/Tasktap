// A core slow to start, for host\scripts\smoke.ps1 (smoke.sh has its own, in Perl): waits SMOKE_CORE_DELAY seconds,
// then runs the core SMOKE_CORE names with what it was given, for as long as that runs (Windows has no exec), and ends
// with its code. Built with the fixtures (host\scripts\build.ps1 -Fixtures), where rustc is: the account a desktop round
// runs the smoke script in may have none.
fn main() {
    let wait = std::env::var("SMOKE_CORE_DELAY").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    std::thread::sleep(std::time::Duration::from_secs(wait));
    let Some(core) = std::env::var_os("SMOKE_CORE") else {
        eprintln!("slow-core: SMOKE_CORE names no core");
        std::process::exit(2);
    };
    let ran = std::process::Command::new(core).args(std::env::args_os().skip(1)).status();
    std::process::exit(ran.ok().and_then(|s| s.code()).unwrap_or(1));
}
