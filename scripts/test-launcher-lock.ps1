$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'launcher-lock.ps1')
$start = [DateTimeOffset]::UtcNow
$lock = @{ startedAt = $start.ToUnixTimeMilliseconds() }
if (-not (Test-DevLockStale $lock $null)) { throw 'Dead process must be stale' }
if (-not (Test-DevLockStale $lock @{Name='GameAssistService.exe'})) { throw 'Reused non-Node PID must be stale' }
if (-not (Test-DevLockStale $lock @{Name='node.exe'; CreationDate=$start.AddMinutes(1).UtcDateTime})) { throw 'Reused Node PID must be stale' }
if (Test-DevLockStale $lock @{Name='node.exe'; CreationDate=$start.AddSeconds(-2).UtcDateTime}) { throw 'Original live Node must be preserved' }
if (Test-DevLockStale $lock @{Name='node.exe'}) { throw 'Unknown live Node must be preserved' }
Write-Output 'Launcher lock checks passed.'
