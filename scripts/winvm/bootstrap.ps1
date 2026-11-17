# Runs once, elevated, from the private answer-file disc.
$ErrorActionPreference = 'Stop'
Start-Transcript C:\Windows\Temp\tasktap-bootstrap.log
$logon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty $logon AutoAdminLogon '0'
Remove-ItemProperty $logon DefaultPassword -ErrorAction SilentlyContinue
Set-ItemProperty $logon AutoLogonCount 0

$tools = Get-Volume | Where-Object FileSystemLabel -eq 'VMware Tools'
$installer = '{0}:\setup.exe' -f $tools.DriveLetter
$install = Start-Process $installer -ArgumentList '/S /v"/qn REBOOT=ReallySuppress"' -Wait -PassThru
if ($install.ExitCode -notin 0,3010) { throw "VMware Tools exited $($install.ExitCode)" }

Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
$ssh = "$env:ProgramData\ssh"
New-Item $ssh -ItemType Directory -Force | Out-Null
Copy-Item "$PSScriptRoot\client.pub" "$ssh\administrators_authorized_keys" -Force
icacls.exe "$ssh\administrators_authorized_keys" /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F'
if ($LASTEXITCODE) { throw 'SSH key ACL failed' }
@'
PubkeyAuthentication yes
PasswordAuthentication no
AuthenticationMethods publickey
AllowUsers tasktap
AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys
Subsystem sftp sftp-server.exe
'@ | Set-Content "$ssh\sshd_config" -Encoding ascii
Set-Service sshd -StartupType Automatic
Start-Service sshd
& "$PSScriptRoot\allow-ssh.ps1"
$hostKey = Get-Content "$ssh\ssh_host_ed25519_key.pub" -Raw
& "$env:ProgramFiles\VMware\VMware Tools\vmtoolsd.exe" --cmd "info-set guestinfo.tasktap.hostkey $($hostKey.Trim())"
if ($LASTEXITCODE) { throw 'Could not publish SSH host public key to Fusion' }
Stop-Transcript
# Finish binding the VMware drivers before expecting network access.
shutdown.exe /r /t 10
