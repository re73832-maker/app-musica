@echo off
title Iniciar APP Musica

echo ========================================================
echo             INICIANDO APP MUSICA
echo ========================================================
echo.

echo [1/2] Iniciando Servidor Node en puerto 4000...
start "Servidor Musica" cmd /k "cd /d "%~dp0servidor-musica" && node index.js"

echo [2/2] Iniciando tunel Ngrok en puerto 4000...
start "Tunel Ngrok" cmd /k "ngrok http 4000"

echo.
echo Esperando que el servidor inicialice...
timeout /t 3 /nobreak >nul

echo Abriendo aplicacion en el navegador...
start http://localhost:4000

echo.
echo ========================================================
echo  Servidor y Ngrok activos.
echo.
echo  - PC: Abre http://localhost:4000
echo  - Celular: Copia el enlace HTTPS de la ventana de Ngrok
echo ========================================================
echo.
pause