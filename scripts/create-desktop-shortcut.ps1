param([switch]$EnableAutoStart, [switch]$DisableAutoStart)

$ErrorActionPreference = 'Stop'
if ($EnableAutoStart -and $DisableAutoStart) { throw '不能同时启用和关闭开机启动。' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw '找不到启动脚本。' }
$localIcon = Join-Path $projectRoot 'public\desktop-icons\observe-coral-rounded.ico'
$onlineIcon = $localIcon
$desktop = [Environment]::GetFolderPath('Desktop')
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) '信源抓取与分析后台.lnk'
if ($DisableAutoStart) {
    if (Test-Path -LiteralPath $startupShortcut) { Remove-Item -LiteralPath $startupShortcut }
    Write-Output '已关闭登录 Windows 后自动启动后台。'
    return
}
if (-not (Test-Path -LiteralPath $localIcon) -or -not (Test-Path -LiteralPath $onlineIcon)) { throw '找不到桌面图标文件。' }
$shell = New-Object -ComObject WScript.Shell
$backupDirectory = Join-Path $projectRoot ('outputs\shortcut-backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
function Backup-Shortcut([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        [IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
        Copy-Item -LiteralPath $Path -Destination $backupDirectory
    }
}
$shortcutPath = if ($EnableAutoStart) { $startupShortcut } else { Join-Path $desktop 'Observe（本地）.lnk' }
if (-not $EnableAutoStart) {
    $websiteOrigin = (Get-Content -LiteralPath (Join-Path $projectRoot 'cloudflare-pages.json') -Raw | ConvertFrom-Json).publicOrigin
    $websiteUri = [Uri]$websiteOrigin
    if (-not $websiteUri.IsAbsoluteUri -or $websiteUri.Scheme -ne 'https' -or $websiteUri.UserInfo -or $websiteUri.Query -or $websiteUri.Fragment) {
        throw '正式网站地址必须是无凭据、参数的 HTTPS 地址。'
    }
    $chrome = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $chrome) { throw '未找到 Chrome，无法创建在线快捷方式。' }
    $onlinePath = Join-Path $desktop 'Observe（在线）.lnk'
    foreach ($path in @($shortcutPath, $onlinePath)) {
        if (Test-Path -LiteralPath $path) {
            $existing = $shell.CreateShortcut($path)
            $owned = if ($path -eq $shortcutPath) {
                $existing.WorkingDirectory -eq $projectRoot -and $existing.Arguments.Contains($launcher)
            } else {
                $existing.TargetPath -eq $chrome -and $existing.Arguments.TrimEnd('/') -eq $websiteOrigin.TrimEnd('/')
            }
            if (-not $owned) { throw "同名快捷方式指向其他目标，已保留：$path" }
        }
    }
}
Backup-Shortcut $shortcutPath
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = if ($EnableAutoStart) {
    '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -NoBrowser'
} else {
    '-NoLogo -NoProfile -NoExit -ExecutionPolicy Bypass -File "' + $launcher + '" -Console'
}
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = if ($EnableAutoStart) { '登录 Windows 后提前启动工作台后台和远程通道，不打开浏览器、不自动采集或分析。' } else { '启动本机服务并打开 http://localhost:3000；重复打开复用现有服务。' }
$shortcut.WindowStyle = if ($EnableAutoStart) { 7 } else { 1 }
$shortcut.IconLocation = $localIcon + ',0'
$shortcut.Save()
Write-Output "$(if ($EnableAutoStart) { '后台开机启动已启用' } else { '桌面快捷方式已恢复' })：$shortcutPath"
if (-not $EnableAutoStart) {
    Backup-Shortcut $onlinePath
    $online = $shell.CreateShortcut($onlinePath)
    $online.TargetPath = $chrome
    $online.Arguments = $websiteUri.AbsoluteUri
    $online.WorkingDirectory = Split-Path -Parent $chrome
    $online.Description = '打开已部署的网站：' + $websiteUri.AbsoluteUri
    $online.WindowStyle = 1
    $online.IconLocation = $onlineIcon + ',0'
    $online.Save()
    Write-Output "桌面快捷方式已恢复：$onlinePath"
    foreach ($name in @('Observe.lnk', '信源抓取与分析.lnk')) {
        $oldPath = Join-Path $desktop $name
        if (Test-Path -LiteralPath $oldPath) {
            $old = $shell.CreateShortcut($oldPath)
            if ($old.WorkingDirectory -eq $projectRoot -and $old.Arguments.Contains($launcher)) {
                Backup-Shortcut $oldPath
                Remove-Item -LiteralPath $oldPath
            }
        }
    }
    if (Test-Path -LiteralPath $backupDirectory) { Write-Output "旧快捷方式备份：$backupDirectory" }
}
