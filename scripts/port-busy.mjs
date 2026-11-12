/**
 * 端口上有没有人在听？有＝服务已经在跑。
 *
 * ★ 为什么启动脚本要先问这一句 ★ 双击两次启动器，第二个会在
 * 「端口已被占用」上直接崩掉，窗口一闪而过——什么都没看见，
 * 人只会以为"双击没反应"，于是再双击几次。
 * 先问一句，就能把这种情况变成"服务已经在运行，直接给你打开浏览器"。
 *
 * 退出码沿用 shell 惯例，给 .cmd 的 errorlevel 用：
 *   0 = 有人在听（服务在跑）    1 = 没人在听（可以启动）
 *
 * ★ 用「试着连接」判断，不能用「试着监听」★
 * 直觉上「我还能不能占住这个端口」更贴近问题，但那个办法在 Windows 上不成立：
 * Next dev 绑的是通配地址（0.0.0.0），而 Windows 允许在通配绑定之上
 * 再绑一个更具体的地址（127.0.0.1），除非对方开了 SO_EXCLUSIVEADDRUSE。
 * 实测：服务明明在 3100 上跑着，试监听照样成功——判定直接反了。
 * 连接探测没有这个问题：连得上就是有人在听。
 *
 * 用法：node scripts/port-busy.mjs [端口]
 */

import net from 'node:net';

const port = Number(process.argv[2] || 3100);

const sock = new net.Socket();
let done = false;

const finish = (code) => {
  if (done) return;
  done = true;
  sock.destroy();
  process.exit(code);
};

// 本机连接毫秒级就该有结果；1 秒还没动静，当作没人在听
sock.setTimeout(1000);
sock.once('connect', () => finish(0));
sock.once('timeout', () => finish(1));
sock.once('error', () => finish(1));

sock.connect(port, '127.0.0.1');
