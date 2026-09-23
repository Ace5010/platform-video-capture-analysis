[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '请右键 PowerShell 选择“以管理员身份运行”，再执行此脚本'
}

$privateProfiles = @(Get-NetConnectionProfile -ErrorAction Stop | Where-Object {
    $_.NetworkCategory -eq 'Private' -and $_.IPv4Connectivity -ne 'Disconnected'
})
if ($privateProfiles.Count -eq 0) {
    throw '没有活动的“专用网络”。请只在可信家庭/办公局域网中把当前网络改为“专用”，不要在公共网络放行端口'
}

$rules = @(
    @{ Name = 'Douyin Monitor Dashboard (Private LAN)'; Port = 3000 },
    @{ Name = 'Douyin Monitor Host API (Private LAN)'; Port = 43129 }
)

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        New-NetFirewallRule `
            -DisplayName $rule.Name `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $rule.Port `
            -RemoteAddress LocalSubnet `
            -Profile Private `
            -Enabled True | Out-Null
    }
    else {
        $existing | Set-NetFirewallRule -Direction Inbound -Action Allow -Profile Private -Enabled True -Protocol TCP -LocalPort $rule.Port -RemoteAddress LocalSubnet | Out-Null
    }
    Write-Host "[network] 已允许专用局域网访问 TCP $($rule.Port)"
}

Write-Host '[network] 未对“公用网络”或互联网开放任何端口。'
