@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

set "PROJECT_ROOT=%~dp0"
set "APP_DIR=%PROJECT_ROOT%Retail-Smart-Hub"
set "NODE_HOME=%ProgramFiles%\nodejs"
set "NPM_REGISTRY=https://registry.npmmirror.com"
set "ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://cdn.npmmirror.com/binaries/electron-builder-binaries/"
set "OLLAMA_DEFAULT_DIR=%LOCALAPPDATA%\Programs\Ollama"
set "OLLAMA_DEFAULT_EXE=%OLLAMA_DEFAULT_DIR%\ollama.exe"
set "OLLAMA_APP_EXE=%OLLAMA_DEFAULT_DIR%\ollama app.exe"
set "PACKAGED_EXE=%APP_DIR%\artifacts\desktop\win-unpacked\Retail Smart Hub.exe"
set "LOCAL_ELECTRON_EXE=%APP_DIR%\node_modules\electron\dist\electron.exe"
set "RAG_EMBED_PROVIDER=openai"
set "RAG_EMBED_MODEL="
set "RAG_EMBED_BASE_URL="
set "OLLAMA_CMD="
set "CHECK_ONLY=0"
set "INSTALL_ONLY=0"
set "DEV_MODE=0"
set "PACKAGED_MODE=0"
set "REBUILD_MODE=0"
set "RELEASE_MODE=0"
set "RELEASE_CI_MODE=0"
set "AUTO_SELECT_MODE=1"
set "MISSING_COUNT=0"
set "SHOW_HELP=0"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = [IO.Path]::GetFullPath('%APP_DIR%'); $item = Get-Item -LiteralPath $raw -ErrorAction SilentlyContinue; if ($null -eq $item) { Write-Output $raw; exit 0 }; $target = $item.Target; if ($target) { if ($target -is [array]) { $target = $target[0] }; Write-Output ([IO.Path]::GetFullPath($target)); } else { Write-Output $item.FullName; }"`) do set "APP_DIR=%%I"

