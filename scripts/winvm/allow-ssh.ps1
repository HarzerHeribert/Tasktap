# Run elevated. The build VM uses a single NAT adapter.
$ErrorActionPreference = 'Stop'
$rule = 'OpenSSH-Server-In-TCP'
if (Get-NetFirewallRule -Name $rule -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name $rule -Enabled True -Profile Any -RemoteAddress LocalSubnet
} else {
    New-NetFirewallRule -Name $rule -DisplayName 'OpenSSH Server' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -Profile Any -RemoteAddress LocalSubnet
}
