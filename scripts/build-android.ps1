param(
    [ValidateSet('Debug','Release')][string]$Variant = 'Release',
    [switch]$Validate,
    [switch]$BuildInstrumentation,
    [string]$ToolsPath,
    [string]$JavaPath,
    [string]$SdkPath,
    [string]$GradlePath
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $ToolsPath) {
    $taskSiblingRoot = Split-Path -Parent $taskRoot
    $ToolsPath = @('Pocket', '日程系统') | ForEach-Object { Join-Path $taskSiblingRoot "$_\.runtime\android-tools" } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $ToolsPath) { throw '请通过 -ToolsPath 指定已有 Android 工具目录。' }
}
if (-not $JavaPath) { $JavaPath = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { (Get-ChildItem -LiteralPath (Join-Path $ToolsPath 'jdk') -Directory | Select-Object -First 1).FullName } }
if (-not $SdkPath) { $SdkPath = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $ToolsPath 'sdk' } }
if (-not $GradlePath) { $GradlePath = Join-Path $ToolsPath 'gradle\gradle-8.11.1\bin\gradle.bat' }
if (-not (Test-Path -LiteralPath (Join-Path $JavaPath 'bin\java.exe'))) { throw '请传入可用 JDK 17+ 路径。' }
if (-not (Test-Path -LiteralPath (Join-Path $SdkPath 'platforms\android-35\android.jar'))) { throw '请传入包含 SDK 35 的 Android SDK 路径。' }
if (-not (Test-Path -LiteralPath $GradlePath)) { throw '请传入 Gradle 8.11.1 路径。' }
$taskPrevious = @{}
foreach ($taskVariable in @('JAVA_HOME','ANDROID_HOME','GRADLE_USER_HOME','JAVA_TOOL_OPTIONS')) { $taskPrevious[$taskVariable] = [Environment]::GetEnvironmentVariable($taskVariable, 'Process') }
Push-Location -LiteralPath $taskRoot
try {
    $env:JAVA_HOME = $JavaPath
    $env:ANDROID_HOME = $SdkPath
    $env:GRADLE_USER_HOME = Join-Path $ToolsPath 'gradle-cache'
    $taskSocketFallback = Join-Path $env:LOCALAPPDATA ('ContentWorkbenchBuild\no-socket-' + [guid]::NewGuid().ToString('N'))
    $env:JAVA_TOOL_OPTIONS = (($taskPrevious['JAVA_TOOL_OPTIONS'], ('-Djdk.net.unixdomain.tmpdir="' + $taskSocketFallback + '"')) -join ' ').Trim()
    $taskTargets = @(('assemble' + $Variant), '-Dorg.gradle.jvmargs=-Xmx2048m -Dfile.encoding=COMPAT')
    if ($Validate) { $taskTargets += ':app:testDebugUnitTest', ':app:lintDebug' }
    if ($BuildInstrumentation) { $taskTargets += @((':app:assemble' + $Variant + 'AndroidTest'), ('-PandroidTestBuildType=' + $Variant.ToLowerInvariant())) }
    & $GradlePath '-p' (Join-Path $taskRoot 'android') @taskTargets '--no-daemon' '--console=plain'
    if ($LASTEXITCODE -ne 0) { throw 'Android 构建或检查失败。' }
    $taskOutput = Join-Path $taskRoot 'outputs\android'
    New-Item -ItemType Directory -Path $taskOutput -Force | Out-Null
    $taskLower = $Variant.ToLowerInvariant()
    $taskApk = Join-Path $taskRoot "android\app\build\outputs\apk\$taskLower\app-$taskLower.apk"
    if (-not (Test-Path -LiteralPath $taskApk)) { throw '没有生成已签名 APK。' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $taskArchive = [IO.Compression.ZipFile]::OpenRead($taskApk)
    try {
        if (-not $taskArchive.GetEntry('AndroidManifest.xml') -or -not $taskArchive.GetEntry('classes.dex')) { throw 'APK 缺少原生入口。' }
        if ($taskArchive.Entries | Where-Object { $_.FullName -like 'assets/web/*' -or $_.FullName -eq 'assets/fixture.json' }) {
            throw '正式 APK 不应内置旧网页或测试数据。'
        }
    } finally { $taskArchive.Dispose() }
    $taskDeliverable = Join-Path $taskOutput "content-workbench-$taskLower.apk"
    Copy-Item -LiteralPath $taskApk -Destination $taskDeliverable -Force
    Get-FileHash -LiteralPath $taskDeliverable -Algorithm SHA256 | Select-Object Path, Hash
}
finally {
    Pop-Location
    foreach ($taskVariable in $taskPrevious.Keys) { [Environment]::SetEnvironmentVariable($taskVariable, $taskPrevious[$taskVariable], 'Process') }
}
