function Test-DevLockStale($Lock, $Process) {
    if (-not $Process) { return $true }
    if ($Process.Name -ne 'node.exe') { return $true }
    # Windows can reuse an old Node PID too. Allow timestamp rounding.
    if ($Process.CreationDate -and $Lock.startedAt) {
        $created = ([DateTimeOffset]$Process.CreationDate).ToUnixTimeMilliseconds()
        if ($created -gt ([long]$Lock.startedAt + 2000)) { return $true }
    }
    return $false
}

function Repair-DevLock([string]$Root) {
    $path = Join-Path $Root '.vinext\dev\lock.json'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $raw = [IO.File]::ReadAllText($path)
    try { $lock = $raw | ConvertFrom-Json } catch { return }
    if (-not $lock.pid -or -not $lock.cwd) { return }
    if ([IO.Path]::GetFullPath($lock.cwd).TrimEnd('\') -ne [IO.Path]::GetFullPath($Root).TrimEnd('\')) { return }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$lock.pid)" -ErrorAction Stop
    if ((Test-DevLockStale $lock $owner) -and [IO.File]::ReadAllText($path) -eq $raw) {
        # Only this verified stale generated lock, never its process or directory.
        Remove-Item -LiteralPath $path
    }
}
