# MVP-4 一键验收脚本（P4.E.3）
$ErrorActionPreference = 'Stop'
Set-Location D:\dsharness\agentDev\softwareEngnieering\3pluginCode
$env:DSH_HOME = 'D:\dsharness\agentDev\softwareEngnieering\3pluginCode\test-env\dsh-home'

Write-Host "`n[1/8] 类型检查..." -ForegroundColor Yellow
pnpm typecheck
if ($LASTEXITCODE -ne 0) { Write-Host "❌ typecheck 失败" -ForegroundColor Red; exit 1 }

Write-Host "`n[2/8] 单元测试..." -ForegroundColor Yellow
pnpm test
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 测试失败" -ForegroundColor Red; exit 1 }

Write-Host "`n[3/8] 构建..." -ForegroundColor Yellow
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 构建失败" -ForegroundColor Red; exit 1 }

Write-Host "`n[4/8] 打包..." -ForegroundColor Yellow
pnpm pack --pack-destination ./dist
if ($LASTEXITCODE -ne 0) { Write-Host "❌ 打包失败" -ForegroundColor Red; exit 1 }

Write-Host "`n[5/8] 重启 DSH web（测试 profile 3081）..." -ForegroundColor Yellow
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*weave-test*" } |
  Stop-Process -Force
$dshBin = (Get-Command dsh -ErrorAction SilentlyContinue).Source
if (-not $dshBin) { $dshBin = "node $env:DSH_HOME\profiles\node_modules\@deepseek-ai\dsh\bin\dsh.mjs" }
Start-Process -FilePath "node" -ArgumentList "$dshBin --profile weave-test --port 3081 --no-open" -WindowStyle Hidden
Start-Sleep -Seconds 5

Write-Host "`n[6/8] 验证 REST 端点..." -ForegroundColor Yellow
$graphs = curl.exe -s http://127.0.0.1:3081/api/weave/graphs
if ($LASTEXITCODE -ne 0 -or $graphs -match '404') { Write-Host "❌ REST 不可用" -ForegroundColor Red; exit 1 }
Write-Host "  ✓ /api/weave/graphs → $graphs"

Write-Host "`n[7/8] 验证 SSE 通道..." -ForegroundColor Yellow
$sse = curl.exe -s -N --max-time 2 http://127.0.0.1:3081/api/weave/graph/test/stream
if ($sse -notmatch 'connected') { Write-Host "⚠ SSE 未返回心跳（图未运行时正常）" -ForegroundColor Yellow } else { Write-Host "  ✓ SSE connected" }

Write-Host "`n[8/8] 验证看板挂载（D1+D3）..." -ForegroundColor Yellow
Write-Host "请手动打开 http://127.0.0.1:3081 检查："
Write-Host "  · 对话页头出现 'Weave 看板' 按钮（D1）"
Write-Host "  · 点击按钮 → 主区切换为全屏看板（D3）"
Write-Host "  · 图节点实时染色 / Token 分账 / 审批 / 消息流 / 暂停恢复终止"

Write-Host "`n✅ MVP-4 自动化验收完成" -ForegroundColor Green
