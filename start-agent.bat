@echo off
title telebirr relay agent
cd /d "%~dp0"
echo Starting the telebirr relay agent... keep this window open.
node agent.js https://payment-verifier-21ab.onrender.com
pause
