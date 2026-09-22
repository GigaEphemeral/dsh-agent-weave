# weave 链执行实时监控窗口
# 用法：pwsh -File watch-chain.ps1
# 说明：本窗口只读日志，不消耗 agent token；Ctrl+C 退出不影响链执行

$ErrorActionPreference = 'Continue'
$root = 'D:\dsharness\agentDev\softwareEngnieering\productions'
$log = Join-Path $root 'chain.log'
$stop = Join-Path $root 'STOP'

Write-Host ''
Write-Host '  ===== weave 链执行监控 =====' -ForegroundColor Cyan
Write-Host "  日志文件 : $log"
Write-Host "  产物目录 : $root"
Write-Host ''
Write-Host '  实时日志每行一条 JSON：' -ForegroundColor DarkGray
Write-Host '    阶段开始 / 心跳(每10秒,含已耗时) / 阶段完成(含耗时+产物) / 链结束' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  >> 停止链：在本窗口按 Ctrl+C 退出监控，然后运行：' -ForegroundColor Yellow
Write-Host "       New-Item '$stop' -Force" -ForegroundColor Yellow
Write-Host '     （或在另一窗口运行 stop-chain.ps1）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  >> 恢复：Remove-Item 上述 STOP 文件' -ForegroundColor DarkGray
Write-Host '  >> 按 Ctrl+C 仅退出监控，不影响链继续执行' -ForegroundColor DarkGray
Write-Host ''
Write-Host '  ------------------------------ 实时日志 ------------------------------' -ForegroundColor Cyan
Write-Host ''

if (-not (Test-Path $log)) {
  Write-Host '  [等待] 日志尚未生成——请在 web 界面发一条消息触发链执行' -ForegroundColor Yellow
}

Get-Content $log -Encoding UTF8 -Wait -Tail 40
