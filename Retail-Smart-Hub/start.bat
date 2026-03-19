@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"

cd /d "%~dp0"

if /I "%~1"=="--help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="--release" goto :release
if /I "%~1"=="--dev" goto :dev
if /I "%~1"=="--check" goto :check

echo [mode] local desktop start
call :ensure_deps
if errorlevel 1 goto :fail

call npm.cmd run build
if errorlevel 1 goto :fail

call npm.cmd run desktop:start
if errorlevel 1 goto :fail
exit /b 0

:release
echo [mode] release build
call :ensure_deps
if errorlevel 1 goto :fail

call npm.cmd run release:desktop
if errorlevel 1 goto :fail
exit /b 0

:dev
echo [mode] desktop dev
call :ensure_deps
if errorlevel 1 goto :fail

call npm.cmd run desktop:dev
if errorlevel 1 goto :fail
exit /b 0

:check
echo [mode] dependency check
call :ensure_deps
exit /b %ERRORLEVEL%

:ensure_deps
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js first.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm not found. Please install npm first.
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] node_modules not found, running npm ci...
  call npm.cmd ci
  if errorlevel 1 (
    echo [ERROR] npm ci failed.
    exit /b 1
  )
)

call node scripts\ensure-platform-install.mjs
if errorlevel 1 (
  echo [WARN] Current dependencies are not runnable on this platform.
  echo [INFO] Running npm run install:clean to repair...
  call npm.cmd run install:clean
  if errorlevel 1 (
    echo [ERROR] install:clean failed.
    exit /b 1
  )
  call node scripts\ensure-platform-install.mjs
  if errorlevel 1 (
    echo [ERROR] Dependencies are still not runnable after install:clean.
    echo [ERROR] Please run npm run install:clean manually and check your npm logs.
    exit /b 1
  )
)

call :ensure_python_agent
if errorlevel 1 (
  exit /b 1
)

echo [OK] dependencies runnable on current platform.
exit /b 0

:ensure_python_agent
set "AI_RUNTIME_MODE=%AI_RUNTIME%"
if "%AI_RUNTIME_MODE%"=="" (
  if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
      if /I "%%A"=="AI_RUNTIME" set "AI_RUNTIME_MODE=%%B"
    )
  )
)

if "%AI_RUNTIME_MODE%"=="" set "AI_RUNTIME_MODE=python"
if /I "%AI_RUNTIME_MODE%"=="ts" (
  echo [INFO] AI_RUNTIME=ts, skip python-agent dependency checks.
  exit /b 0
)

set "PYTHON_CMD=python"
where %PYTHON_CMD% >nul 2>nul
if errorlevel 1 (
  where py >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] AI_RUNTIME=%AI_RUNTIME_MODE% requires Python, but python/py command is not available.
    exit /b 1
  )
  set "PYTHON_CMD=py -3"
)

echo [INFO] Checking python-agent runtime dependencies...
call %PYTHON_CMD% -c "import fastapi,uvicorn,httpx,pydantic" >nul 2>nul
if errorlevel 1 (
  echo [WARN] python-agent dependencies are missing. Installing from python-agent\\requirements.txt ...
  call %PYTHON_CMD% -m pip install -r python-agent\requirements.txt
  if errorlevel 1 (
    echo [ERROR] Failed to install python-agent dependencies.
    exit /b 1
  )
)

echo [OK] python-agent dependencies are ready.
exit /b 0

:help
echo Retail Smart Hub local launcher
echo.
echo Usage:
echo   start.bat            ^(build + start desktop runtime^)
echo   start.bat --dev      ^(desktop dev mode^)
echo   start.bat --release  ^(release pipeline^)
echo   start.bat --check    ^(dependency check only^)
echo   start.bat --help
exit /b 0

:fail
echo.
echo [ERROR] start failed.
exit /b 1
