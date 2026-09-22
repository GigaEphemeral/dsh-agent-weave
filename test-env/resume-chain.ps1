# 恢复 weave 链执行（清除 STOP 标志）
$root = 'D:\dsharness\agentDev\softwareEngnieering\productions'
$stop = Join-Path $root 'STOP'
if (Test-Path $stop) {
  Remove-Item $stop -Force
  Write-Host '  已清除 STOP 标志，链可正常执行。' -ForegroundColor Green
} else {
  Write-Host '  当前无 STOP 标志（链未被中止）。' -ForegroundColor DarkGray
}
Write-Host ''
