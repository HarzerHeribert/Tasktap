# The host's build and checks; checkout.ps1 runs in front of this and leaves $Job, $checkout,
# $triple and $lock.
try {
    Write-Host "Building the host at $($Job.commit) for $triple"
    Set-Location host
    # The machine keeps one build folder for the core's checks; the host's is its own, in the checkout.
    $env:CARGO_TARGET_DIR = "$checkout\host\target"
    cargo fmt --check
    # The pages, the core and the release build; Clippy and the tests need the first two too.
    & "$checkout\host\scripts\build.ps1" -Target $Job.target -Fixtures
    # In the release profile, so that the dependencies are compiled once.
    cargo clippy --release --target $triple --all-targets -- -D warnings
    cargo test --release --target $triple
    $app = "$checkout\host\target\$triple\release\Tasktap Next"
    Get-ChildItem $app -Recurse -File | ForEach-Object { '{0,10}  {1}' -f $_.Length, $_.FullName.Substring($app.Length + 1) }
    $zip = "$checkout\host\target\$triple\release\Tasktap-Next-$($Job.target).zip"
    '{0}  {1}  {2} bytes' -f (Get-FileHash $zip -Algorithm SHA256).Hash, (Split-Path $zip -Leaf), (Get-Item $zip).Length
    if ($Job.run) {
        & "$checkout\host\scripts\smoke.ps1" -App $app -Core "$checkout\host\binaries\fixtures\tasktap.exe"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (git status --porcelain) { git status --short; throw 'The build changed files that are in git.' }
} finally {
    $lock.Dispose()
}