:parse_args
if "%~1"=="" goto :parse_args_done
if /I "%~1"=="--help" (
  set "SHOW_HELP=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="-h" (
  set "SHOW_HELP=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--check" (
  set "CHECK_ONLY=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--install-only" (
  set "INSTALL_ONLY=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--dev" (
  set "DEV_MODE=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--packaged" (
  set "PACKAGED_MODE=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--rebuild" (
  set "REBUILD_MODE=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--release" (
  set "RELEASE_MODE=1"
  set "AUTO_SELECT_MODE=0"
)
if /I "%~1"=="--release-ci" (
  set "RELEASE_MODE=1"
  set "RELEASE_CI_MODE=1"
  set "AUTO_SELECT_MODE=0"
)
shift
goto :parse_args

:parse_args_done

if "%SHOW_HELP%"=="1" goto :show_help

if not exist "%APP_DIR%\package.json" (
  echo [ERROR] Project not found: %APP_DIR%
  pause
  exit /b 1
)

if exist "%NODE_HOME%\node.exe" set "PATH=%NODE_HOME%;%PATH%"

if "%AUTO_SELECT_MODE%"=="1" (
  call :AutoSelectMode
)

if "%CHECK_ONLY%"=="1" (
  echo [INFO] Running start.bat in check-only mode.
)

if "%INSTALL_ONLY%"=="1" (
  echo [INFO] Running start.bat in install-only mode.
)

echo.
echo [1/4] Checking Node.js and npm...
call :EnsureNode
if errorlevel 1 goto :fail

echo.
echo [2/4] Checking project npm dependencies...
call :EnsureProjectPackages
if errorlevel 1 goto :fail

echo.
echo [3/4] Checking local embedding runtime...
call :LoadEmbeddingSettings
if errorlevel 1 goto :fail
call :EnsureOllama
if errorlevel 1 goto :fail

echo.
if "%CHECK_ONLY%"=="1" (
  if "%MISSING_COUNT%"=="0" (
    echo [OK] Desktop requirements are already installed.
  ) else (
    echo [WARN] %MISSING_COUNT% requirement groups are missing.
  )
  exit /b 0
)

if "%INSTALL_ONLY%"=="1" (
  echo [OK] Desktop dependencies are ready.
  exit /b 0
)

if "%RELEASE_MODE%"=="1" (
  echo.
  echo [3/3] Running one-click release pipeline...
  call :RunReleasePipeline
  if errorlevel 1 goto :fail
  echo [OK] One-click release completed.
  echo [INFO] Use files under artifacts\desktop and artifacts\source for delivery.
  echo [INFO] Do not zip the whole workspace folder directly.
  if exist "%APP_DIR%\artifacts" (
    start "" "%APP_DIR%\artifacts"
  )
  exit /b 0
)

echo [4/4] Launching Retail Smart Hub Desktop...
if "%DEV_MODE%"=="1" goto :launch_dev
if "%PACKAGED_MODE%"=="1" goto :launch_packaged
goto :launch_local

:launch_packaged
echo [INFO] Launch target: packaged desktop app
if not exist "%PACKAGED_EXE%" (
  echo [ERROR] Packaged desktop app not found: %PACKAGED_EXE%
  echo [ERROR] Run start.bat --release first, or launch without --packaged.
  goto :fail
)
set "ELECTRON_RUN_AS_NODE="
start "Retail Smart Hub Desktop" "%PACKAGED_EXE%"
exit /b 0

:launch_local
echo [INFO] Launch target: local production desktop runtime
if not exist "%LOCAL_ELECTRON_EXE%" (
  echo [ERROR] Electron runtime not found: %LOCAL_ELECTRON_EXE%
  echo [ERROR] Re-run start.bat after dependencies are fully installed.
  goto :fail
)

if "%REBUILD_MODE%"=="1" (
  echo [INFO] Rebuild requested. Building latest desktop assets...
  call :RunProductionBuild
  if errorlevel 1 goto :fail
) else (
  call :CheckProductionBuildFreshness
  if errorlevel 2 goto :fail
  if "%BUILD_STALE%"=="1" (
    echo [INFO] Desktop source files changed. Rebuilding desktop assets...
    call :RunProductionBuild
    if errorlevel 1 goto :fail
  ) else (
    echo [INFO] Reusing existing desktop build.
    echo [INFO] Use start.bat --rebuild if you need a fresh build.
  )
)

set "ELECTRON_RUN_AS_NODE="
start "Retail Smart Hub Desktop" cmd /d /k "chcp 65001>nul && cd /d ""%APP_DIR%"" && set PYTHONIOENCODING=utf-8 && set PYTHONUTF8=1 && set ELECTRON_RUN_AS_NODE= && npm run desktop:start"
exit /b 0

:launch_dev
echo [INFO] Launch target: development desktop shell
set "ELECTRON_RUN_AS_NODE="
start "Retail Smart Hub Desktop" cmd /d /k "chcp 65001>nul && cd /d ""%APP_DIR%"" && set PYTHONIOENCODING=utf-8 && set PYTHONUTF8=1 && set ELECTRON_RUN_AS_NODE= && npm run desktop:dev"
exit /b 0

:CheckProductionBuildFreshness
set "BUILD_STALE=0"
if not exist "%APP_DIR%\dist\index.html" (
  set "BUILD_STALE=1"
  exit /b 0
)

if not exist "%APP_DIR%\dist-server\app.js" (
  set "BUILD_STALE=1"
  exit /b 0
)

if not exist "%APP_DIR%\dist-server\modules\ai\ai.routes.rag.js" (
  set "BUILD_STALE=1"
  exit /b 0
)

findstr /C:"/rag/documents" "%APP_DIR%\dist-server\modules\ai\ai.routes.rag.js" >nul 2>nul
if errorlevel 1 (
  echo [INFO] Existing desktop server build does not include /rag/documents route. Rebuild required.
  set "BUILD_STALE=1"
  exit /b 0
)

if not exist "%APP_DIR%\dist-server\modules\ai\ai.runtime-config.service.js" (
  set "BUILD_STALE=1"
  exit /b 0
)

findstr /C:"layeredAgentEnabled" "%APP_DIR%\dist-server\modules\ai\ai.runtime-config.service.js" >nul 2>nul
if errorlevel 1 (
  echo [INFO] Existing desktop server build does not include layeredAgentEnabled runtime config. Rebuild required.
  set "BUILD_STALE=1"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$assetDir = Join-Path ([IO.Path]::GetFullPath('%APP_DIR%')) 'dist\assets';" ^
  "if (-not (Test-Path $assetDir)) { exit 1 }" ^
  "$jsFiles = Get-ChildItem -Path $assetDir -Filter '*.js' -File -ErrorAction SilentlyContinue;" ^
  "if (-not $jsFiles) { exit 1 }" ^
  "$found = $false;" ^
  "foreach ($file in $jsFiles) { if (Select-String -Path $file.FullName -Pattern 'layeredAgentEnabled' -SimpleMatch -Quiet) { $found = $true; break } }" ^
  "if ($found) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [INFO] Existing desktop web build does not include layeredAgentEnabled UI. Rebuild required.
  set "BUILD_STALE=1"
  exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$appDir = [IO.Path]::GetFullPath('%APP_DIR%');" ^
  "$clientOutput = Join-Path $appDir 'dist\\index.html';" ^
  "$serverOutput = Join-Path $appDir 'dist-server\\app.js';" ^
  "$sourceRoots = @(" ^
  "  (Join-Path $appDir 'src')," ^
  "  (Join-Path $appDir 'server\\src')," ^
  "  (Join-Path $appDir 'electron')," ^
  "  (Join-Path $appDir 'public')" ^
  ");" ^
  "$extraFiles = @(" ^
  "  (Join-Path $appDir 'package.json')," ^
  "  (Join-Path $appDir 'vite.config.ts')," ^
  "  (Join-Path $appDir 'tsconfig.server.json')" ^
  ");" ^
  "$patterns = @('*.ts','*.tsx','*.js','*.jsx','*.cjs','*.mjs','*.json','*.css','*.html','*.svg');" ^
  "$sourceTimes = @();" ^
  "foreach ($root in $sourceRoots) { if (Test-Path $root) { foreach ($pattern in $patterns) { $sourceTimes += Get-ChildItem -Path $root -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LastWriteTimeUtc } } }" ^
  "foreach ($file in $extraFiles) { if (Test-Path $file) { $sourceTimes += (Get-Item $file).LastWriteTimeUtc } }" ^
  "if (-not $sourceTimes -or $sourceTimes.Count -eq 0) { exit 0 }" ^
  "$latestSource = ($sourceTimes | Sort-Object -Descending | Select-Object -First 1);" ^
  "$clientTime = (Get-Item $clientOutput).LastWriteTimeUtc;" ^
  "$serverTime = (Get-Item $serverOutput).LastWriteTimeUtc;" ^
  "if ($latestSource -gt $clientTime -or $latestSource -gt $serverTime) { Write-Output '[INFO] Source files are newer than the current desktop build.'; exit 1 }" ^
  "exit 0"
set "FRESHNESS_EXIT=%ERRORLEVEL%"
if "%FRESHNESS_EXIT%"=="1" (
  set "BUILD_STALE=1"
  exit /b 0
)
if not "%FRESHNESS_EXIT%"=="0" (
  echo [ERROR] Failed to check desktop build freshness.
  exit /b 2
)
exit /b 0

:EnsureNode
where node >nul 2>nul
if not errorlevel 1 (
  where npm >nul 2>nul
  if not errorlevel 1 (
    echo [OK] Node.js and npm already installed.
    exit /b 0
  )
)

where winget >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is missing and winget is not available.
  echo [ERROR] Please install Node.js LTS manually, then re-run start.bat.
  exit /b 1
)

if "%CHECK_ONLY%"=="1" (
  echo [CHECK] Node.js/npm missing. Would install via winget: OpenJS.NodeJS.LTS
  set /a MISSING_COUNT+=1
  exit /b 0
)

echo [INFO] Installing Node.js LTS via winget...
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements --disable-interactivity
if errorlevel 1 (
  echo [ERROR] Node.js installation failed.
  exit /b 1
)

if exist "%NODE_HOME%\node.exe" set "PATH=%NODE_HOME%;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js still not found after installation.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm still not found after Node.js installation.
  exit /b 1
)

echo [OK] Node.js installed.
exit /b 0

:EnsureProjectPackages
pushd "%APP_DIR%" >nul

call :CheckProjectInstallState
if errorlevel 1 (
  popd >nul
  exit /b 1
)
if "!LOCK_STATE_STALE!"=="0" if "!MISSING_PACKAGE_LIST!"=="" (
  echo [OK] Project npm dependencies already installed.
  popd >nul
  exit /b 0
)

if "%CHECK_ONLY%"=="1" (
  echo [CHECK] Project npm dependencies missing or incomplete. Would run npm install.
  if "!LOCK_STATE_STALE!"=="1" (
    echo [CHECK] package-lock.json is stale for the current package.json dependencies. start.bat will rebuild it automatically.
  )
  if not "!MISSING_PACKAGE_LIST!"=="" (
    echo [CHECK] Missing packages: !MISSING_PACKAGE_LIST!
  )
  set /a MISSING_COUNT+=1
  popd >nul
  exit /b 0
)

if "!LOCK_STATE_STALE!"=="1" (
  echo [WARN] package-lock.json does not match the current package.json dependencies.
)

if not "!MISSING_PACKAGE_LIST!"=="" (
  echo [WARN] Missing npm packages detected: !MISSING_PACKAGE_LIST!
)

echo [INFO] Installing project npm dependencies from %NPM_REGISTRY%...
echo [INFO] Electron binaries mirror: %ELECTRON_MIRROR%
echo [INFO] Electron Builder binaries mirror: %ELECTRON_BUILDER_BINARIES_MIRROR%
set "ELECTRON_BUILDER_BINARIES_MIRROR=%ELECTRON_BUILDER_BINARIES_MIRROR%"
call npm.cmd install --registry=%NPM_REGISTRY%
if errorlevel 1 (
  echo [WARN] npm install failed on the current dependency tree.
  echo [INFO] Attempting one clean reinstall by removing node_modules and package-lock.json...
  call :CleanProjectInstallArtifacts
  if errorlevel 1 (
    popd >nul
    exit /b 1
  )
  echo [INFO] Retrying npm install with Electron mirrors enabled...
  call npm.cmd install --registry=%NPM_REGISTRY%
  if errorlevel 1 (
    echo [ERROR] npm install failed after clean reinstall.
    echo [ERROR] If the failure mentions electron download or TLS, your network is still interrupting the Electron binary fetch.
    echo [ERROR] The script is already using the mainland mirrors above. Please close VPN/proxy tools and try again.
    popd >nul
    exit /b 1
  )
)

call :CheckProjectInstallState
if errorlevel 1 (
  popd >nul
  exit /b 1
)
if "!LOCK_STATE_STALE!"=="1" (
  echo [ERROR] package-lock.json is still stale after npm install.
  popd >nul
  exit /b 1
)

if not "!MISSING_PACKAGE_LIST!"=="" (
  echo [ERROR] Some packages are still missing after npm install: !MISSING_PACKAGE_LIST!
  popd >nul
  exit /b 1
)

echo [OK] Project npm dependencies installed.
popd >nul
exit /b 0

:CheckProjectInstallState
set "LOCK_STATE_STALE=0"
set "MISSING_PACKAGE_LIST="
set "INSTALL_STATE_TMP=%TEMP%\retail_smart_hub_install_state.txt"

if not exist "package-lock.json" (
  set "LOCK_STATE_STALE=1"
)

call node "%APP_DIR%\scripts\check-install-state.cjs" > "%INSTALL_STATE_TMP%"
if errorlevel 1 (
  echo [ERROR] Failed to inspect project dependency state.
  del /f /q "%INSTALL_STATE_TMP%" >nul 2>nul
  exit /b 1
)

for /f "usebackq delims=" %%i in ("%INSTALL_STATE_TMP%") do (
  if "%%i"=="__LOCK_STALE__" set "LOCK_STATE_STALE=1"
  echo %%i | findstr /b "__MISSING__ " >nul
  if not errorlevel 1 set "MISSING_PACKAGE_LIST=%%i"
)

del /f /q "%INSTALL_STATE_TMP%" >nul 2>nul

if defined MISSING_PACKAGE_LIST (
  set "MISSING_PACKAGE_LIST=!MISSING_PACKAGE_LIST:__MISSING__ =!"
)

exit /b 0

:CleanProjectInstallArtifacts
if exist "node_modules" (
  echo [INFO] Removing node_modules...
  rmdir /s /q "node_modules"
  if exist "node_modules" (
    echo [ERROR] Failed to remove node_modules. Please close any process using this folder and re-run start.bat.
    exit /b 1
  )
)

if exist "package-lock.json" (
  echo [INFO] Removing stale package-lock.json...
  del /f /q "package-lock.json" >nul 2>nul
  if exist "package-lock.json" (
    echo [ERROR] Failed to remove package-lock.json. Please check file permissions and re-run start.bat.
    exit /b 1
  )
)

exit /b 0

:AutoSelectMode
if /I "%RETAIL_HUB_MODE%"=="release" (
  set "RELEASE_MODE=1"
  echo [INFO] Auto mode selected: RETAIL_HUB_MODE=release. Switching to one-click release mode.
  exit /b 0
)

if /I "%RETAIL_HUB_MODE%"=="release-ci" (
  set "RELEASE_MODE=1"
  set "RELEASE_CI_MODE=1"
  echo [INFO] Auto mode selected: RETAIL_HUB_MODE=release-ci. Switching to one-click release CI mode.
  exit /b 0
)

if /I "%RETAIL_HUB_MODE%"=="dev" (
  set "DEV_MODE=1"
  echo [INFO] Auto mode selected: RETAIL_HUB_MODE=dev. Switching to desktop development mode.
  exit /b 0
)

if /I "%RETAIL_HUB_MODE%"=="packaged" (
  set "PACKAGED_MODE=1"
  echo [INFO] Auto mode selected: RETAIL_HUB_MODE=packaged. Switching to packaged desktop mode.
  exit /b 0
)

if /I "%CI%"=="true" (
  set "RELEASE_MODE=1"
  set "RELEASE_CI_MODE=1"
  echo [INFO] Auto mode selected: CI environment detected. Switching to one-click release CI mode.
  exit /b 0
)

if /I "%GITHUB_ACTIONS%"=="true" (
  set "RELEASE_MODE=1"
  set "RELEASE_CI_MODE=1"
  echo [INFO] Auto mode selected: GitHub Actions detected. Switching to one-click release CI mode.
  exit /b 0
)

echo [INFO] Auto mode selected: local environment detected. Switching to desktop start mode.
exit /b 0

:show_help
echo Retail Smart Hub one-script launcher
echo.
echo Usage:
echo   start.bat                     ^(auto mode: local=start, CI=release^)
echo   start.bat --release           ^(local one-click release^)
echo   start.bat --release-ci        ^(CI release pipeline^)
echo   start.bat --dev               ^(desktop dev shell^)
echo   start.bat --packaged          ^(run packaged app^)
echo   start.bat --rebuild           ^(force rebuild before local start^)
echo   start.bat --install-only      ^(only check/install dependencies^)
echo   start.bat --check             ^(check only, no install, no launch^)
echo.
echo Optional env override:
echo   set RETAIL_HUB_MODE=release      ^(or: release-ci, dev, packaged^)
echo.
echo Notes:
echo   Start means running the app on this machine for development/demo.
echo   Release means building distributable desktop artifacts for other machines.
exit /b 0

:RunProductionBuild
pushd "%APP_DIR%" >nul
call npm.cmd run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd >nul
if not "%BUILD_EXIT%"=="0" (
  echo [ERROR] Production build failed.
  exit /b 1
)
exit /b 0

:RunReleasePipeline
pushd "%APP_DIR%" >nul
if "%RELEASE_CI_MODE%"=="1" (
  call npm.cmd run release:ci
) else (
  call npm.cmd run release:desktop
)
set "RELEASE_EXIT=%ERRORLEVEL%"
popd >nul
if not "%RELEASE_EXIT%"=="0" (
  echo [ERROR] Release pipeline failed.
  exit /b 1
)
exit /b 0

:LoadEmbeddingSettings
if not exist "%APP_DIR%\.env" (
  if /I "%RAG_EMBED_PROVIDER%"=="ollama" (
    if "%RAG_EMBED_MODEL%"=="" set "RAG_EMBED_MODEL=nomic-embed-text"
  )
  exit /b 0
)

for /f "usebackq tokens=1,* delims==" %%A in ("%APP_DIR%\.env") do (
  if /I "%%A"=="RAG_EMBEDDING_PROVIDER" set "RAG_EMBED_PROVIDER=%%B"
  if /I "%%A"=="RAG_EMBEDDING_MODEL" set "RAG_EMBED_MODEL=%%B"
  if /I "%%A"=="RAG_EMBEDDING_BASE_URL" set "RAG_EMBED_BASE_URL=%%B"
)

if not defined RAG_EMBED_PROVIDER set "RAG_EMBED_PROVIDER=openai"
if /I "%RAG_EMBED_PROVIDER%"=="ollama" (
  if "%RAG_EMBED_MODEL%"=="" set "RAG_EMBED_MODEL=nomic-embed-text"
)
exit /b 0

:ResolveOllamaCommand
set "OLLAMA_CMD="
where ollama >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('where ollama') do (
    set "OLLAMA_CMD=%%i"
    goto :ResolveOllamaCommandDone
  )
)

if not defined OLLAMA_CMD if exist "%OLLAMA_DEFAULT_EXE%" (
  set "OLLAMA_CMD=%OLLAMA_DEFAULT_EXE%"
)

if defined OLLAMA_CMD if exist "%OLLAMA_DEFAULT_DIR%" (
  set "PATH=%OLLAMA_DEFAULT_DIR%;%PATH%"
)

:ResolveOllamaCommandDone
exit /b 0

:EnsureOllama
if /I not "%RAG_EMBED_PROVIDER%"=="ollama" (
  echo [OK] Embedding provider is %RAG_EMBED_PROVIDER%. Ollama check skipped.
  exit /b 0
)

if "%RAG_EMBED_MODEL%"=="" set "RAG_EMBED_MODEL=nomic-embed-text"
call :ResolveOllamaCommand

if not defined OLLAMA_CMD (
  if "%CHECK_ONLY%"=="1" (
    echo [CHECK] Ollama missing. Would install via winget: Ollama.Ollama
    set /a MISSING_COUNT+=1
    exit /b 0
  )

  where winget >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Ollama is missing and winget is unavailable.
    echo [ERROR] Please install Ollama manually, then rerun start.bat.
    exit /b 1
  )

  echo [INFO] Installing Ollama via winget...
  winget install --id Ollama.Ollama -e --accept-package-agreements --accept-source-agreements --disable-interactivity
  if errorlevel 1 (
    echo [ERROR] Ollama installation failed.
    exit /b 1
  )

  call :ResolveOllamaCommand
  if not defined OLLAMA_CMD (
    echo [ERROR] Ollama still not found after installation.
    exit /b 1
  )
)

set "OLLAMA_READY=0"
"%OLLAMA_CMD%" list >nul 2>nul
if not errorlevel 1 set "OLLAMA_READY=1"

if "%OLLAMA_READY%"=="0" (
  if exist "%OLLAMA_APP_EXE%" (
    echo [INFO] Starting Ollama app...
    start "" /min "%OLLAMA_APP_EXE%"
  ) else (
    echo [INFO] Starting Ollama daemon...
    start "" /min "%OLLAMA_CMD%" serve
  )

  for /l %%r in (1,1,20) do (
    timeout /t 2 /nobreak >nul
    "%OLLAMA_CMD%" list >nul 2>nul
    if not errorlevel 1 (
      set "OLLAMA_READY=1"
      goto :EnsureOllamaReady
    )
  )
)

:EnsureOllamaReady
if "%OLLAMA_READY%"=="0" (
  echo [ERROR] Ollama service is not reachable at %RAG_EMBED_BASE_URL%.
  echo [ERROR] Please start Ollama manually and re-run start.bat.
  exit /b 1
)

if "%CHECK_ONLY%"=="1" (
  "%OLLAMA_CMD%" list 2>nul | findstr /I /C:"%RAG_EMBED_MODEL%" >nul
  if errorlevel 1 (
    echo [CHECK] Ollama model missing: %RAG_EMBED_MODEL%. Would run: ollama pull %RAG_EMBED_MODEL%
    set /a MISSING_COUNT+=1
  ) else (
    echo [OK] Ollama model already available: %RAG_EMBED_MODEL%
  )
  exit /b 0
)

"%OLLAMA_CMD%" list 2>nul | findstr /I /C:"%RAG_EMBED_MODEL%" >nul
if errorlevel 1 (
  echo [INFO] Pulling Ollama embedding model: %RAG_EMBED_MODEL%
  "%OLLAMA_CMD%" pull "%RAG_EMBED_MODEL%"
  if errorlevel 1 (
    echo [ERROR] Failed to pull Ollama model: %RAG_EMBED_MODEL%
    exit /b 1
  )
) else (
  echo [OK] Ollama model already available: %RAG_EMBED_MODEL%
)

echo [OK] Local embedding runtime is ready. Provider=%RAG_EMBED_PROVIDER%, Model=%RAG_EMBED_MODEL%
exit /b 0

:fail
echo.
echo [ERROR] Start sequence did not complete.
pause
exit /b 1
