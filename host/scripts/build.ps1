# Builds Tasktap Next for Windows, as build.sh does for the Mac: the pages, the core it bundles,
# and the host, into a folder that runs as it is, and the same folder zipped:
#   host\target\<target>-pc-windows-msvc\release\Tasktap Next\
# Needs Rust with the target installed, Visual Studio Build Tools, Node 22 or later and, to run
# the result, the WebView2 runtime (part of Windows 11). Nothing is signed.
#   pwsh host\scripts\build.ps1 [-Target x86_64|aarch64] [-Fixtures]
# -Fixtures also builds the core with its test fixtures (the fixture agent) for smoke.ps1.
param(
    [ValidateSet('x86_64', 'aarch64')]
    [string]$Target = $(if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }),
    [switch]$Fixtures
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
        Set-Content -NoNewline "$hostDir\binaries\fixtures\build.txt" "$build.fixtures"
    }
} finally { Remove-Item Env:TASKTAP_BUILD }
Copy-Item "$hostDir\target\core\$triple\release\tasktap.exe" "$hostDir\binaries\tasktap-$triple.exe" -Force
Set-Content -NoNewline "$hostDir\binaries\build.txt" $build
Write-Host "core $build"

# The host. Its pages are embedded (the `custom-protocol` feature is always on), so cargo alone
# builds what `tauri build` would, without an installer.
cargo build --release --manifest-path "$hostDir\Cargo.toml" --target $triple

# The folder: the app, the core beside it, Microsoft's console beside the core (the core's
# terminals run in it, design §9), and the licences of what is not Tasktap's own.
$out = "$hostDir\target\$triple\release"
$app = "$out\Tasktap Next"
Remove-Item $app -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$app\licenses" | Out-Null
Copy-Item "$out\tasktap-next.exe" "$app\Tasktap Next.exe"
Copy-Item "$hostDir\binaries\tasktap-$triple.exe" "$app\tasktap.exe"
& "$root\core\scripts\conpty.ps1" -Target $Target -Into $app
Copy-Item "$root\core\scripts\conpty-LICENSE.txt" "$app\licenses\Microsoft-Terminal-ConPTY-LICENSE.txt"
Copy-Item "$root\LICENSE" "$app\licenses\Tasktap-LICENSE.txt"
Copy-Item "$root\ui\dist\licenses\*" "$app\licenses\" -Recurse -ErrorAction SilentlyContinue
$zip = "$out\Tasktap-Next-$Target.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path $app -DestinationPath $zip
Write-Host "Built $app"
Write-Host "Built $zip"
