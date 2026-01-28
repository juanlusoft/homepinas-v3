@echo off
chcp 65001 >nul
title HomePiNAS Image Builder v2.0
color 0B

echo.
echo  ╔═══════════════════════════════════════════════════════════╗
echo  ║         HomePiNAS Image Builder v2.0                      ║
echo  ║         Homelabs.club Edition                             ║
echo  ╚═══════════════════════════════════════════════════════════╝
echo.

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Esta aplicacion requiere permisos de Administrador
    echo.
    echo  Haz clic derecho y selecciona "Ejecutar como administrador"
    echo.
    pause
    exit /b 1
)

:: Get script directory
set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: Launch PowerShell script
powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%HomePiNAS-ImageBuilder.ps1" %*

pause
