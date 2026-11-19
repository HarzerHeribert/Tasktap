# Builds the app for Windows, as build.sh does for the Mac: the pages, the core it bundles,
# and the host, into a folder that runs as it is, and the same folder zipped:
#   host\target\<target>-pc-windows-msvc\release\<product>\
# Needs Rust with the target installed, Visual Studio Build Tools, Node 22 or later and, to run
# the result, the WebView2 runtime (part of Windows 11). Nothing is signed.
#   pwsh host\scripts\build.ps1 [-Target x86_64|aarch64] [-Fixtures] [-Installer]
# -Fixtures also builds the core with its test fixtures (the fixture agent) for smoke.ps1.
# -Installer builds the host through Tauri, which also makes the installer from it (NSIS, for the
# person alone, no administrator needed) in host\target\<target>-pc-windows-msvc\release\bundle\nsis\;
# Tauri downloads NSIS the first time. TASKTAP_VERSION=2.0.1 builds that version (the release
# workflow takes it from the tag).
param(
    [ValidateSet('x86_64', 'aarch64')]
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [switch]$Fixtures,
    [switch]$Installer
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$hostDir = Split-Path $PSScriptRoot -Parent
$root = Split-Path $hostDir -Parent
$triple = "$Target-pc-windows-msvc"

Push-Location "$root\ui"
try {
    if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund }
    npm run --silent build
} finally { Pop-Location }

# The core, under its build name: the host copies it into <data>\bin\<build>\ and retires a
# running core of another build.
$build = "0.1.0+$(git -C $root rev-parse --short HEAD:core)"
New-Item -ItemType Directory -Force "$hostDir\binaries" | Out-Null
$env:TASKTAP_BUILD = $build
try {
    cargo build --release --quiet --manifest-path "$root\core\Cargo.toml" --target $triple --target-dir "$hostDir\target\core"
    if ($Fixtures) {
        $env:TASKTAP_BUILD = "$build.fixtures"
        cargo build --release --quiet --manifest-path "$root\core\Cargo.toml" --features fixtures --target $triple --target-dir "$hostDir\target\core-fixtures"
        New-Item -ItemType Directory -Force "$hostDir\binaries\fixtures" | Out-Null
        Copy-Item "$hostDir\target\core-fixtures\$triple\release\tasktap.exe" "$hostDir\binaries\fixtures\tasktap.exe" -Force
        Set-Content -Path "$hostDir\binaries\fixtures\build.txt" -Value "$build.fixtures" -NoNewline
    }
} finally { Remove-Item Env:TASKTAP_BUILD }
Copy-Item "$hostDir\target\core\$triple\release\tasktap.exe" "$hostDir\binaries\tasktap-$triple.exe" -Force
Set-Content -Path "$hostDir\binaries\build.txt" -Value $build -NoNewline
Write-Host "core $build"

# Microsoft's console beside the core (the core's terminals run in it, design §9) and the licences
# of what is not Tasktap's own, gathered once for the folder and the installer alike
# (tauri.windows.conf.json puts them into the installer).
$stage = "$hostDir\binaries\windows"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$stage\licenses" | Out-Null
& "$root\core\scripts\conpty.ps1" -Target $Target -Into $stage
Copy-Item "$root\core\scripts\conpty-LICENSE.txt" "$stage\licenses\Microsoft-Terminal-ConPTY-LICENSE.txt"
Copy-Item "$root\LICENSE" "$stage\licenses\Tasktap-LICENSE.txt"
Copy-Item "$root\ui\dist\licenses\*" "$stage\licenses\" -ErrorAction SilentlyContinue

# The host. Its pages are embedded (the `custom-protocol` feature is always on), so cargo alone
# builds what `tauri build` would, without an installer. The build folder is named, since a
# machine may keep one for everything (CARGO_TARGET_DIR).
$conf = Get-Content "$hostDir\tauri.conf.json" -Raw | ConvertFrom-Json
$product = $conf.productName
$bin = $conf.mainBinaryName
if ($Installer) {
    $extra = @()
    if ($env:TASKTAP_VERSION) {
        New-Item -ItemType Directory -Force "$hostDir\target" | Out-Null
        Set-Content -Path "$hostDir\target\version.conf.json" -Value "{`"version`":`"$env:TASKTAP_VERSION`"}" -NoNewline
        $extra = @('--config', "$hostDir\target\version.conf.json")
    }
    $env:CARGO_TARGET_DIR = "$hostDir\target"
    Push-Location $hostDir
    try {
        & "$root\ui\node_modules\.bin\tauri.cmd" build --bundles nsis --target $triple --no-sign @extra
    } finally {
        Pop-Location
        Remove-Item Env:CARGO_TARGET_DIR
    }
} else {
    cargo build --release --manifest-path "$hostDir\Cargo.toml" --target $triple --target-dir "$hostDir\target"
}

# The folder: the app, the core beside it, Microsoft's console beside the core, and the licences.
# The app's program is not named after the product alone: Windows does not tell "Tasktap.exe"
# from the core's "tasktap.exe".
$out = "$hostDir\target\$triple\release"
$app = "$out\$product"
Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item "$out\$bin.exe" "$app\$bin.exe"
Copy-Item "$hostDir\binaries\tasktap-$triple.exe" "$app\tasktap.exe"
Copy-Item "$stage\*" $app -Recurse
$zip = "$out\$($product -replace ' ', '-')-$Target.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path $app -DestinationPath $zip
Write-Host "Built $app"
Write-Host "Built $zip"
if ($Installer) { Get-ChildItem "$out\bundle\nsis\*-setup.exe" | ForEach-Object { Write-Host "Built $($_.FullName)" } }
