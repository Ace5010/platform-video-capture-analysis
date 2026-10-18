param([Parameter(Mandatory=$true)][string]$JavaPath)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskConfig = Join-Path $taskRoot 'android\keystore.properties'
if (Test-Path -LiteralPath $taskConfig) { throw '本机已有签名配置，不覆盖；后续版本必须沿用原签名。' }
$taskKeyDirectory = Join-Path $env:LOCALAPPDATA 'ContentWorkbench\signing'
$taskKeyFile = Join-Path $taskKeyDirectory 'content-workbench.jks'
if (Test-Path -LiteralPath $taskKeyFile) { throw '已存在签名密钥，请恢复原配置，不生成替代密钥。' }
New-Item -ItemType Directory -Path $taskKeyDirectory -Force | Out-Null
$taskRandom = New-Object byte[] 32
$taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$taskRng.GetBytes($taskRandom); $taskRng.Dispose()
$taskPassword = [Convert]::ToBase64String($taskRandom)
$env:CONTENT_WORKBENCH_SIGNING_PASSWORD = $taskPassword
try {
    & (Join-Path $JavaPath 'bin\keytool.exe') '-genkeypair' '-keystore' $taskKeyFile '-storetype' 'JKS' '-alias' 'content-workbench' '-keyalg' 'RSA' '-keysize' '3072' '-validity' '10000' '-dname' 'CN=Content Workbench' '-storepass:env' 'CONTENT_WORKBENCH_SIGNING_PASSWORD' '-keypass:env' 'CONTENT_WORKBENCH_SIGNING_PASSWORD'
    if ($LASTEXITCODE -ne 0) { throw '生成签名密钥失败。' }
    $taskConfigText = "storeFile=$($taskKeyFile.Replace('\','/'))`nstorePassword=$taskPassword`nkeyAlias=content-workbench`nkeyPassword=$taskPassword`n"
    [IO.File]::WriteAllText($taskConfig, $taskConfigText, (New-Object Text.UTF8Encoding $false))
    Write-Output '已建立本项目独立签名。密钥在用户本机目录，配置已被 Git 排除。请单独备份签名及配置。'
} finally { Remove-Item Env:CONTENT_WORKBENCH_SIGNING_PASSWORD -ErrorAction SilentlyContinue }
