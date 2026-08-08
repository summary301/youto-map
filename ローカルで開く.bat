@echo off
chcp 65001 >nul
pushd "%~dp0"
echo 用途地域マップをローカルで開きます。
echo 終了するときは、この黒い画面で Ctrl+C を押してください。
echo.
start "" http://localhost:8787
python -m http.server 8787 --directory site
popd
