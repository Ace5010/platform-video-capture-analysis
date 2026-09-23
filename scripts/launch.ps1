param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'launcher-lock.ps1')
$launchMutex = New-Object System.Threading.Mutex($false, 'Local\DouyinMonitorLauncher')
$locked = $false

function Test-HostReady {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:43129/health' -TimeoutSec 2
        return ($health.ok -eq $true -and $health.service -eq 'douyin-monitor-host')
    } catch { return $false }
}

function Test-WebReady {
    try {
        $page = Invoke-WebRequest 'http://localhost:3000' -UseBasicParsing -TimeoutSec 3
        return ($page.StatusCode -eq 200 -and $page.Content -match '内容情报台')
    } catch { return $false }
}

function Assert-PortFree([int]$Port) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
        throw "端口 $Port 已被占用，但服务未就绪。请稍后重试；如持续出现，请将此提示发给我排查。"
    }
}

try {
    $locked = $launchMutex.WaitOne(60000)
    if (-not $locked) { throw '另一个启动任务尚未完成，请稍后再次双击快捷方式。' }
    $python = Join-Path $projectRoot '.venv\Scripts\python.exe'
    $vinext = Join-Path $projectRoot 'node_modules\vinext\dist\cli.js'
    if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $vinext)) {
        throw '项目运行依赖缺失，请勿移动或删除项目中的 .venv 和 node_modules 文件夹。'
    }
    if (-not (Test-HostReady)) {
        Assert-PortFree 43129
        Start-Process -FilePath $python -ArgumentList @('-m', 'host_service.server') -WorkingDirectory $projectRoot -WindowStyle Hidden
    }
    if (-not (Test-WebReady)) {
        Assert-PortFree 3000
        Repair-DevLock $projectRoot
        $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
        Start-Process -FilePath $nodePath -ArgumentList @(('"' + $vinext + '"'), 'dev', '--hostname', '0.0.0.0', '--port', '3000') -WorkingDirectory $projectRoot -WindowStyle Hidden
    }
    $deadline = (Get-Date).AddSeconds(60)
    do {
        $ready = (Test-HostReady) -and (Test-WebReady)
        if ($ready) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if (-not $ready) { throw '启动超过 60 秒仍未就绪，请稍后重试，或将此提示发给我排查。' }
    if (-not $NoBrowser) {
        $chromePaths = @(
            (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
            (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
            (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
        )
        $chrome = $chromePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        if (-not $chrome) { throw '服务已启动，但未找到 Chrome。请在浏览器中打开 http://localhost:3000 。' }
        Start-Process -FilePath $chrome -ArgumentList 'http://localhost:3000'
    }
} catch {
    if ($NoBrowser) { throw }
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show($_.Exception.Message, '信源抓取与分析：启动提示', 'OK', 'Warning') | Out-Null
    exit 1
} finally {
    if ($locked) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
