# Stops one process gracefully with a console CTRL+C, falling back to a hard
# kill of exactly that process and its children.
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$WaitSeconds = 20
)
$ErrorActionPreference = 'Stop'

$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $process) {
    Write-Output "process $ProcessId is not running"
    exit 0
}

$source = @"
using System;
using System.Runtime.InteropServices;
public static class ConsoleSignal {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
}
"@
Add-Type -TypeDefinition $source -ErrorAction Stop

$sent = $false
try {
    [void][ConsoleSignal]::FreeConsole()
    if ([ConsoleSignal]::AttachConsole([uint32]$ProcessId)) {
        [void][ConsoleSignal]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
        $sent = [ConsoleSignal]::GenerateConsoleCtrlEvent(0, 0)
        Start-Sleep -Milliseconds 300
        [void][ConsoleSignal]::FreeConsole()
    }
} catch {
    Write-Output "console signal failed: $($_.Exception.Message)"
}
Write-Output "ctrl+c sent: $sent"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    Start-Sleep -Milliseconds 500
}

if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Write-Output "process $ProcessId did not exit; terminating its tree"
    # FreeConsole can leave native command launch without a console handle.
    # Use native PowerShell process operations for the verified descendant tree.
    $taskDescendants = [Collections.Generic.List[int]]::new()
    $taskQueue = [Collections.Generic.Queue[int]]::new()
    $taskQueue.Enqueue($ProcessId)
    while ($taskQueue.Count) {
        $taskParentId = $taskQueue.Dequeue()
        foreach ($taskChild in Get-CimInstance Win32_Process -Filter "ParentProcessId=$taskParentId") {
            $taskDescendants.Add([int]$taskChild.ProcessId)
            $taskQueue.Enqueue([int]$taskChild.ProcessId)
        }
    }
    for ($taskIndex = $taskDescendants.Count - 1; $taskIndex -ge 0; $taskIndex--) {
        Stop-Process -Id $taskDescendants[$taskIndex] -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
    Write-Output "process $ProcessId is still running"
    exit 1
}
Write-Output "process $ProcessId stopped"
