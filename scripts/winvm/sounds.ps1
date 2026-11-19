# Dot-sourced by desktop.ps1 and gpu.ps1, the rounds at the tower's desktop: this account's sounds for the system's
# events, and its warning beep, off for as long as a round runs (Sounds-Off, which says how many it switched off) and
# put back after (Sounds-On, which says how many it put back): a key no window takes, a dialog or an error must not
# be heard. What they were is kept in a file, so that a round that was cut short is put right by the next one, of
# either kind.
Add-Type -Namespace Tasktap -Name Sound -MemberDefinition @'
[DllImport("user32.dll")] static extern bool SystemParametersInfo(uint what, uint value, ref int answer, uint how);
// The warning beep of this session, read and set; nothing is written to the account's settings.
public static bool Beep() { int on = 0; SystemParametersInfo(1, 0, ref on, 0); return on != 0; }
public static void Beep(bool on) { int none = 0; SystemParametersInfo(2, on ? 1u : 0u, ref none, 0); }
'@
$sounds = 'C:\tasktap\desktop-rounds\sounds-off.json'
function Sounds-Off {
    if (Test-Path $sounds) { $null = Sounds-On }
    New-Item -ItemType Directory -Force (Split-Path $sounds) | Out-Null
    $was = [Collections.Generic.List[object]]::new()
    $apps = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('AppEvents\Schemes\Apps')
    foreach ($program in @(if ($apps) { $apps.GetSubKeyNames() })) {
        $its = $apps.OpenSubKey($program)
        foreach ($occasion in $its.GetSubKeyNames()) {
            $key = $its.OpenSubKey("$occasion\.Current", $true)
            if (-not $key) { continue }
            $value = $key.GetValue('', $null, 'DoNotExpandEnvironmentNames')
            if ($value) { $was.Add(@{ key = "AppEvents\Schemes\Apps\$program\$occasion\.Current"; value = "$value"; kind = "$($key.GetValueKind(''))" }) }
            $key.Dispose()
        }
    }
    ConvertTo-Json @{ beep = [Tasktap.Sound]::Beep(); sounds = $was.ToArray() } -Depth 4 | Set-Content $sounds
    foreach ($sound in $was) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sound.key, $true)
        $key.SetValue('', '', [Microsoft.Win32.RegistryValueKind]$sound.kind)
        $key.Dispose()
    }
    [Tasktap.Sound]::Beep($false)
    $was.Count
}
function Sounds-On {
    if (-not (Test-Path $sounds)) { return 0 }
    $was = Get-Content $sounds -Raw | ConvertFrom-Json
    foreach ($sound in @($was.sounds)) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($sound.key, $true)
        if ($key) { $key.SetValue('', $sound.value, [Microsoft.Win32.RegistryValueKind]$sound.kind); $key.Dispose() }
    }
    [Tasktap.Sound]::Beep([bool]$was.beep)
    Remove-Item $sounds
    @($was.sounds).Count
}
