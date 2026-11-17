# Run elevated as tasktap after the clean snapshot.
$ErrorActionPreference = 'Stop'
$root = 'C:\tasktap'
New-Item -ItemType Directory "$root\target" -Force | Out-Null
[Environment]::SetEnvironmentVariable('CARGO_TARGET_DIR', "$root\target", 'User')
Start-Transcript "$root\provision.log" -Append

function Dword($Path, $Name, $Value) {
    if (-not (Test-Path $Path)) { New-Item $Path -Force | Out-Null }
    New-ItemProperty $Path $Name -Value $Value -PropertyType DWord -Force | Out-Null
}
function Install-PackageId([string] $Id, [string[]] $Extra = @()) {
    & $winget install --id $Id -e --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity @Extra
    # WinGet also reports "no applicable upgrade" for previously installed tools.
    if ($LASTEXITCODE -notin 0,3010,-1978335189) { throw "winget install $Id exited $LASTEXITCODE" }
}
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
}

Dword 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1
Dword 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' InactivityTimeoutSecs 0
Dword 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' DisableLockWorkstation 1
Set-ItemProperty 'HKCU:\Control Panel\Desktop' ScreenSaveActive '0'
Set-ItemProperty 'HKCU:\Control Panel\Desktop' ScreenSaverIsSecure '0'
foreach ($power in 'ac','dc') {
    powercfg /change "standby-timeout-$power" 0
    powercfg /change "monitor-timeout-$power" 0
    powercfg /change "hibernate-timeout-$power" 0
    powercfg "/set${power}valueindex" SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
}
powercfg /setactive SCHEME_CURRENT
$wu = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
Dword $wu SetComplianceDeadlineForQU 1
Dword $wu SetComplianceDeadlineForFU 1
foreach ($kind in 'Quality','Feature') {
    Dword $wu "ConfigureDeadlineFor${kind}Updates" 30
    Dword $wu "ConfigureDeadlineNoAutoRebootFor${kind}Updates" 1
}
Dword $wu ConfigureDeadlineGracePeriod 7
Dword $wu ConfigureDeadlineGracePeriodForFeatureUpdates 7
Add-MpPreference -ExclusionPath "$root\target"
if ("$root\target" -notin (Get-MpPreference).ExclusionPath) { throw 'Defender exclusion failed' }

$winget = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
if (-not $winget) {
    $app = Get-AppxPackage Microsoft.DesktopAppInstaller
    $winget = Join-Path $app.InstallLocation 'winget.exe'
}
Install-PackageId Microsoft.PowerShell
Install-PackageId Git.Git
Install-PackageId OpenJS.NodeJS.LTS
$vsOptions = '--wait --quiet --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Tools.ARM64 --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100'
Install-PackageId Microsoft.VisualStudio.2022.BuildTools @('--override',$vsOptions)
Install-PackageId Rustlang.Rustup
Refresh-Path
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
rustup set default-host aarch64-pc-windows-msvc
if ($LASTEXITCODE) { throw 'rustup host setup failed' }
rustup toolchain install stable --profile minimal --component rustfmt,clippy --target aarch64-pc-windows-msvc,x86_64-pc-windows-msvc
if ($LASTEXITCODE) { throw 'rustup toolchain install failed' }
rustup default stable
if ($LASTEXITCODE) { throw 'rustup default failed' }

$webview = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (-not (Test-Path $webview)) { Install-PackageId Microsoft.EdgeWebView2Runtime }
$version = Get-ItemPropertyValue $webview pv
if ([version]$version -le [version]'0.0.0.0') { throw 'WebView2 Runtime missing' }
Write-Host "WebView2 Runtime $version"

git config --global core.longpaths true
git config --global core.autocrlf false
if (-not (Test-Path "$root\repo.git\HEAD")) {
    git init --bare "$root\repo.git"
    if ($LASTEXITCODE) { throw 'Bare repository initialization failed' }
}
# Git for Windows installs the SSH transport programs in the same cmd directory as git.exe.
foreach ($command in 'git-receive-pack.exe','git-upload-pack.exe') {
    Get-Command $command -ErrorAction Stop | Out-Null
}
New-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' DefaultShell -Value (Get-Command pwsh.exe).Source -PropertyType String -Force | Out-Null
git --version
node --version
rustc -vV
cargo --version
rustup target list --installed
pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
Stop-Transcript
