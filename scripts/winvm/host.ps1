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
    $app = "$checkout\host\target\$triple\release\Tasktap"
    Get-ChildItem $app -Recurse -File | ForEach-Object { '{0,10}  {1}' -f $_.Length, $_.FullName.Substring($app.Length + 1) }
    $zip = "$checkout\host\target\$triple\release\Tasktap-$($Job.target).zip"
    '{0}  {1}  {2} bytes' -f (Get-FileHash $zip -Algorithm SHA256).Hash, (Split-Path $zip -Leaf), (Get-Item $zip).Length
    if ($Job.run) {
        & "$checkout\host\scripts\smoke.ps1" -App $app -Core "$checkout\host\binaries\fixtures\tasktap.exe"
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (git status --porcelain) { git status --short; throw 'The build changed files that are in git.' }
    if ($Job.desktop) {
        # The desktop round at this commit, in the signed-in desktop, while this job still holds the checkout.
        # The app built here, for the target built: on the ARM64 VM the x64 app runs emulated, and the rounds would
        # otherwise look for the processor's own.
        $round = "pwsh -NoProfile -File $checkout\scripts\winvm\desktop.ps1 -Target $($Job.target) -Out C:\tasktap\desktop-rounds\$($Job.desktop) -Locked"
        if ($Job.only) { $round += " -Only $($Job.only)" }
        & C:\tasktap\desk.ps1 -TimeoutSeconds 2400 -CommandLine $round
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if ($Job.gpu) {
        # The graphics processor's round at this commit (gpu.ps1), in the same way; its rehearsal runs here, in no desktop.
        $round = "pwsh -NoProfile -File $checkout\scripts\winvm\gpu.ps1 -Target $($Job.target) -Out C:\tasktap\gpu-rounds\$($Job.gpu) -Locked $($Job.gpuargs)"
        if ("$($Job.gpuargs)" -match '-Rehearse') { Invoke-Expression "& $round" } else { & C:\tasktap\desk.ps1 -TimeoutSeconds 1200 -CommandLine $round }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
} finally {
    $lock.Dispose()
}
