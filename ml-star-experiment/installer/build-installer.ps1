<#
.SYNOPSIS
  Builds the Hamilton STAR Digital Twin NSIS installer + portable .zip via electron-builder.

.DESCRIPTION
  electron-builder downloads its own bundled NSIS — no system install needed.
  Steps:
    1. Build hamilton-star-twin and hamilton-star-mcp. MCP emits a single
       bundled dist\index.js via esbuild — no runtime node_modules needed.
    2. Stage MCP (bundled dist + package.json)  → installer\stage\mcp\.
    2b. Download + stage Node.js runtime      → installer\stage\runtime\node.exe
        (cached under installer\cache\).
    2c. Stage README.portable.md              → installer\stage\docs\README.md.
    3. Write launcher batch files             → installer\stage\launchers\.
    4. Run electron-builder in hamilton-star-twin; it bundles the staged folders
       via extraResources / extraFiles and emits both
         HamiltonStarTwin-Setup-<version>-x64.exe   (NSIS installer)
         HamiltonStarTwin-<version>-x64.zip         (portable — unzip anywhere)
       into installer\dist-installer\.
  Both outputs are self-contained: no system Node.js install required — the
  bundled runtime at resources\runtime\node.exe drives MCP + headless editor.

.PARAMETER SkipBuild
  Skip `npm install` + `npm run build` for both projects (reuse existing dist/).

.PARAMETER KeepStage
  Leave installer\stage\ in place after a successful build (for debugging).

.EXAMPLE
  .\build-installer.ps1
  .\build-installer.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$KeepStage
)

$ErrorActionPreference = 'Stop'

$InstallerDir = $PSScriptRoot
$RepoRoot     = Split-Path $InstallerDir -Parent
$TwinDir      = Join-Path $RepoRoot     'hamilton-star-twin'
$McpDir       = Join-Path $RepoRoot     'hamilton-star-mcp'
$StageDir     = Join-Path $InstallerDir 'stage'
$McpStage     = Join-Path $StageDir     'mcp'
$LauncherStage= Join-Path $StageDir     'launchers'
$RuntimeStage = Join-Path $StageDir     'runtime'
$DocsStage    = Join-Path $StageDir     'docs'

# Bundled Node.js runtime — change here to bump. Cached zip lives under installer\cache\.
$NodeVersion  = '22.11.0'
$NodeCacheDir = Join-Path $InstallerDir 'cache'

function Write-Step ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   ($m) { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "    $m" -ForegroundColor Yellow }

function Invoke-InDir {
  param([string]$Dir, [scriptblock]$Block)
  Push-Location $Dir
  try { & $Block } finally { Pop-Location }
}

function Invoke-Npm {
  param([string]$Dir, [string[]]$NpmArgs)
  Invoke-InDir $Dir {
    & npm @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') failed in $Dir" }
  }
}

Write-Host ''
Write-Host 'Hamilton STAR Digital Twin — Installer Builder' -ForegroundColor Magenta
Write-Host ''

# Prereqs
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not on PATH' }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { throw 'npm not on PATH'  }
Write-Ok "node $((& node --version).Trim())"
Write-Ok "npm  $((& npm  --version).Trim())"

# --- 1. Build twin + mcp -----------------------------------------------------
if (-not $SkipBuild) {
  Write-Step 'Building hamilton-star-twin'
  Invoke-Npm $TwinDir @('install')
  Invoke-Npm $TwinDir @('run','build')

  Write-Step 'Building hamilton-star-mcp'
  Invoke-Npm $McpDir  @('install')
  Invoke-Npm $McpDir  @('run','build')
} else {
  Write-Warn2 'skipping npm install / build'
}

# --- 2. Stage MCP (bundled single-file dist) --------------------------------
# MCP is esbuild-bundled into dist\index.js, so no node_modules need to ship.
# This sidesteps an electron-builder quirk where node_modules placed inside
# extraResources were silently stripped from win-unpacked output, breaking
# `require('@modelcontextprotocol/sdk/server/index.js')` at runtime.
Write-Step 'Staging MCP server'
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
$null = New-Item -ItemType Directory -Force -Path $McpStage, $LauncherStage, $RuntimeStage, $DocsStage

Copy-Item -Recurse -Force (Join-Path $McpDir 'dist')        $McpStage
Copy-Item         -Force (Join-Path $McpDir 'package.json') $McpStage

$bundlePath = Join-Path $McpStage 'dist\index.js'
if (-not (Test-Path $bundlePath)) { throw "MCP bundle missing: $bundlePath. Did `npm run build` fail?" }
$bundleText = Get-Content -Raw $bundlePath
if ($bundleText -match 'require\s*\(\s*["'']@modelcontextprotocol/sdk/') {
  throw 'MCP bundle still contains bare require("@modelcontextprotocol/..."). Rebuild via `npm run build:bundle` in hamilton-star-mcp.'
}
$mcpBytes = (Get-ChildItem $McpStage -Recurse -File | Measure-Object Length -Sum).Sum
Write-Ok  ("mcp staged ({0:N1} MB, bundled)" -f ($mcpBytes / 1MB))

# --- 2b. Bundle Node.js runtime ---------------------------------------------
Write-Step "Staging Node.js $NodeVersion runtime"
$nodeZipUrl   = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$nodeZipPath  = Join-Path $NodeCacheDir "node-v$NodeVersion-win-x64.zip"
$nodeExtract  = Join-Path $env:TEMP "node-extract-$NodeVersion-$PID"
$null = New-Item -ItemType Directory -Force -Path $NodeCacheDir

