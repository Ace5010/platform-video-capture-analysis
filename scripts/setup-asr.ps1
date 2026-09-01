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

$configuredPunctuationModel = [Environment]::GetEnvironmentVariable('DOUYIN_PUNCTUATION_MODEL')
if ([string]::IsNullOrWhiteSpace($configuredPunctuationModel)) {
    $localDataRoot = Join-Path $projectRoot 'data'
    $punctuationModel = Join-Path $localDataRoot 'models\punctuation\model.int8.onnx'
}
else {
    $punctuationModel = [IO.Path]::GetFullPath($configuredPunctuationModel)
}

if (-not (Test-Path -LiteralPath $punctuationModel -PathType Leaf)) {
    $modelUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2'
    $expectedSha256 = 'C0D5AA5F8EEB686032345E180BEDF39319DC2E0556781C6264BCADBA8328A6E1'
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $temporaryId = [Guid]::NewGuid().ToString('N')
    $archivePath = Join-Path $temporaryRoot "douyin-punctuation-$temporaryId.tar.bz2"
    $extractRoot = Join-Path $temporaryRoot "douyin-punctuation-$temporaryId"
    $resolvedExtractRoot = [IO.Path]::GetFullPath($extractRoot)
    if (-not $resolvedExtractRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to create punctuation extraction directory outside the system temp directory'
    }

    Write-Host '[setup-asr] downloading local Chinese punctuation model (about 62 MiB)'
    New-Item -ItemType Directory -Force -Path $resolvedExtractRoot | Out-Null
    try {
        & curl.exe -L --fail --retry 2 --output $archivePath $modelUrl
        if ($LASTEXITCODE -ne 0) {
            throw "punctuation model download failed, exit code: $LASTEXITCODE"
        }
        $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash
        if ($actualSha256 -ne $expectedSha256) {
            throw "punctuation model checksum mismatch: $actualSha256"
        }
        & tar.exe -xjf $archivePath -C $resolvedExtractRoot
        if ($LASTEXITCODE -ne 0) {
            throw "punctuation model extraction failed, exit code: $LASTEXITCODE"
        }
        $modelSource = Get-ChildItem -LiteralPath $resolvedExtractRoot -Recurse -Filter 'model.int8.onnx' -File | Select-Object -First 1
        if ($null -eq $modelSource) {
            throw 'model.int8.onnx was not found in the verified punctuation archive'
        }
        $punctuationModelDirectory = Split-Path -Parent $punctuationModel
        New-Item -ItemType Directory -Force -Path $punctuationModelDirectory | Out-Null
        Copy-Item -LiteralPath $modelSource.FullName -Destination $punctuationModel -Force
    }
    finally {
        if (Test-Path -LiteralPath $archivePath -PathType Leaf) {
            Remove-Item -LiteralPath $archivePath -Force
        }
        if (Test-Path -LiteralPath $resolvedExtractRoot -PathType Container) {
            $verifiedExtractRoot = [IO.Path]::GetFullPath($resolvedExtractRoot)
            if ($verifiedExtractRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
                Remove-Item -LiteralPath $verifiedExtractRoot -Recurse -Force
            }
        }
    }
}

if (-not (Test-Path -LiteralPath $punctuationModel -PathType Leaf)) {
    throw "Local punctuation model is missing: $punctuationModel"
}

if ($null -eq (Get-Command 'ffmpeg.exe' -ErrorAction SilentlyContinue) -or $null -eq (Get-Command 'ffprobe.exe' -ErrorAction SilentlyContinue)) {
    throw 'FFmpeg and ffprobe are required for complete-video validation and lossless segmentation'
}

Write-Host '[setup-asr] setup complete. Local punctuation is ready; large-v3 downloads on the first AI analysis.'
