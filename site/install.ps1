# Installs Tasktap on Windows (x64) for you alone from the newest release on GitHub. In an ordinary PowerShell window:
#   irm https://harzerheribert.github.io/Tasktap/install.ps1 | iex
# It downloads the installer and the release's list of SHA-256 sums over HTTPS, checks the installer against the list,
# runs it silently for you alone (Tauri's installer, /S: into %LOCALAPPDATA%\Tasktap, or where an earlier install put
# Tasktap; with a shortcut on the desktop and in the Start menu), finds Tasktap where the installer recorded it, and
# starts it. It never asks for an administrator, and refuses to run in a PowerShell that is one. A file a script
# downloads carries no mark of the internet, so SmartScreen does not stop it as it stops the same installer downloaded
# in a browser. Works in Windows PowerShell 5.1 and PowerShell 7, under any execution policy, since nothing here is run
# as a script file, and leaves nothing behind in the PowerShell it runs in.
#
#   $env:TASKTAP_INSTALL_FROM = '<https address or folder>'  where the release's files are (default: the newest release)
#   $env:TASKTAP_INSTALL_NO_START = '1'                      do not start Tasktap afterwards
# It runs in your own PowerShell, so nothing from your profile may change it: everything it calls is .NET or a cmdlet
# named with its module, and strict mode and parameter defaults are its own. scripts/install-check.ps1
# stands in for what describes the computer in a copy of this script.
& {
  Microsoft.PowerShell.Core\Set-StrictMode -Off
  $PSDefaultParameterValues = @{}
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $name = 'Tasktap_x64-setup.exe'
  $from = 'https://github.com/HarzerHeribert/Tasktap/releases/latest/download'
  if ($env:TASKTAP_INSTALL_FROM) { $from = $env:TASKTAP_INSTALL_FROM.TrimEnd('/', '\') }
  $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'tasktap-install-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  $protocols = [Net.ServicePointManager]::SecurityProtocol
  try {
    if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw ('this PowerShell runs as administrator; paste the line into an ordinary PowerShell window, so that Tasktap is ' +
        'installed for you alone, or, where every PowerShell runs so, download the installer from https://harzerheribert.github.io/Tasktap/')
    }
    # The processor itself, also when an x64 PowerShell runs on Windows on ARM: 9 is x64, 12 is ARM64.
    $arch = @(CimCmdlets\Get-CimInstance -ClassName Win32_Processor)[0].Architecture
    if ($arch -eq 12) { throw 'Tasktap for Windows is built for x64 processors only for now, and this computer has an ARM64 processor; there is no build for it yet.' }
    if ($arch -ne 9) { throw "Tasktap for Windows is built for x64 processors only, and this computer's processor is not one (Win32_Processor.Architecture $arch)." }
    $session = (Microsoft.PowerShell.Management\Get-Process -Id $PID).SessionId
    if (Microsoft.PowerShell.Management\Get-Process -Name 'tasktap-app' -ErrorAction SilentlyContinue | Microsoft.PowerShell.Core\Where-Object { $_.SessionId -eq $session }) {
      throw 'Tasktap is running; quit it first (its icon by the clock, Quit), or update it from Settings > About.'
    }
    $web = $from -like 'https://*'
    if (-not $web -and -not [IO.Path]::IsPathRooted($from)) { throw 'TASKTAP_INSTALL_FROM must be an https:// address or a folder.' }
    if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = $protocols -bor [Net.SecurityProtocolType]::Tls12 }
    $null = [IO.Directory]::CreateDirectory($tmp)

    Microsoft.PowerShell.Utility\Write-Host "Downloading Tasktap's installer ($name) and the release's SHA256SUMS from $from"
    foreach ($file in 'SHA256SUMS', $name) {
      $into = [IO.Path]::Combine($tmp, $file)
      if (-not $web) {
        $path = [IO.Path]::Combine($from, $file)
        if (-not [IO.File]::Exists($path)) { throw "this release does not have $file (there is no $path)." }
        [IO.File]::Copy($path, $into)
        continue
      }
      try { Microsoft.PowerShell.Utility\Invoke-WebRequest -Uri "$from/$file" -OutFile $into -UseBasicParsing }
      catch {
        if ([int]$_.Exception.Response.StatusCode -eq 404) { throw "this release does not have $file ($from/$file answers 404); it may be older than this line." }
        throw "$file could not be downloaded from $($from): $($_.Exception.Message)"
      }
    }
    $want = foreach ($line in [IO.File]::ReadAllLines([IO.Path]::Combine($tmp, 'SHA256SUMS'))) {
      $field = $line.Trim() -split '\s+\*?', 2
      if ($field.Count -eq 2 -and $field[1] -eq $name) { $field[0] }
    }
    $setupPath = [IO.Path]::Combine($tmp, $name)
    $stream = [IO.File]::OpenRead($setupPath)
    try { $have = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
    if (-not $want -or $have -ne $want) { throw "the installer's SHA-256 is not the one SHA256SUMS lists, so it was not run; try again later." }
    Microsoft.PowerShell.Utility\Write-Host "Checked: the installer's SHA-256 is the one the release lists ($have)."
    Microsoft.PowerShell.Utility\Write-Host ('Tasktap for Windows is not code-signed. What vouches for this installer is that its SHA-256 is the one ' +
      "the release lists, both fetched over HTTPS from GitHub. Where Windows' Smart App Control is on, it may refuse " +
      'the installer or the installed app, since neither has a signature, and nothing can be done about that from a script.')

    Microsoft.PowerShell.Utility\Write-Host 'Installing Tasktap for you alone; the installer also puts a shortcut on the desktop and in the Start menu.'
    try { $setup = Microsoft.PowerShell.Management\Start-Process -FilePath $setupPath -ArgumentList '/S' -PassThru }
    catch { throw "Windows did not let the installer run ($($_.Exception.Message)); where Smart App Control is on, it refuses a program without a signature." }
    # Waiting for the installer alone: what it starts and leaves running is not waited for.
    $null = $setup.Handle
    $setup.WaitForExit()
    if ($setup.ExitCode -ne 0) { throw "the installer stopped with code $($setup.ExitCode)." }
    $entry = Microsoft.PowerShell.Management\Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tasktap' -ErrorAction SilentlyContinue
    $dir = "$($entry.InstallLocation)".Trim().Trim('"')
    if (-not $dir) { throw 'the installer finished, but it recorded no place where it put Tasktap.' }
    $exe = [IO.Path]::Combine($dir, 'tasktap-app.exe')
    if (-not [IO.File]::Exists($exe)) { throw "the installer finished, but $exe is not there." }

    Microsoft.PowerShell.Utility\Write-Host "Installed: $exe. To remove it: Settings > Apps > Installed apps > Tasktap > Uninstall."
    if ($env:TASKTAP_INSTALL_NO_START -eq '1') { Microsoft.PowerShell.Utility\Write-Host 'Start Tasktap from the Start menu or the desktop.' }
    else {
      Microsoft.PowerShell.Management\Start-Process -FilePath $exe
      Microsoft.PowerShell.Utility\Write-Host 'Tasktap is starting. Next time, start it from the Start menu or the desktop.'
    }
  } catch {
    Microsoft.PowerShell.Utility\Write-Host "Tasktap was not installed: $($_.Exception.Message)"
    $global:LASTEXITCODE = 1
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $protocols
    try { [IO.Directory]::Delete($tmp, $true) } catch { }
  }
}
