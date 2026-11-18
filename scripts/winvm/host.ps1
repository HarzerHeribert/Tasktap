param($Job)
$ErrorActionPreference = 'Stop'
$root = 'C:\tasktap'
$gitDir = "$root\repo.git"
$checkout = "$root\checkout"
# Windows releases this handle if the SSH session or build terminates.
$lock = [IO.File]::Open("$root\checkout.lock", 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $PSNativeCommandUseErrorActionPreference = $true
    if (-not (Test-Path "$checkout\.git")) {
        git "--git-dir=$gitDir" worktree add --detach $checkout $Job.commit
    }
    Set-Location $checkout
    if (git status --porcelain) { throw 'Checkout contains local edits. Save them in shell.sh first.' }
    git switch --detach $Job.commit
    $triple = "$($Job.target)-pc-windows-msvc"
    $arch = if ($Job.target -eq 'aarch64') { 'arm64' } else { 'amd64' }
    $finder = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vs = & $finder -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath
    if (-not $vs) { throw 'C++ Build Tools missing' }
    Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=$arch -host_arch=arm64"
    Write-Host "Building the host at $($Job.commit) for $triple"
    Set-Location host
    # The VM keeps one build folder for the core's checks; the host's is its own, in the checkout.
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
        & "$checkout\host\scripts\smoke.ps1" -App $app -Core "$checkout\host\binaries\fixtures\tasktap.exe" -Seconds 30
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (git status --porcelain) { git status --short; throw 'The build changed files that are in git.' }
} finally {
    $lock.Dispose()
}
