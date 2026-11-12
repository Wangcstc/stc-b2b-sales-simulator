/**
 * 导出件读盘壳：**只负责把文件读成字符串**，解析在 `chat-parse-core.ts`。
 *
 * ★ 2026-08-28：解析逻辑整个搬走了 ★（第四批，D6 选项 A）
 * 脱敏要在客户那一侧跑（服务端只收脱敏后的 JSON），而**只要模块顶部还有一行
 * `import 'node:fs'`，整个模块就打不进浏览器包**——哪怕真正用到 fs 的只有下面
 * 这一个函数。所以拆成两半：纯解析在 core（有守卫盯着不许引 node 内建），
 * 读盘留在这里。`chat-redact.ts` 本来就没有 fs 依赖，不用动。
 *
 * 类型与 `parseChatHtml` 从这里原样再导出一次，老调用点的 import 路径不用改。
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseChatHtml, type RawChat } from './chat-parse-core.js';

export type { ChatMessage, RawChat } from './chat-parse-core.js';
export { parseChatHtml } from './chat-parse-core.js';

/**
 * 导出件偶尔是 UTF-8 被按 latin1 存过一道的（表现为「èå¤©è®°å½」这种）。
 * 按 utf8 读完扫一眼特征字节，中招就按 latin1 重读一次。
 */
function readHtml(path: string): string {
  const buf = readFileSync(path);
  const utf8 = buf.toString('utf8');
  const mojibake = (utf8.match(/[ÃÂã][-¿]/g) ?? []).length;
  const html =
    mojibake > 20 && !/[一-龥]{3}/.test(utf8)
      ? Buffer.from(buf.toString('latin1'), 'binary').toString('utf8')
      : utf8;

  /**
   * ★ <br> 必须先变成换行 ★（2026-08-06 实测补）
   * 取 .text 时 <br> 会被直接吞掉，整条消息粘成一行：
   *   「Company Name: XAddr: 40 …STREETTEL: +234…Fax: …-Name: …-Position: …」
   * 后果是一串：脱敏规则的 [^\n] 边界全部失效，一条 Name: 规则能一口吃掉后面的
   * 职位和国籍；数字紧贴字母又让护照号、电话匹配不上词边界，直接漏号。
   * 而且分行本身有信息——报价单、行程表、地址块，粘成一行连人都读不动。
   */
  return html.replace(/<br\s*\/?>/gi, '\n');
}


export function parseChatFile(path: string): RawChat {
  return parseChatHtml(readHtml(path), basename(path));
}
