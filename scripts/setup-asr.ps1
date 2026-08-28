[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$virtualEnvironment = Join-Path $projectRoot '.venv'
$virtualPython = Join-Path $virtualEnvironment 'Scripts\python.exe'
$requirements = Join-Path $projectRoot 'requirements-asr.txt'

if (-not (Test-Path -LiteralPath $requirements -PathType Leaf)) {
    throw "ASR requirements file not found: $requirements"
}

if (-not (Test-Path -LiteralPath $virtualPython -PathType Leaf)) {
    Write-Host "[setup-asr] creating $virtualEnvironment"
    $pythonLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue
    if ($null -ne $pythonLauncher) {
        & $pythonLauncher.Source -3 -m venv $virtualEnvironment
    }
    else {
        $systemPython = Get-Command 'python.exe' -ErrorAction Stop
        & $systemPython.Source -m venv $virtualEnvironment
    }
    if ($LASTEXITCODE -ne 0) {
        throw "failed to create Python virtual environment, exit code: $LASTEXITCODE"
    }
}

Write-Host '[setup-asr] upgrading pip'
& $virtualPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) {
    throw "pip upgrade failed, exit code: $LASTEXITCODE"
}

Write-Host '[setup-asr] installing faster-whisper (CPU)'
& $virtualPython -m pip install --disable-pip-version-check --requirement $requirements
if ($LASTEXITCODE -ne 0) {
    throw "ASR dependency installation failed, exit code: $LASTEXITCODE"
}

Write-Host '[setup-asr] setup complete. The small model downloads on first transcription.'
