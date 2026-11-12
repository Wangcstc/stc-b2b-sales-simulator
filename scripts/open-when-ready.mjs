/**
 * 等 dev server 真的能应答了，再打开浏览器。
 *
 * ★ 为什么要等 ★ Next dev 冷启动要十几秒（实测第 7 次探测才响应）。
 * 启动脚本里如果直接 `start http://localhost:3100`，浏览器会在服务还没起来的时候打开，
 * 拿到的是 ERR_CONNECTION_REFUSED——和"没启动"长得一模一样，
 * 于是人会以为启动失败，把窗口关掉重来，然后再看到一次同样的报错。
 *
 * 用法：node scripts/open-when-ready.mjs [端口] [最多等几秒]
 * Windows、Mac、Linux 都能用。
 */

const port = Number(process.argv[2] || 3100);
const timeoutSec = Number(process.argv[3] || 120);
const url = `http://localhost:${port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 能连上就算就绪。307（跳登录页）也是就绪——只要不是连接被拒 */
async function ready() {
  try {
    await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

const deadline = Date.now() + timeoutSec * 1000;
let dots = 0;

while (Date.now() < deadline) {
  if (await ready()) {
    // 按系统选打开方式。Windows 的 start：第一个引号参数是窗口标题，不能省，省了它会把 URL 当标题
    const { spawn } = await import('node:child_process');
    const [cmd, args] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    console.log(`\n  浏览器已打开 ${url}\n`);
    process.exit(0);
  }
  dots = (dots + 1) % 4;
  process.stdout.write(`\r  正在启动，请稍候${'.'.repeat(dots)}   `);
  await sleep(1000);
}

console.log(`\n  等了 ${timeoutSec} 秒还没起来。看上面的报错，或把整个窗口的内容发给王老师。\n`);
process.exit(1);
