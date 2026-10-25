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

# Import only the status-check function; never execute the production launcher.
$parseErrors = $null
$tokens = $null
$launcherAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'launch.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Launcher syntax is invalid' }
$statusFunction = $launcherAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-RemoteStartupWarning'}, $true)
Invoke-Expression $statusFunction.Extent.Text
$script:fixtureHealth = $null
function Invoke-RestMethod { return $script:fixtureHealth }
foreach ($testCase in @(
    @{ remote = @{ state = 'not_configured' }; warns = $false },
    @{ remote = @{ state = 'connected'; readyConnections = 4 }; warns = $false },
    @{ remote = @{ state = 'connected'; readyConnections = 0 }; warns = $true },
    @{ remote = @{ state = 'waiting'; nextRetrySeconds = 5 }; warns = $true },
    @{ remote = @{ state = 'blocked'; lastError = 'Fixture error' }; warns = $true },
    @{ remote = $null; warns = $true }
)) {
    $script:fixtureHealth = @{ service = 'douyin-monitor-host'; remote = $testCase.remote }
    $warning = Get-RemoteStartupWarning -TimeoutSeconds 0
    if ([bool]$warning -ne $testCase.warns) { throw "Unexpected remote startup status: $($testCase.remote.state)" }
}
Write-Output 'Remote startup checks passed (mock responses only).'

# Service readiness and occupied ports must stay independent from remote status.
foreach ($name in @('Test-HostReady', 'Test-WebReady', 'Assert-PortFree')) {
    $functionAst = $launcherAst.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name}, $true)
    Invoke-Expression $functionAst.Extent.Text
}
$script:fixtureHealth = @{ ok = $true; service = 'another-service' }
if (Test-HostReady) { throw 'An unrelated service must not count as the host' }
$script:fixtureHealth = @{ ok = $false; service = 'douyin-monitor-host' }
if (Test-HostReady) { throw 'An unhealthy host must not count as ready' }
$script:fixtureHealth = @{ ok = $true; service = 'douyin-monitor-host' }
if (-not (Test-HostReady)) { throw 'The healthy host must be ready' }
function Invoke-WebRequest { return $script:fixtureWeb }
$script:fixtureWeb = @{ StatusCode = 200; Content = '<title>内容情报台</title>' }
if (-not (Test-WebReady)) { throw 'The workbench metadata must match even while login is loading' }
$script:fixtureWeb = @{ StatusCode = 500; Content = '内容情报台' }
if (Test-WebReady) { throw 'A failing web response must not be ready' }
$script:fixtureWeb = @{ StatusCode = 200; Content = 'Other application' }
if (Test-WebReady) { throw 'An unrelated page must not be ready' }
function Get-NetTCPConnection { return $script:fixtureListener }
$script:fixtureListener = $null
Assert-PortFree 43129
$script:fixtureListener = @{ LocalPort = 43129 }
$rejected = $false
try { Assert-PortFree 43129 } catch { $rejected = $_.Exception.Message -match '43129' }
if (-not $rejected) { throw 'An occupied unready port must be rejected without stopping its process' }
Write-Output 'Launcher readiness and port checks passed (mock responses only).'
