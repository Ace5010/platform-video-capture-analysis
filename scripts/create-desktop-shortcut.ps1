param([switch]$EnableAutoStart, [switch]$DisableAutoStart)

$ErrorActionPreference = 'Stop'
if ($EnableAutoStart -and $DisableAutoStart) { throw '不能同时启用和关闭开机启动。' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'launch.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw '找不到启动脚本。' }
$desktop = [Environment]::GetFolderPath('Desktop')
$startupShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) '信源抓取与分析后台.lnk'
if ($DisableAutoStart) {
    if (Test-Path -LiteralPath $startupShortcut) { Remove-Item -LiteralPath $startupShortcut }
    Write-Output '已关闭登录 Windows 后自动启动后台。'
    return
}
$shell = New-Object -ComObject WScript.Shell
$shortcutPath = if ($EnableAutoStart) { $startupShortcut } else { Join-Path $desktop '信源抓取与分析.lnk' }
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
if ($EnableAutoStart) { $shortcut.Arguments += ' -NoBrowser' }
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = if ($EnableAutoStart) { '登录 Windows 后提前启动工作台后台和远程通道，不打开浏览器、不自动采集或分析。' } else { '自动启动后台与工作台，等待就绪后打开 Chrome；已运行时直接打开网页。' }
$shortcut.WindowStyle = 7
$shortcut.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',13'
$shortcut.Save()
Write-Output "$(if ($EnableAutoStart) { '后台开机启动已启用' } else { '桌面快捷方式已恢复' })：$shortcutPath"
