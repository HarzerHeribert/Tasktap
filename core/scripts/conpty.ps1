# Puts Microsoft's console beside a core: conpty.dll and OpenConsole.exe from Microsoft's own
# package Microsoft.Windows.Console.ConPTY on nuget.org (MIT, github.com/microsoft/terminal;
# the licence is conpty-LICENSE.txt). The core's terminals run in it when it is there (design
# §9, "Input"): the console that ships with Windows can hold back a typed line.
#   pwsh core\scripts\conpty.ps1 -Target x86_64|aarch64 -Into <the folder of tasktap.exe>
# The package is downloaded once into -Cache (default: target\conpty beside this script's crate)
# and every file is checked against the checksums below before it is copied; both files carry
# Microsoft's signature, which is checked too.
param(
    [Parameter(Mandatory)][ValidateSet('x86_64', 'aarch64')][string]$Target,
    [Parameter(Mandatory)][string]$Into,
    [string]$Cache = (Join-Path (Split-Path $PSScriptRoot -Parent) 'target\conpty')
)
$ErrorActionPreference = 'Stop'
$version = '1.25.261109001'
$package = '3D77F535DF848E44225C2A8912AC844FECB23F3057732B639F3034B587496F09'
$files = @{
    'x86_64'  = @{
        'runtimes\win-x64\native\conpty.dll'         = 'E971856F89748DC3B458125E9AFDD79B5E9574A7C937676116D3CBBD3B71F492'
        'build\native\runtimes\x64\OpenConsole.exe'  = 'B17E48B07EF153B420F0A6E178BACD31FB4C3390E21AE746586213FC0719A775'
    }
    'aarch64' = @{
        'runtimes\win-arm64\native\conpty.dll'         = '3608CEF830A1C4FBBF3981594AD3F64EBE2DF6DB98FE43A48A4CA7D2875D8959'
        'build\native\runtimes\arm64\OpenConsole.exe'  = 'C04334F450B5731930B63A28AC4DA8A058367242DBCF2FB9B323EA25E5A23252'
    }
}
function Test-Sum($path, $sum) { (Test-Path $path) -and (Get-FileHash $path -Algorithm SHA256).Hash -eq $sum }

$zip = Join-Path $Cache "conpty-$version.zip"
$tree = Join-Path $Cache "conpty-$version"
if (-not (Test-Sum $zip $package)) {
    New-Item -ItemType Directory -Force $Cache | Out-Null
    $url = "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$version/microsoft.windows.console.conpty.$version.nupkg"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    if (-not (Test-Sum $zip $package)) { throw "The downloaded package is not Microsoft.Windows.Console.ConPTY $version (checksum)." }
    Remove-Item $tree -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path $tree)) { Expand-Archive $zip $tree }
foreach ($file in $files[$Target].GetEnumerator()) {
    $from = Join-Path $tree $file.Key
    if (-not (Test-Sum $from $file.Value)) { throw "$($file.Key) is not the file of ConPTY $version (checksum)." }
    $signed = Get-AuthenticodeSignature $from
    if ($signed.Status -ne 'Valid' -or $signed.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "$($file.Key) is not signed by Microsoft."
    }
    Copy-Item $from (Join-Path $Into (Split-Path $file.Key -Leaf)) -Force
}
Write-Host "ConPTY $version ($Target) beside $Into"