if (-not (Test-Path $nodeZipPath)) {
  Write-Ok "downloading $nodeZipUrl"
  try {
    Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeZipPath -UseBasicParsing
  } catch {
    throw "Failed to download Node.js $NodeVersion from $nodeZipUrl : $($_.Exception.Message)"
  }
} else {
  Write-Ok "using cached $nodeZipPath"
}
if (Test-Path $nodeExtract) { Remove-Item -Recurse -Force $nodeExtract }
Expand-Archive -Path $nodeZipPath -DestinationPath $nodeExtract -Force
$nodeExe = Get-ChildItem -Path $nodeExtract -Filter 'node.exe' -Recurse | Select-Object -First 1
if (-not $nodeExe) { throw "node.exe not found inside $nodeZipPath" }
Copy-Item -Force $nodeExe.FullName (Join-Path $RuntimeStage 'node.exe')
Remove-Item -Recurse -Force $nodeExtract
Write-Ok ("node.exe staged ({0:N1} MB)" -f ((Get-Item (Join-Path $RuntimeStage 'node.exe')).Length / 1MB))

# --- 2c. Stage README -------------------------------------------------------
Write-Step 'Staging README'
$readmeSrc = Join-Path $InstallerDir 'README.portable.md'
if (-not (Test-Path $readmeSrc)) { throw "README template missing: $readmeSrc" }
Copy-Item -Force $readmeSrc (Join-Path $DocsStage 'README.md')
Write-Ok 'README.md staged'

# --- 3. Launcher batch files -------------------------------------------------
Write-Step 'Writing launchers'
# Installed / unzipped layout (electron-builder, asar:false):
#   <INSTDIR>\<ProductName>.exe
#   <INSTDIR>\README.md                   shipped from installer\README.portable.md
#   <INSTDIR>\resources\app\              twin source (dist + package.json)
#   <INSTDIR>\resources\mcp\              MCP server + node_modules
#   <INSTDIR>\resources\launchers\        these .bat files
#   <INSTDIR>\resources\runtime\node.exe  bundled Node.js runtime

$editorBat = @'
@echo off
REM Standalone Method Editor — starts the headless HTTP server and opens
REM http://localhost:%PORT%/protocol in the default browser.
setlocal
if "%PORT%"=="" set PORT=8222
set TWIN_APP=%~dp0..\app
if not exist "%TWIN_APP%\dist\headless\server.js" (
  echo [run-editor] Twin payload not found at "%TWIN_APP%".
  pause & exit /b 1
)
REM Prefer bundled runtime; fall back to system Node on PATH.
set NODE_EXE=%~dp0..\runtime\node.exe
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [run-editor] Bundled node.exe missing and no system Node.js 18+ on PATH.
    echo             Re-extract the zip or install Node.js from https://nodejs.org/.
    pause & exit /b 1
  )
  set NODE_EXE=node
)
start "" http://localhost:%PORT%/protocol
"%NODE_EXE%" "%TWIN_APP%\dist\headless\server.js" --port %PORT%
'@
Set-Content -Path (Join-Path $LauncherStage 'run-editor.bat') -Value $editorBat -Encoding ASCII

$mcpBat = @'
@echo off
REM Hamilton STAR MCP Bridge (stdio → HTTP).
REM   run-mcp.bat                                 auto-discover on localhost:8222-8226
REM   set HAMILTON_TWIN_URL=http://host:8222      pin a specific twin
REM Works with any stdio MCP client (Claude Desktop, Claude Code, LM Studio, Codex).
REM The twin must be running (Electron app or run-editor.bat) for tool calls to succeed.
setlocal
set MCP_DIR=%~dp0..\mcp
REM Prefer bundled runtime; fall back to system Node on PATH.
set NODE_EXE=%~dp0..\runtime\node.exe
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo [run-mcp] Bundled node.exe missing and no system Node.js 18+ on PATH.
    echo           Re-extract the zip or install Node.js from https://nodejs.org/.
    exit /b 1
  )
  set NODE_EXE=node
)
"%NODE_EXE%" "%MCP_DIR%\dist\index.js" %*
'@
Set-Content -Path (Join-Path $LauncherStage 'run-mcp.bat') -Value $mcpBat -Encoding ASCII
Write-Ok 'launchers written'

# --- 4. electron-builder -----------------------------------------------------
Write-Step 'Running electron-builder (NSIS + ZIP, win x64)'
Invoke-InDir $TwinDir {
  & npx --yes electron-builder --win --x64 --publish never
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
}

$distDir = Join-Path $InstallerDir 'dist-installer'

# Belt-and-braces: verify the MCP bundle actually landed in the unpacked output.
# If electron-builder ever starts stripping extraResources again this catches it.
$unpackedMcp = Join-Path $distDir 'win-unpacked\resources\mcp\dist\index.js'
if (-not (Test-Path $unpackedMcp)) {
  throw "MCP bundle missing from electron-builder output: $unpackedMcp"
}

$setup = Get-ChildItem $distDir -Filter 'HamiltonStarTwin-Setup-*.exe' `
          -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'electron-builder did not produce a setup .exe' }
Write-Ok "setup:    $($setup.FullName)"
Write-Ok ("  size:   {0:N1} MB" -f ($setup.Length / 1MB))

$zip = Get-ChildItem $distDir -Filter 'HamiltonStarTwin-*-x64.zip' `
        -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { throw 'electron-builder did not produce a portable .zip' }
Write-Ok "portable: $($zip.FullName)"
Write-Ok ("  size:   {0:N1} MB" -f ($zip.Length / 1MB))

# --- 5. Cleanup --------------------------------------------------------------
if (-not $KeepStage) {
  Remove-Item -Recurse -Force $StageDir
  Write-Ok 'stage cleaned'
}

Write-Host ''
Write-Host "Installer ready: $($setup.FullName)" -ForegroundColor Green
Write-Host "Portable ready:  $($zip.FullName)"   -ForegroundColor Green
Write-Host ''
