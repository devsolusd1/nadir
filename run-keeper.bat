@echo off
cd /d "%~dp0"
:loop
echo [%date% %time%] NADIR keeper starting (harvest + start + poke)...
call npx hardhat run scripts/3-start-and-poke.js --network robinhood
echo [%date% %time%] keeper exited, restarting in 30s...
timeout /t 30 /nobreak >nul
goto loop
