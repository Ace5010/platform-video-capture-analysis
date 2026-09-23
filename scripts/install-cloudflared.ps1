[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$toolDirectory = Join-Path $projectRoot 'data\tools'
$destination = Join-Path $toolDirectory 'cloudflared.exe'
if (Test-Path -LiteralPath $destination) {
    & $destination --version
    exit $LASTEXITCODE
}

# Download only the official vendor release and verify the published SHA-256.
$release = Invoke-RestMethod 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -TimeoutSec 30
$asset = $release.assets | Where-Object name -eq 'cloudflared-windows-amd64.exe'
if (-not $asset -or $asset.browser_download_url -notlike 'https://github.com/cloudflare/cloudflared/releases/download/*/cloudflared-windows-amd64.exe' -or $asset.digest -notmatch '^sha256:[a-f0-9]{64}$') {
    throw 'Official cloudflared release metadata or checksum is unavailable.'
}
New-Item -ItemType Directory -Path $toolDirectory -Force | Out-Null
$downloadPath = Join-Path $toolDirectory ('cloudflared-' + [guid]::NewGuid().ToString('N') + '.download')
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -UseBasicParsing -TimeoutSec 180
    $hash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $asset.digest.Substring(7)) { throw 'cloudflared checksum verification failed.' }
    Move-Item -LiteralPath $downloadPath -Destination $destination
    & $destination --version
    if ($LASTEXITCODE -ne 0) { throw 'cloudflared could not start.' }
} finally {
    if (Test-Path -LiteralPath $downloadPath) { Remove-Item -LiteralPath $downloadPath }
}
