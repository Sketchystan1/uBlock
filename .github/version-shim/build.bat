@echo off
rem Build the chrome-netjoin-shim version.dll proxy for one or more architectures.
rem
rem   build.bat [x64|x86|arm64|all]      (default: all)
rem
rem No dependencies: nothing is downloaded, and the DLL links only against the
rem Windows SDK. Leaves build\<arch>\version.dll with the intermediates removed.
rem
rem version.dll is loaded INTO the browser, so it must match that browser exe's
rem architecture: copy the DLL from build\<arch>\ next to the matching exe.
rem
rem An architecture whose MSVC target toolchain is not installed is skipped.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "WHAT=%~1"
if not defined WHAT set "WHAT=all"

rem ---- Locate Visual Studio -------------------------------------------------
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
  echo Visual Studio Installer not found. Install Visual Studio with the
  echo "Desktop development with C++" workload.
  exit /b 1
)
set "VSDIR="
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%I"
if not defined VSDIR ( echo Visual Studio C++ tools not found. & exit /b 1 )
set "VCVARS=%VSDIR%\VC\Auxiliary\Build\vcvarsall.bat"

rem ---- Build the requested architecture(s) ----------------------------------
set "BUILT="
set "FAILED="
if /i "%WHAT%"=="all" (
  call :one x64   x64        X64   && set "BUILT=!BUILT! x64"   || set "FAILED=!FAILED! x64"
  call :one x86   x64_x86    X86   && set "BUILT=!BUILT! x86"   || set "FAILED=!FAILED! x86"
  call :one arm64 x64_arm64  ARM64 && set "BUILT=!BUILT! arm64" || set "FAILED=!FAILED! arm64"
) else if /i "%WHAT%"=="x64" (
  call :one x64   x64        X64   && set "BUILT=!BUILT! x64"   || set "FAILED=!FAILED! x64"
) else if /i "%WHAT%"=="x86" (
  call :one x86   x64_x86    X86   && set "BUILT=!BUILT! x86"   || set "FAILED=!FAILED! x86"
) else if /i "%WHAT%"=="arm64" (
  call :one arm64 x64_arm64  ARM64 && set "BUILT=!BUILT! arm64" || set "FAILED=!FAILED! arm64"
) else (
  echo unknown target "%WHAT%" - use x64, x86, arm64, or all.
  exit /b 1
)

echo.
if defined BUILT   echo Built:            !BUILT!
if defined FAILED  echo Skipped/failed:  !FAILED!   ^(that target's MSVC toolchain may not be installed^)
if not defined BUILT ( echo Nothing was built. & exit /b 1 )
echo Place build\^<arch^>\version.dll next to the matching browser exe, then start it.
exit /b 0

rem ===========================================================================
rem :one <arch> <vcvars-arg> <link-machine>
rem Builds one architecture in its own environment. Returns 1 on skip or failure.
rem ===========================================================================
:one
setlocal EnableExtensions
set "ARCH=%~1"
set "VCARG=%~2"
set "MACH=%~3"
echo.
echo === %ARCH% ===
call "%VCVARS%" %VCARG% >nul 2>nul
if errorlevel 1 ( echo   [skip] %ARCH%: "vcvarsall %VCARG%" failed - toolchain not installed. & endlocal & exit /b 1 )
rem vcvarsall succeeds even when the requested TARGET compiler is missing (it
rem just leaves the host cl on PATH), so check for the cross-compiler itself.
if not exist "%VCToolsInstallDir%bin\Host%VSCMD_ARG_HOST_ARCH%\%VSCMD_ARG_TGT_ARCH%\cl.exe" (
  echo   [skip] %ARCH%: the %MACH% cross-compiler is not installed.
  echo          Add "MSVC ... C++ %MACH% build tools" in the Visual Studio Installer.
  endlocal & exit /b 1
)
where cl >nul 2>nul || ( echo   [skip] %ARCH%: cl not found for %VCARG%. & endlocal & exit /b 1 )

set "OBJ=build\%ARCH%"
if not exist "%OBJ%" mkdir "%OBJ%"

rem /Gy puts each function in its own section so /OPT:REF can drop unreferenced
rem ones; /FIintrin.h force-includes the intrinsics so the SDK headers find
rem Interlocked*64 on ARM64.
cl /nologo /c /O2 /W3 /EHsc /Gy /FIintrin.h /DUNICODE /D_UNICODE ^
  /Fo%OBJ%\version-shim.obj version-shim.cpp
if errorlevel 1 ( echo   [fail] %ARCH%: shim compile failed. & endlocal & exit /b 1 )

rem Do NOT add /GL (LTCG): the stub bodies must stay distinct so /OPT:ICF cannot
rem merge two exports onto one address before WriteJump() rewrites them.
link /nologo /DLL /OUT:%OBJ%\version.dll /IMPLIB:%OBJ%\version.lib ^
  /OPT:REF /OPT:ICF ^
  /DYNAMICBASE /MANIFEST:NO /MACHINE:%MACH% kernel32.lib psapi.lib ^
  %OBJ%\version-shim.obj
if errorlevel 1 ( echo   [fail] %ARCH%: link failed. & endlocal & exit /b 1 )

rem Ship only the DLL: drop the intermediates.
del /q "%OBJ%\*.obj" "%OBJ%\*.lib" "%OBJ%\*.exp" >nul 2>nul
echo   ok: %OBJ%\version.dll
endlocal & exit /b 0
