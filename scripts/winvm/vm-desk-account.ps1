# scripts\winvm\vm-desk-account.ps1, run once on the VM as administrator over SSH (copied to C:\tasktap): a standard account for the desktop round,
# tasktap-desk, signed in at the desktop automatically at start. Its password is made here, at random, and kept only as
# the LSA secret Winlogon reads (DefaultPassword): it is never printed, logged or written to a file. The round's task
# ("Tasktap Desktop") runs as this account in its session, with a PowerShell 7 of its own in C:\tasktap\pwsh.
$ErrorActionPreference = 'Stop'
$name = 'tasktap-desk'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TasktapLsa {
    [StructLayout(LayoutKind.Sequential)] struct Text { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct Attributes { public int Length; public IntPtr Root; public IntPtr Name; public uint Flags; public IntPtr Security; public IntPtr Quality; }
    [DllImport("advapi32.dll")] static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
    [DllImport("advapi32.dll")] static extern uint LsaStorePrivateData(IntPtr policy, ref Text key, IntPtr data);
    [DllImport("advapi32.dll")] static extern uint LsaClose(IntPtr policy);
    [DllImport("advapi32.dll")] static extern int LsaNtStatusToWinError(uint status);
    static Text Of(string s) { var t = new Text(); t.Buffer = Marshal.StringToHGlobalUni(s); t.Length = (ushort)(s.Length * 2); t.MaximumLength = (ushort)(s.Length * 2 + 2); return t; }
    static void Wipe(Text t) { for (int i = 0; i < t.MaximumLength; i++) Marshal.WriteByte(t.Buffer, i, 0); Marshal.FreeHGlobal(t.Buffer); }
    public static void Store(string name, string value) {
        var attributes = new Attributes(); attributes.Length = Marshal.SizeOf(attributes);
        IntPtr policy;
        uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x000F0FFF, out policy);
        if (status != 0) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
        var key = Of(name);
        var data = IntPtr.Zero;
        var text = new Text();
        try {
            if (value != null) { text = Of(value); data = Marshal.AllocHGlobal(Marshal.SizeOf(text)); Marshal.StructureToPtr(text, data, false); }
            status = LsaStorePrivateData(policy, ref key, data);
        } finally {
            if (value != null) { Wipe(text); Marshal.FreeHGlobal(data); }
            Marshal.FreeHGlobal(key.Buffer);
            LsaClose(policy);
        }
        if (status != 0 && !(value == null && status == 0xC0000034)) throw new System.ComponentModel.Win32Exception(LsaNtStatusToWinError(status));
    }
}
'@
# A random password, made and used here alone.
$bytes = [byte[]]::new(24)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$secret = 'Td9!' + [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString $secret -AsPlainText -Force
if (Get-LocalUser -Name $name -ErrorAction SilentlyContinue) {
    Set-LocalUser -Name $name -Password $secure
} else {
    New-LocalUser -Name $name -Password $secure -PasswordNeverExpires -AccountNeverExpires -Description 'Tasktap desktop round' | Out-Null
}
# A standard account: Users (S-1-5-32-545) and nothing more.
if (-not (Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object Name -like "*\$name")) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $name }
$admins = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object Name -like "*\$name")
if ($admins) { throw "$name is an administrator" }
[TasktapLsa]::Store('DefaultPassword', $secret)
$secret = $null; $secure = $null
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Remove-ItemProperty $winlogon -Name DefaultPassword -ErrorAction SilentlyContinue
Remove-ItemProperty $winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
Set-ItemProperty $winlogon -Name DefaultUserName -Value $name
Set-ItemProperty $winlogon -Name DefaultDomainName -Value $env:COMPUTERNAME
Set-ItemProperty $winlogon -Name AutoAdminLogon -Value '1'
# No privacy questions at a new account's first sign-in, which would stand in front of its desktop.
New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE' -Name DisablePrivacyExperience -Value 1 -Type DWord
# PowerShell 7 for the account: the Store's copy is this administrator's alone; its folder is copied whole.
$store = Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'Microsoft.PowerShell_7*_arm64__*' | Sort-Object Name | Select-Object -Last 1
if (-not (Test-Path 'C:\tasktap\pwsh\pwsh.exe')) { Copy-Item $store.FullName 'C:\tasktap\pwsh' -Recurse }
# The round's task runs as the account, in its signed-in session, not elevated, at normal priority.
$action = New-ScheduledTaskAction -Execute 'C:\tasktap\pwsh\pwsh.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\tasktap\desk\job.ps1'
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$name" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName 'Tasktap Desktop' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
"account ${name}: standard; automatic sign-in at start; task Tasktap Desktop runs as it; PowerShell $(& C:\tasktap\pwsh\pwsh.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')"
