# MVP-5 验证脚本（真实环境/CI 均可跑）
# 用法：pwsh -File test-env/verify-mvp5.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "== [1/3] typecheck ==" -ForegroundColor Cyan
pnpm typecheck
if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }

Write-Host "== [2/3] build ==" -ForegroundColor Cyan
pnpm build
if ($LASTEXITCODE -ne 0) { throw "build failed" }

Write-Host "== [3/3] unit tests ==" -ForegroundColor Cyan
pnpm vitest run
if ($LASTEXITCODE -ne 0) { throw "tests failed" }

Write-Host ""
Write-Host "MVP-5 verify OK: typecheck 0 error, build ok, all tests green." -ForegroundColor Green
Write-Host "真实环境项请参考 docs/MVP-5/预研项状态.md 与 docs/MVP-5/Phase-H-验收清单.md" -ForegroundColor Yellow
