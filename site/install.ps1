# Installs Tasktap on Windows (x64) for you alone from the newest release on GitHub. In PowerShell:
#   irm https://harzerheribert.github.io/Tasktap/install.ps1 | iex
# It downloads the installer and the release's list of SHA-256 sums over HTTPS, checks the installer against the list,
# runs it silently for you alone into %LOCALAPPDATA%\Tasktap (it never asks for an administrator), checks that Tasktap
# is there and starts it. A file a script downloads carries no mark of the internet, so SmartScreen does not stop it
# as it stops the same installer downloaded in a browser. Works in Windows PowerShell 5.1 and PowerShell 7, under any
# execution policy, since nothing here is run as a script file.
#
#   $env:TASKTAP_INSTALL_FROM = '<https address or folder>'  where the release's files are (default: the newest release)
#   $env:TASKTAP_INSTALL_NO_START = '1'                      do not start Tasktap afterwards
# The processor is read from PROCESSOR_ARCHITECTURE (PROCESSOR_ARCHITEW6432 in a 32-bit PowerShell), as Windows sets
# them. Tauri's installer takes /S (silent) and /D=<folder> (where to install; last, unquoted).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $name = 'Tasktap_x64-setup.exe'
  $from = 'https://github.com/HarzerHeribert/Tasktap/releases/latest/download'
  if ($env:TASKTAP_INSTALL_FROM) { $from = $env:TASKTAP_INSTALL_FROM.TrimEnd('/', '\') }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('tasktap-install-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
  try {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set, so there is no folder of your own to install into.' }
    $dir = Join-Path $env:LOCALAPPDATA 'Tasktap'
    $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    if ($arch -ne 'AMD64') { throw "Tasktap is built for Windows on x64 only, and this computer's processor is $arch." }
    if (Get-Process -Name 'tasktap-app' -ErrorAction SilentlyContinue) {
      throw 'Tasktap is running; quit it first (its icon by the clock, Quit), or update it from Settings > About.'
    }
    $web = $from -like 'https://*'
    if (-not $web -and -not [IO.Path]::IsPathRooted($from)) { throw 'TASKTAP_INSTALL_FROM must be an https:// address or a folder.' }
    $tls = @{ UseBasicParsing = $true }
    if ($PSVersionTable.PSVersion.Major -ge 6) { $tls.SslProtocol = 'Tls12, Tls13' }
    else { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 }
    New-Item -ItemType Directory -Path $tmp | Out-Null

    Write-Host "Downloading Tasktap's installer ($name) and the release's SHA256SUMS from $from"
    foreach ($file in 'SHA256SUMS', $name) {
      try {
        if ($web) { Invoke-WebRequest -Uri "$from/$file" -OutFile (Join-Path $tmp $file) @tls }
        else { Copy-Item -LiteralPath (Join-Path $from $file) -Destination $tmp }
      } catch { throw "$file could not be downloaded from $from; check the connection and try again." }
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
      "the release lists, both fetched over HTTPS from GitHub. Where Windows' Smart App Control is on, it may still " +
      'refuse a program without a signature, and nothing can be done about that from a script.')

    Write-Host "Installing Tasktap for you alone into $dir"
    try { $setup = Start-Process -FilePath (Join-Path $tmp $name) -ArgumentList "/S /D=$dir" -Wait -PassThru }
    catch { throw "Windows did not let the installer run ($($_.Exception.Message)); where Smart App Control is on, it refuses a program without a signature." }
    if ($setup.ExitCode -ne 0) { throw "the installer stopped with code $($setup.ExitCode)." }
    $exe = Join-Path $dir 'tasktap-app.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw "the installer finished, but $exe is not there." }

    Write-Host "Installed: $exe. To remove it: Settings > Apps > Installed apps > Tasktap > Uninstall."
    if ($env:TASKTAP_INSTALL_NO_START -eq '1') { Write-Host 'Start Tasktap from the Start menu.' }
    else {
      Start-Process -FilePath $exe
      Write-Host 'Tasktap is starting. Next time, start it from the Start menu.'
    }
  } catch {
    Write-Host "Tasktap was not installed: $($_.Exception.Message)"
    $global:LASTEXITCODE = 1
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
