# What the Windows install line (site/install.ps1) does, tried with stand-ins as a person runs it (the script's text
# given to Invoke-Expression, under the Restricted execution policy, with no HOME), in Windows PowerShell 5.1 and, where
# it is installed, PowerShell 7. Refused, each for its own reason, with nothing installed and the temporary folder
# gone: an ARM64 and a 32-bit Windows (told to the script by PROCESSOR_ARCHITECTURE, as Windows tells it), a running
# Tasktap (a stand-in process named tasktap-app, started and stopped here), an address that is not https, and an
# installer whose SHA-256 is not the one SHA256SUMS lists. Accepted: a stand-in installer whose sum is right, which
# only writes a marker where /D= says and fails without /S, is run with Tauri's silent switches and the marker found.
# Everything stays in a temporary folder (LOCALAPPDATA, TMP and TEMP point into it for the script); nothing real is
# installed or started. Also: both scripts parse ([System.Management.Automation.Language.Parser]).
#   pwsh scripts/install-check.ps1   (or powershell -File; exit status 1 on a failure)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$subject = Join-Path $root 'site\install.ps1'
$failed = $false
function Pass($what) { Write-Host "PASS: $what" }
function Fail($what) { Write-Host "FAIL: $what"; $script:failed = $true }

foreach ($file in $subject, $PSCommandPath) {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$null, [ref]$errors) | Out-Null
  if ($errors) { Fail "$file does not parse: $($errors -join '; ')" } else { Pass "$(Split-Path -Leaf $file) parses" }
}
if (Get-Process -Name 'tasktap-app' -ErrorAction SilentlyContinue) {
  throw 'Quit Tasktap before this check: the script refuses to install while it runs, so every case would be refused for that.'
}

