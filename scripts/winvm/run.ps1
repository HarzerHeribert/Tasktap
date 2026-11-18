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
    Set-Location core
    $env:CARGO_TARGET_DIR = "$root\target"
    $env:CARGO_BUILD_TARGET = "$($Job.target)-pc-windows-msvc"
    $arch = if ($Job.target -eq 'aarch64') { 'arm64' } else { 'amd64' }
    $finder = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vs = & $finder -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.ARM64 -property installationPath
    if (-not $vs) { throw 'C++ Build Tools missing' }
    Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
    Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=$arch -host_arch=arm64"
    Write-Host "Testing $($Job.commit) on $env:CARGO_BUILD_TARGET"
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    # The core's terminals run in Microsoft's console when it lies beside the core (design §9).
    # The build folder is shared with the runs of other commits, so it is taken away again below.
    $beside = "$env:CARGO_TARGET_DIR\$env:CARGO_BUILD_TARGET\debug"
    if (Test-Path scripts\conpty.ps1) {
        cargo build --quiet
        & .\scripts\conpty.ps1 -Target $Job.target -Into $beside -Cache "$checkout\core\target\conpty"
    }
    $cargoArgs = @('test', '--workspace') + @($Job.args)
    if (-not $Job.repeat) {
        $PSNativeCommandUseErrorActionPreference = $false
        cargo @cargoArgs
        exit $LASTEXITCODE
    }
    if ($cargoArgs -contains '--') { throw 'In repeat mode, pass only Cargo options after the script separator.' }
    $cargoArgs += @($Job.name, '--', '--exact')
    $matchesFound = @(cargo @cargoArgs --list | Where-Object { $_ -ceq "$($Job.name): test" })
    if ($matchesFound.Count -ne 1) { throw "Expected one exact test, found $($matchesFound.Count)" }
    $PSNativeCommandUseErrorActionPreference = $false
    $failures = 0
    for ($i = 1; $i -le $Job.repeat; $i++) {
        $output = @(cargo @cargoArgs 2>&1)
        $rc = $LASTEXITCODE
        if ($rc -ne 0) {
            if ($failures -eq 0) { $output | Out-Host }
            $failures++
        } elseif (-not ($output -cmatch ('^test ' + [regex]::Escape($Job.name) + ' \.\.\. ok$'))) {
            throw 'Cargo succeeded without running the requested test'
        }
        Write-Host "Run $i of $($Job.repeat), exit $rc"
    }
    Write-Host "$failures of $($Job.repeat) failed"
    exit [int]($failures -gt 0)
} finally {
    if ($beside) { Remove-Item "$beside\conpty.dll", "$beside\OpenConsole.exe" -ErrorAction SilentlyContinue }
    $lock.Dispose()
}
