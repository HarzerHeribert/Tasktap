# The core's checks; checkout.ps1 runs in front of this and leaves $Job, $root, $checkout,
# $triple and $lock.
try {
    Set-Location core
    $env:CARGO_TARGET_DIR = "$root\target"
    $env:CARGO_BUILD_TARGET = $triple
    Write-Host "Testing $($Job.commit) on $triple"
    cargo fmt --check
    cargo clippy --all-targets -- -D warnings
    # The core's terminals run in Microsoft's console when it lies beside the core (design §9).
    # The build folder is shared with the runs of other commits, so it is taken away again below.
    $beside = "$env:CARGO_TARGET_DIR\$triple\debug"
    $console = "$beside\conpty.dll", "$beside\OpenConsole.exe"
    Remove-Item $console -ErrorAction SilentlyContinue
    if ($Job.console -and (Test-Path scripts\conpty.ps1)) {
        cargo build --quiet
        & .\scripts\conpty.ps1 -Target $Job.target -Into $beside -Cache "$checkout\core\target\conpty"
    }
    if ($Job.batch) { $env:TASKTAP_TEST_BATCH_AGENTS = '1' }
    # One failing suite must not keep the ones after it from running.
    $cargoArgs = @('test', '--workspace', '--no-fail-fast') + @($Job.args)
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
    if ($console) { Remove-Item $console -ErrorAction SilentlyContinue }
    $lock.Dispose()
}
