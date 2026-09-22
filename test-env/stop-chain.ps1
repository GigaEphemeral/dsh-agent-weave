# 停止 weave 链执行（创建 STOP 标志，阶段边界生效）
$root = 'D:\dsharness\agentDev\softwareEngnieering\productions'
$stop = Join-Path $root 'STOP'
New-Item $stop -Force | Out-Null
Write-Host ''
Write-Host '  已创建 STOP 标志：' -ForegroundColor Yellow
Write-Host "    $stop"
Write-Host '  链将在【当前阶段完成后】中止，不启动后续阶段。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  恢复执行：运行 resume-chain.ps1 或删除该文件' -ForegroundColor DarkGray
Write-Host ''
