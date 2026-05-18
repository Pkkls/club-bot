@echo off
REM Launch Chrome with remote debugging enabled (run once at startup)
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir="C:\Users\kil\AppData\Local\Google\Chrome\User Data" ^
  https://club.com
