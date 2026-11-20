# What the Windows install line (site/install.ps1) does, tried with stand-ins as a person runs it: its text given to
# Invoke-Expression in a PowerShell of its own, under the Restricted execution policy, with no HOME, in Windows
# PowerShell 5.1 and, where it is installed, PowerShell 7. Nothing real is installed or started, and nothing is written
# to the registry. The script has no switch that turns a check off. What describes the computer it asks of .NET and of
# cmdlets named with their module, which nothing in a session can stand in for; so the stand-ins reach a copy of the
# script in which exactly those three texts are replaced (the elevation test, CimCmdlets\Get-CimInstance and
# Microsoft.PowerShell.Management\Get-ItemProperty), and the check proves the copy differs in nothing else. A running
# Tasktap is a stand-in process.
# Refused, each for its own reason, with nothing installed, no temporary folder left and the PowerShell it ran in as it
# was: an elevated PowerShell (stood in; and the shipped script as this PowerShell is: refused exactly when it is
# elevated), an ARM64 and a 32-bit processor, a running Tasktap, an address that is not https, a file the release does
# not have, an installer whose SHA-256 is not the one SHA256SUMS lists (not run), an installer that stops with a code
# other than 0, and one that records a place with no program in it. Accepted: a stand-in installer with the right sum,
# run with /S alone, which writes a stand-in program and records its place as Tauri's installer does (here in a file
# the stand-in for Get-ItemProperty reads, in place of HKCU\...\Uninstall\Tasktap); the program is found there. The same
# again in a session whose profile has functions and aliases named as the commands the script uses, a default for
# Start-Process that would break it, and Set-StrictMode -Version Latest: it behaves exactly as without them.
# Also: both scripts parse ([System.Management.Automation.Language.Parser]).
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
$session = (Get-Process -Id $PID).SessionId
if (Get-Process -Name 'tasktap-app' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }) {
  throw 'Quit Tasktap before this check: the script refuses to install while it runs, so every case would be refused for that.'
}
$elevated = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$work = Join-Path ([IO.Path]::GetTempPath()) ('tasktap-install-check-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
$good = Join-Path $work 'good'; $wrong = Join-Path $work 'wrong'; $half = Join-Path $work 'half'
$local = Join-Path $work 'local'; $tmp = Join-Path $work 'tmp'; $registry = Join-Path $work 'registry.txt'
$copy = Join-Path $work 'install-stood-in.ps1'
$running = $null
try {
  New-Item -ItemType Directory -Path $good, $wrong, $half, $local, $tmp | Out-Null
  # The test copy: exactly these texts replaced by the stand-ins defined below, and nothing else.
  $source = [IO.File]::ReadAllText($subject)
  $replaced = [ordered]@{
    '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)' = '(StandIn-Elevated)'
    'CimCmdlets\Get-CimInstance' = 'StandIn-CimInstance'
    'Microsoft.PowerShell.Management\Get-ItemProperty' = 'StandIn-ItemProperty'
  }
  $text = $source
  foreach ($k in $replaced.Keys) { $text = $text.Replace($k, $replaced[$k]) }
  $back = $text
  foreach ($k in $replaced.Keys) { $back = $back.Replace($replaced[$k], $k) }
  $once = @($replaced.Keys | Where-Object { ($source.Length - $source.Replace($_, '').Length) / $_.Length -ne 1 })
  if ($back -ceq $source -and -not $once -and -not ($source -match 'StandIn-')) {
    Pass 'the test copy differs from the script only in the elevation test, Get-CimInstance and Get-ItemProperty, each named once'
  } else { Fail "the test copy: these are not in the script exactly once: $($once -join ', ')" }
  [IO.File]::WriteAllText($copy, $text)

  # The stand-in: as the installer, it notes its arguments, stops with 1 or records a place with no program when told
  # to, needs /S alone, and otherwise writes a program into %LOCALAPPDATA%\Tasktap and records that place, quoted, as
  # Tauri's installer records InstallLocation. As the app (named tasktap-app.exe, started with "wait") it waits.
  Set-Content -LiteralPath (Join-Path $work 'standin.cs') -Value @'
using System; using System.IO; using System.Threading;
static class StandIn {
  static int Main(string[] args) {
    if (args.Length == 1 && args[0] == "wait") { Thread.Sleep(300000); return 0; }
    string registry = Environment.GetEnvironmentVariable("INSTALL_CHECK_REGISTRY");
    string mode = Environment.GetEnvironmentVariable("INSTALL_CHECK_STANDIN") ?? "";
    File.WriteAllText(registry + ".arguments", string.Join(" ", args));
    if (mode == "fail") return 1;
    if (args.Length != 1 || args[0] != "/S") return 2;
    string dir = Path.Combine(Environment.GetEnvironmentVariable("LOCALAPPDATA"), "Tasktap");
    Directory.CreateDirectory(dir);
    if (mode != "no-program") File.WriteAllText(Path.Combine(dir, "tasktap-app.exe"), "A stand-in, written by scripts/install-check.ps1.");
    File.WriteAllText(registry, "\"" + dir + "\"");
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
  Copy-Item -LiteralPath (Join-Path $good 'SHA256SUMS') -Destination $half

  $shells = @((Get-Command powershell.exe).Source)
  if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { $shells += (Get-Command pwsh.exe).Source }
  # What the line runs in: a profile, the stand-ins, then a picture of the session before and after the line.
  $template = @'
PROFILE
function StandIn-Elevated { ELEVATED }
function StandIn-CimInstance { param($ClassName) [pscustomobject]@{ Architecture = ARCH } }
function StandIn-ItemProperty { [CmdletBinding()] param([string]$LiteralPath)
  if (Test-Path -LiteralPath 'REGISTRY') { [pscustomobject]@{ InstallLocation = (Get-Content -Raw -LiteralPath 'REGISTRY') } } }
function Snapshot {
  $skip = 'LASTEXITCODE', 'Error', 'StackTrace', '?', '^', '$', '_', 'PSItem', 'args', 'input', 'MyInvocation', 'PSBoundParameters',
    'PSCmdlet', 'foreach', 'this', 'Matches', 'before', 'after', 'code'
  $names = (Get-Variable -Scope Global | Where-Object { $skip -notcontains $_.Name } | ForEach-Object { $_.Name } | Sort-Object) -join ','
  "$names|$((Get-Location).Path)|$ErrorActionPreference|$ProgressPreference|$([Net.ServicePointManager]::SecurityProtocol)|$($PSDefaultParameterValues.Count)"
}
$before = Snapshot
Get-Content -Raw -LiteralPath 'SUBJECT' | Invoke-Expression
$code = if (Test-Path -LiteralPath variable:global:LASTEXITCODE) { $global:LASTEXITCODE } else { 0 }
$after = Snapshot
if ($after -ne $before) { Write-Host "SESSION CHANGED: before $before"; Write-Host "SESSION CHANGED: after  $after" }
exit $code
'@
  # A profile that would change the line if the line let it: everything it names stands in for a command the script uses.
  $hostile = @'
function Shadowed { Write-Host "SHADOWED $($MyInvocation.InvocationName)"; throw 'shadowed' }
function whoami { Shadowed }
function Get-ItemProperty { Shadowed }
function Get-CimInstance { Shadowed }
function Invoke-WebRequest { Shadowed }
Set-Alias -Name Get-Process -Value Shadowed
Set-Alias -Name Start-Process -Value Shadowed
$PSDefaultParameterValues['Start-Process:WorkingDirectory'] = 'Z:\no-such-folder'
Set-StrictMode -Version Latest
'@

  # Runs the line in <shell> with <case>'s stand-ins and these variables for it alone; returns its exit code and words.
  function Install($shell, $case) {
    # What the child writes to its error stream is read as text, not as an error of this check (Windows PowerShell 5.1).
    $ErrorActionPreference = 'Continue'
    $arch = if ($null -ne $case.Arch) { $case.Arch } else { 9 }
    $target = if ($case.Real) { $subject } else { $copy }
    $profileText = if ($case.Profile) { $hostile } else { '' }
    $answer = if ($case.Elevated) { '$true' } else { '$false' }
    $text = $template.Replace('PROFILE', $profileText).Replace('ELEVATED', $answer).Replace('ARCH', "$arch").Replace('REGISTRY', $registry).Replace('SUBJECT', $target)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($text))
    $vars = @{ TASKTAP_INSTALL_FROM = $case.From; TASKTAP_INSTALL_NO_START = '1'; LOCALAPPDATA = $local; TMP = $tmp; TEMP = $tmp; HOME = $null
      INSTALL_CHECK_REGISTRY = $registry; INSTALL_CHECK_STANDIN = $case.Mode }
    $saved = @{}
    foreach ($k in $vars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $vars[$k]) }
    try {
      $out = (& $shell -NoProfile -NonInteractive -ExecutionPolicy Restricted -EncodedCommand $encoded 2>&1 | Out-String).Trim()
      @{ Code = $LASTEXITCODE; Out = $out }
    } finally {
      foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    }
  }
  # Runs <case> and holds it to what it must do: refused for its Reason with nothing installed, or, without one,
  # installed by the stand-in run with /S alone; never a temporary folder left, the session changed or a shadow used.
  function Check($shell, $what, $case) {
    $r = Install $shell $case
    $program = Join-Path $local 'Tasktap\tasktap-app.exe'
    $problems = @()
    if ($r.Out -match 'SESSION CHANGED') { $problems += 'it changed the PowerShell it ran in' }
    if ($r.Out -match 'SHADOWED') { $problems += 'it called a command the profile had shadowed' }
    if (@(Get-ChildItem -LiteralPath $tmp -Force).Count) { $problems += 'its temporary folder is left' }
    if ($case.Reason) {
      if ($r.Code -eq 0) { $problems += 'it was not refused' }
      elseif ($r.Out -notmatch ('Tasktap was not installed: .*' + [regex]::Escape($case.Reason))) { $problems += 'it was refused for another reason' }
      if ($case.Mode -ne 'no-program' -and (Test-Path -LiteralPath $program)) { $problems += 'something was installed' }
      if ($case.NotRun -and (Test-Path -LiteralPath "$registry.arguments")) { $problems += 'the installer was run' }
    } else {
      if ($r.Code -ne 0) { $problems += 'it was refused' }
      if (-not (Test-Path -LiteralPath $program)) { $problems += 'the program is not there' }
      elseif ((Get-Content -Raw -LiteralPath "$registry.arguments") -ne '/S') { $problems += "the installer was run with: $(Get-Content -Raw -LiteralPath "$registry.arguments")" }
      foreach ($said in 'not code-signed', 'Smart App Control', 'desktop', 'Installed: ') {
        if ($r.Out -notmatch [regex]::Escape($said)) { $problems += "it does not say '$said'" }
      }
    }
    $leaf = Split-Path -Leaf $shell
    if ($problems) { Fail "$what ($leaf): $($problems -join '; ')`n$($r.Out)" }
    elseif ($case.Reason) { Pass "$what is refused in $leaf, nothing installed or left, the session as it was: $(@($r.Out -split "`n" | Where-Object { $_ -match 'not installed' })[0])" }
    else { Pass "$what (in $leaf): the stand-in installer is run with /S alone and its program found where it recorded it" }
    Remove-Item -LiteralPath (Join-Path $local 'Tasktap'), $registry, "$registry.arguments" -Recurse -Force -ErrorAction SilentlyContinue
  }

  foreach ($shell in $shells) {
    Check $shell 'an elevated PowerShell' @{ From = $good; Elevated = $true; Reason = 'runs as administrator; paste the line into an ordinary PowerShell window, so that Tasktap is installed for you alone, or, where every PowerShell runs so, download the installer from https://harzerheribert.github.io/Tasktap/'; NotRun = $true }
    $mine = if ($elevated) { 'runs as administrator' } else { 'SHA-256 is not the one SHA256SUMS lists' }
    Check $shell "the shipped script in this PowerShell, which is $(if ($elevated) { '' } else { 'not ' })elevated," @{ From = $wrong; Real = $true; Reason = $mine; NotRun = $true }
    Check $shell 'an ARM64 processor' @{ From = $good; Arch = 12; Reason = 'ARM64 processor'; NotRun = $true }
    Check $shell 'a 32-bit processor' @{ From = $good; Arch = 0; Reason = 'x64 processors only'; NotRun = $true }
    Check $shell 'an address that is not https' @{ From = 'http://example.invalid/Tasktap'; Reason = 'must be an https:// address'; NotRun = $true }
    Check $shell 'a release without the installer' @{ From = $half; Reason = 'this release does not have Tasktap_x64-setup.exe'; NotRun = $true }
    Check $shell 'an installer with the wrong SHA-256' @{ From = $wrong; Reason = 'SHA-256 is not the one SHA256SUMS lists'; NotRun = $true }
    Check $shell 'an installer that stops with code 1' @{ From = $good; Mode = 'fail'; Reason = 'the installer stopped with code 1' }
    Check $shell 'an installer that records a place with no program' @{ From = $good; Mode = 'no-program'; Reason = 'is not there' }
    $app = Join-Path $work 'tasktap-app.exe'
    Copy-Item -LiteralPath $setup -Destination $app -Force
    $running = Start-Process -FilePath $app -ArgumentList 'wait' -WindowStyle Hidden -PassThru
    try { Check $shell 'a running Tasktap' @{ From = $good; Reason = 'Tasktap is running'; NotRun = $true } }
    finally { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue; $running.WaitForExit(); $running = $null }
    Check $shell 'an installer with the right SHA-256' @{ From = $good }
    Check $shell 'the same in a session whose profile shadows what the script uses and turns strict mode on' @{ From = $good; Profile = $true }
  }
} finally {
  if ($running) { Stop-Process -Id $running.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { Write-Host 'install-check: FAILED'; exit 1 }
Write-Host 'install-check: every case holds.'
