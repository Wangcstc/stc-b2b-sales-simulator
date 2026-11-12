# 停掉这个项目的 dev server。
#
# ★ 不能按进程名杀 ★ 杀 node.exe 会把这台机器上所有 Node 程序一起带走
# （别的项目、编辑器插件、各种工具都在跑 node）。
#
# ★ 也不能只按命令行匹配项目路径 ★ 实测这个服务是四层进程：
#     cmd.exe  →  npm 包装(node)  →  next dev(node)  →  next-server(node，监听 3100)
#   中间那层 npm 包装的命令行是 `node npm-cli.js run dev`——**不含项目路径**，
#   靠路径匹配会漏掉它。漏了虽然多半也能自己退出，但留个悬着的进程不干净。
#
# 所以两条路一起用，取并集：
#   ① 谁在听 3100，就从它往上走祖先链（只收 node/cmd，遇到别的就停）——这条最准，
#      因为"正在服务这个端口的进程树"本身就是我们要停的东西；
#   ② 命令行里带项目路径的——兜底，服务没起来监听时也能收干净。

# ★ 每个 Get-NetTCPConnection 都要显式写 -ErrorAction ★
# 端口没人听时它抛的是 CimJobException，脚本级的 $ErrorActionPreference 拦不住，
# 会在"已停止"这条好消息旁边打一片红字，看着像出事了。
$ErrorActionPreference = 'SilentlyContinue'
# 项目根目录（本脚本在 scripts\ 下）。别写死文件夹名：别人克隆下来的目录名不一样
$mark = Split-Path -Parent $PSScriptRoot
$port = 3100
$kill = @{}   # PID -> 进程对象，用哈希去重

function Add-Proc($p) { if ($p) { $kill[[int]$p.ProcessId] = $p } }

# ① 从端口监听者往上走
$owner = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
if ($owner) {
  $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$owner"
  $guard = 0
  while ($cur -and $guard -lt 8) {
    Add-Proc $cur
    $par = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)"
    # 只往上收 node / cmd；再往上是资源管理器或系统服务，收了会出事
    if (-not $par -or ($par.Name -notin @('node.exe', 'cmd.exe'))) { break }
    $cur = $par
    $guard++
  }
}

# ② 命令行里带项目路径的
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
  Where-Object { $_.CommandLine -like "*$mark*" -and $_.CommandLine -notlike '*stop-server*' } |
  ForEach-Object { Add-Proc $_ }

if ($kill.Count -eq 0) {
  Write-Host ''
  Write-Host '  服务本来就没在跑。'
  Write-Host ''
  exit 0
}

# 先杀子再杀父：反过来的话父进程可能把子进程重新拉起来
foreach ($p in ($kill.Values | Sort-Object ParentProcessId -Descending)) {
  Write-Host ("  停止 {0} (PID {1})" -f $p.Name, $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force
}

Start-Sleep -Milliseconds 900

Write-Host ''
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host '  端口还有人在听，可能需要在任务管理器里手动结束 node.exe。'
} else {
  Write-Host '  已停止。网站现在打不开是正常的，双击「启动系统」可以再开。'
}
Write-Host ''
