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
# What describes this computer comes from whoami, Get-CimInstance and Get-ItemProperty, which scripts/install-check.ps1
# stands in for with functions of the same names in the PowerShell it runs this in.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $name = 'Tasktap_x64-setup.exe'
  $from = 'https://github.com/HarzerHeribert/Tasktap/releases/latest/download'
  if ($env:TASKTAP_INSTALL_FROM) { $from = $env:TASKTAP_INSTALL_FROM.TrimEnd('/', '\') }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('tasktap-install-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  $protocols = [Net.ServicePointManager]::SecurityProtocol
  try {
    # This PowerShell's integrity level: High (S-1-16-12288) or System (S-1-16-16384) is an elevated one.
    if (@(whoami /groups /fo csv /nh) -match '"S-1-16-(12288|16384)"') {
      throw 'this PowerShell runs as administrator; paste the line into an ordinary PowerShell window, so that Tasktap is installed for you alone.'
    }
    # The processor itself, also when an x64 PowerShell runs on Windows on ARM: 9 is x64, 12 is ARM64.
    $arch = @(Get-CimInstance -ClassName Win32_Processor)[0].Architecture
    if ($arch -eq 12) { throw 'Tasktap for Windows is built for x64 processors only for now, and this computer has an ARM64 processor; there is no build for it yet.' }
    if ($arch -ne 9) { throw "Tasktap for Windows is built for x64 processors only, and this computer's processor is not one (Win32_Processor.Architecture $arch)." }
    $session = (Get-Process -Id $PID).SessionId
    if (Get-Process -Name 'tasktap-app' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }) {
      throw 'Tasktap is running; quit it first (its icon by the clock, Quit), or update it from Settings > About.'
    }
    $web = $from -like 'https://*'
    if (-not $web -and -not [IO.Path]::IsPathRooted($from)) { throw 'TASKTAP_INSTALL_FROM must be an https:// address or a folder.' }
    if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = $protocols -bor [Net.SecurityProtocolType]::Tls12 }
    New-Item -ItemType Directory -Path $tmp | Out-Null

    Write-Host "Downloading Tasktap's installer ($name) and the release's SHA256SUMS from $from"
    foreach ($file in 'SHA256SUMS', $name) {
      if (-not $web) {
        $path = Join-Path $from $file
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "this release does not have $file (there is no $path)." }
        Copy-Item -LiteralPath $path -Destination $tmp
        continue
      }
      try { Invoke-WebRequest -Uri "$from/$file" -OutFile (Join-Path $tmp $file) -UseBasicParsing }
      catch {
        if ([int]$_.Exception.Response.StatusCode -eq 404) { throw "this release does not have $file ($from/$file answers 404); it may be older than this line." }
        throw "$file could not be downloaded from $($from): $($_.Exception.Message)"
      }
    }
    $want = foreach ($line in Get-Content -LiteralPath (Join-Path $tmp 'SHA256SUMS')) {
      $field = $line.Trim() -split '\s+\*?', 2
      if ($field.Count -eq 2 -and $field[1] -eq $name) { $field[0] }
    }
    $stream = [IO.File]::OpenRead((Join-Path $tmp $name))
    try { $have = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) }
    finally { $stream.Dispose() }
    if (-not $want -or $have -ne $want) { throw "the installer's SHA-256 is not the one SHA256SUMS lists, so it was not run; try again later." }
    Write-Host "Checked: the installer's SHA-256 is the one the release lists ($have)."
    Write-Host ('Tasktap for Windows is not code-signed. What vouches for this installer is that its SHA-256 is the one ' +
      "the release lists, both fetched over HTTPS from GitHub. Where Windows' Smart App Control is on, it may refuse " +
      'the installer or the installed app, since neither has a signature, and nothing can be done about that from a script.')

    Write-Host 'Installing Tasktap for you alone; the installer also puts a shortcut on the desktop and in the Start menu.'
    try { $setup = Start-Process -FilePath (Join-Path $tmp $name) -ArgumentList '/S' -PassThru }
    catch { throw "Windows did not let the installer run ($($_.Exception.Message)); where Smart App Control is on, it refuses a program without a signature." }
    # Waiting for the installer alone: what it starts and leaves running is not waited for.
    $null = $setup.Handle
    $setup.WaitForExit()
    if ($setup.ExitCode -ne 0) { throw "the installer stopped with code $($setup.ExitCode)." }
    $entry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Tasktap' -ErrorAction SilentlyContinue
    $dir = "$($entry.InstallLocation)".Trim().Trim('"')
    if (-not $dir) { throw 'the installer finished, but it recorded no place where it put Tasktap.' }
    $exe = Join-Path $dir 'tasktap-app.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "the installer finished, but $exe is not there." }

    Write-Host "Installed: $exe. To remove it: Settings > Apps > Installed apps > Tasktap > Uninstall."
    if ($env:TASKTAP_INSTALL_NO_START -eq '1') { Write-Host 'Start Tasktap from the Start menu or the desktop.' }
    else {
      Start-Process -FilePath $exe
      Write-Host 'Tasktap is starting. Next time, start it from the Start menu or the desktop.'
    }
  } catch {
    Write-Host "Tasktap was not installed: $($_.Exception.Message)"
    $global:LASTEXITCODE = 1
  } finally {
    [Net.ServicePointManager]::SecurityProtocol = $protocols
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
