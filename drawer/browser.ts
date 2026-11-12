/**
 * 抽屉的**浏览器端**公开入口：只有解析和脱敏，一个 node 内建都不碰。
 *
 * ★ 为什么单开一个入口 ★ 王老师 2026-08-28 定（D6 选项 A）：脱敏在主管自己的电脑上跑，
 * 服务器只收脱敏后的素材——「你的客户名单和成交价从不离开你的电脑」。
 * `drawer/index` 带着整条加工流水线（读写文件、调模型），打不进浏览器包；
 * 题库工坊的投料页只从这里拿东西。`npm run check:engine` 盯着这个文件不许引 node 内建。
 */
import { parseChatHtml, type RawChat } from './ingest/chat-parse-core';
import { createRedactor, type RedactResult } from './ingest/chat-redact';
import { DEFAULT_CONFIG } from './types';

export { createRedactor, parseChatHtml };
export type { RawChat, RedactResult };
export type { ChatMessage } from './ingest/chat-parse-core';

/**
 * 导出件的字节 → 可以交给 `parseChatHtml` 的正文。
 *
 * ① 偶尔有 UTF-8 被当成 latin1 又存了一道的文件（满屏「èå¤©è®°å½」）：按 UTF-8 解完扫一眼特征，
 *    中招就把每个字符当一个字节、再按 UTF-8 解一次；
 * ② `<br>` 先换成换行——取 `.text` 时它会被吞掉，整条消息粘成一行，脱敏规则的行边界全部失效。
 */
export function prepareHtml(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  const mojibake = (utf8.match(/[ÃÂã][\u0080-¿]/g) ?? []).length;
  let html = utf8;
  if (mojibake > 20 && !/[一-龥]{3}/.test(utf8) && [...utf8].every((c) => c.charCodeAt(0) < 256)) {
    html = new TextDecoder('utf-8').decode(Uint8Array.from(utf8, (c) => c.charCodeAt(0)));
  }
  return html.replace(/<br\s*\/?>/gi, '\n');
}

/** 投料页的预检口径：买家发言少于这么多条的，加工时会被跳过（与抽屉默认的出题门槛一致） */
export const MIN_CLIENT_MESSAGES = DEFAULT_CONFIG.minClientMessages;
