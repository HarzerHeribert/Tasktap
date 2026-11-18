param($Job)
# The start of every job: job.sh sends this in front of run.ps1 or host.ps1. It takes the
# checkout's lock, puts the job's commit there and enters the compiler's environment.
$ErrorActionPreference = 'Stop'
$root = 'C:\tasktap'
$gitDir = "$root\repo.git"
$checkout = "$root\checkout"
if ($Job.polite) {
    # A person may be using the machine: every process started from here inherits a priority
    # below their programs', and Cargo and the tests read these for half the cores.
    (Get-Process -Id $PID).PriorityClass = 'BelowNormal'
    $env:CARGO_BUILD_JOBS = $env:RUST_TEST_THREADS = [Math]::Max(1, [Math]::Floor([Environment]::ProcessorCount / 2))
}
# Windows releases this handle if the SSH session or build terminates.
$lock = [IO.File]::Open("$root\checkout.lock", 'OpenOrCreate', 'ReadWrite', 'None')
$PSNativeCommandUseErrorActionPreference = $true
if (-not (Test-Path "$checkout\.git")) {
    git "--git-dir=$gitDir" worktree add --detach $checkout $Job.commit
}
Set-Location $checkout
if (git status --porcelain) { throw 'Checkout contains local edits. Save them in shell.sh first.' }
# A checkout that is a clone of the repository, not a worktree of it, has to be given the commit.
if (Test-Path "$checkout\.git" -PathType Container) { git fetch --quiet $gitDir "refs/tasktap/tests/$($Job.commit)" }
git switch --detach $Job.commit
$triple = "$($Job.target)-pc-windows-msvc"
$onArm = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64'
$arch = if ($Job.target -eq 'aarch64') { 'arm64' } else { 'amd64' }
$tools = if ($onArm -or $Job.target -eq 'aarch64') { 'ARM64' } else { 'x86.x64' }
$finder = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $finder -latest -products '*' -requires "Microsoft.VisualStudio.Component.VC.Tools.$tools" -property installationPath
if (-not $vs) { throw "C++ Build Tools ($tools) missing" }
Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=$arch -host_arch=$(if ($onArm) { 'arm64' } else { 'amd64' })"
