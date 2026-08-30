[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$virtualPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
$hostService = Join-Path $projectRoot 'host_service\server.py'

if (-not (Test-Path -LiteralPath $virtualPython -PathType Leaf)) {
    throw 'ASR virtual environment is missing; run .\scripts\setup-asr.ps1 first'
}
if (-not (Test-Path -LiteralPath $hostService -PathType Leaf)) {
    throw "host service not found: $hostService"
}

$nodeCommand = Get-Command 'node.exe' -ErrorAction Stop
$vinextCli = Join-Path $projectRoot 'node_modules\vinext\dist\cli.js'
if (-not (Test-Path -LiteralPath $vinextCli -PathType Leaf)) {
    throw "Vinext CLI not found: $vinextCli"
}

function Start-ManagedProcess {
    [OutputType([System.Diagnostics.Process])]
    param(
        [Parameter(Mandatory)]
        [string] $Name,
        [Parameter(Mandatory)]
        [string] $FilePath,
        [Parameter(Mandatory)]
        [string[]] $ArgumentList
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $projectRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
        foreach ($argument in $ArgumentList) {
            [void] $startInfo.ArgumentList.Add($argument)
        }
    }
    else {
        $quotedArguments = $ArgumentList | ForEach-Object {
            '"' + $_.Replace('"', '\\"') + '"'
        }
        $startInfo.Arguments = [string]::Join(' ', $quotedArguments)
    }

    $childProcess = [System.Diagnostics.Process]::new()
    $childProcess.StartInfo = $startInfo
    if (-not $childProcess.Start()) {
        $childProcess.Dispose()
        throw "failed to start $Name"
    }
    Write-Host "[dev] started $Name, PID $($childProcess.Id)"
    return $childProcess
}

function Stop-ManagedProcess {
    param(
        [AllowNull()]
        [System.Diagnostics.Process] $ChildProcess,
        [string] $Name
    )

    if ($null -eq $ChildProcess) {
        return
    }
    try {
        $rootId = $ChildProcess.Id
        $ChildProcess.Refresh()
        if (-not $ChildProcess.HasExited) {
            Write-Host "[dev] stopping $Name, PID $rootId"
        }

        $processIds = New-Object System.Collections.Generic.List[int]
        $processIds.Add($rootId)
        $queue = New-Object System.Collections.Generic.Queue[int]
        $queue.Enqueue($rootId)
        while ($queue.Count -gt 0) {
            $parentId = $queue.Dequeue()
            $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId" -ErrorAction SilentlyContinue
            foreach ($child in $children) {
                if (-not $processIds.Contains([int]$child.ProcessId)) {
                    $processIds.Add([int]$child.ProcessId)
                    $queue.Enqueue([int]$child.ProcessId)
                }
            }
        }

        for ($index = $processIds.Count - 1; $index -ge 0; $index -= 1) {
            Stop-Process -Id $processIds[$index] -Force -ErrorAction SilentlyContinue
        }
    }
    catch {
        Write-Warning "failed to clean up ${Name}: $($_.Exception.Message)"
    }
    finally {
        $ChildProcess.Dispose()
    }
}

$hostProcess = $null
$webProcess = $null
$scriptExitCode = 0

try {
    $hostProcess = Start-ManagedProcess `
        -Name 'host API, queue, and local ASR' `
        -FilePath $virtualPython `
        -ArgumentList @('-m', 'host_service.server')

    Start-Sleep -Milliseconds 600
    $hostProcess.Refresh()
    if ($hostProcess.HasExited) {
        throw "host service failed to start, exit code: $($hostProcess.ExitCode)"
    }

    $webProcess = Start-ManagedProcess `
        -Name 'Vinext dev server' `
        -FilePath $nodeCommand.Source `
        -ArgumentList @($vinextCli, 'dev', '--hostname', '0.0.0.0', '--port', '3000')

    Write-Host '[dev] Dashboard: http://localhost:3000'
    Write-Host '[dev] Host API: http://127.0.0.1:43129/health'
    $lanAddresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }
    foreach ($lanAddress in $lanAddresses) {
        Write-Host "[dev] LAN dashboard: http://$($lanAddress.IPAddress):3000"
    }
    Write-Host '[dev] both services are running; Ctrl+C stops both.'

    while ($true) {
        Start-Sleep -Milliseconds 500
        $hostProcess.Refresh()
        $webProcess.Refresh()

        if ($hostProcess.HasExited) {
            $scriptExitCode = if ($hostProcess.ExitCode -eq 0) { 1 } else { $hostProcess.ExitCode }
            Write-Warning "host service exited, code: $($hostProcess.ExitCode)"
            break
        }
        if ($webProcess.HasExited) {
            $scriptExitCode = $webProcess.ExitCode
            Write-Host "[dev] Vinext dev server exited, code: $scriptExitCode"
            break
        }
    }
}
finally {
    Stop-ManagedProcess -ChildProcess $webProcess -Name 'Vinext dev server'
    Stop-ManagedProcess -ChildProcess $hostProcess -Name 'host API, queue, and local ASR'
}

exit $scriptExitCode