$work = Join-Path ([IO.Path]::GetTempPath()) ('tasktap-install-check-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$good = Join-Path $work 'good'; $wrong = Join-Path $work 'wrong'; $local = Join-Path $work 'local'; $tmp = Join-Path $work 'tmp'
$running = $null
try {
  New-Item -ItemType Directory -Path $good, $wrong, $local, $tmp | Out-Null
  # The stand-in: as the installer, it writes a marker named as the app where /D= says, and only when /S is given; as
  # the app (named tasktap-app.exe, started with "wait") it waits.
  Set-Content -LiteralPath (Join-Path $work 'standin.cs') -Value @'
using System; using System.IO; using System.Threading;
static class StandIn {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "wait") { Thread.Sleep(300000); return 0; }
    string line = Environment.CommandLine;
    int at = line.IndexOf(" /D=", StringComparison.Ordinal);
    if (at < 0 || line.IndexOf(" /S ", StringComparison.Ordinal) < 0) return 2;
    string dir = line.Substring(at + 4).Trim();
    Directory.CreateDirectory(dir);
    File.WriteAllText(Path.Combine(dir, "tasktap-app.exe"), "A stand-in, written by scripts/install-check.ps1.");
    File.WriteAllText(Path.Combine(dir, "installer-arguments.txt"), line);
    return 0;
  }
}
'@
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $setup = Join-Path $good 'Tasktap_x64-setup.exe'
  & $csc /nologo /target:exe "/out:$setup" (Join-Path $work 'standin.cs')
  if ($LASTEXITCODE -ne 0) { throw 'the stand-in could not be compiled' }
  $sum = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText((Join-Path $good 'SHA256SUMS'), "$sum  Tasktap_x64-setup.exe`n")
  Copy-Item -LiteralPath $setup -Destination $wrong
  [IO.File]::WriteAllText((Join-Path $wrong 'SHA256SUMS'), ('0' * 64) + "  Tasktap_x64-setup.exe`n")

  $shells = @((Get-Command powershell.exe).Source)
  if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { $shells += (Get-Command pwsh.exe).Source }
  $command = 'Get-Content -Raw -LiteralPath ''{0}'' | Invoke-Expression; exit $LASTEXITCODE' -f $subject

  # Runs the script in <shell> with these variables for it alone; returns its exit code and what it said.
  function Install($shell, $from, $arch) {
    # What the child writes to its error stream is read as text, not as an error of this check (Windows PowerShell 5.1).
    $ErrorActionPreference = 'Continue'
    $vars = @{ TASKTAP_INSTALL_FROM = $from; TASKTAP_INSTALL_NO_START = '1'; PROCESSOR_ARCHITECTURE = $arch; PROCESSOR_ARCHITEW6432 = $null
      LOCALAPPDATA = $local; TMP = $tmp; TEMP = $tmp; HOME = $null }
    $saved = @{}
    foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
    try {
      $out = (& $shell -NoProfile -NonInteractive -ExecutionPolicy Restricted -Command $command 2>&1 | Out-String).Trim()
      @{ Code = $LASTEXITCODE; Out = $out }
    } finally {
      foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
  }
  function Refused($shell, $what, $from, $arch, $reason) {
    $r = Install $shell $from $arch
    $left = @(Get-ChildItem -LiteralPath $tmp -Force) + @(Get-ChildItem -LiteralPath $local -Force)
    if ($r.Code -eq 0) { Fail "$what ($shell): not refused`n$($r.Out)" }
    elseif ($r.Out -notmatch "Tasktap was not installed: .*$([regex]::Escape($reason))") { Fail "$what ($shell): refused for another reason`n$($r.Out)" }
    elseif ($left) { Fail "$what ($shell): left behind: $($left.Name -join ', ')" }
    else { Pass "$what is refused in $(Split-Path -Leaf $shell), nothing installed, no temporary folder left: $(($r.Out -split "`n")[-1])" }
  }

  foreach ($shell in $shells) {
    Refused $shell 'an ARM64 Windows' $good 'ARM64' 'built for Windows on x64 only'
    Refused $shell 'a 32-bit Windows' $good 'x86' 'built for Windows on x64 only'
    Refused $shell 'an address that is not https' 'http://example.invalid/Tasktap' 'AMD64' 'must be an https:// address'
    Refused $shell 'an installer with the wrong SHA-256' $wrong 'AMD64' 'SHA-256 is not the one SHA256SUMS lists'
    $app = Join-Path $work 'tasktap-app.exe'
    Copy-Item -LiteralPath $setup -Destination $app -Force
    $running = Start-Process -FilePath $app -ArgumentList 'wait' -WindowStyle Hidden -PassThru
    try { Refused $shell 'a running Tasktap' $good 'AMD64' 'Tasktap is running' }
    finally { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue; $running.WaitForExit(); $running = $null }

    $r = Install $shell $good 'AMD64'
    $dir = Join-Path $local 'Tasktap'
    $marker = Join-Path $dir 'tasktap-app.exe'
    $said = Join-Path $dir 'installer-arguments.txt'
    if ($r.Code -ne 0) { Fail "the right installer ($shell): refused`n$($r.Out)" }
    elseif (-not (Test-Path -LiteralPath $marker)) { Fail "the right installer ($shell): no $marker" }
    elseif ((Get-Content -Raw -LiteralPath $said) -notmatch [regex]::Escape(" /S /D=$dir")) { Fail "the right installer ($shell): run with $(Get-Content -Raw -LiteralPath $said)" }
    elseif (@(Get-ChildItem -LiteralPath $tmp -Force)) { Fail "the right installer ($shell): its temporary folder is left" }
    elseif ($r.Out -notmatch 'not code-signed' -or $r.Out -notmatch 'Smart App Control') { Fail "the right installer ($shell): it does not say it is not code-signed`n$($r.Out)" }
    else { Pass "a stand-in installer with the right SHA-256 is run by $(Split-Path -Leaf $shell) with /S /D=<folder>, and found there" }
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
} finally {
  if ($running) { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Host 'install-check: FAILED'; exit 1 }
Write-Host 'install-check: every case holds.'
