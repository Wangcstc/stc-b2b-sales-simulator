/**
 * 阿里国际站聊天记录导出件 → 结构化对象。**纯核心：一个 node 内建模块都不 import。**
 *
 * ★ 为什么要单独拆出这个文件 ★（2026-08-28 第四批）
 * 王老师裁 D6 选项 A：**脱敏在客户那一侧跑，服务端只收脱敏后的 JSON。**
 * 产品化之后客户的聊天记录里有客户名单和真实成交价——那是他最不愿意上传的东西；
 * 把脱敏做成浏览器端跑，既是合规底线，也是这个产品最好卖的一个点
 *（「你的客户名单和成交价从不离开你的电脑」）。
 *
 * 而原来的 `chat-parse.ts` 在文件顶部 import 了 `node:fs` 与 `node:path`——
 * **只要那一行还在，整个模块就打不进浏览器包**，哪怕真正用到 fs 的只有一个读文件的壳。
 * 所以解析逻辑整个搬到这里（不碰任何 node 内建），`chat-parse.ts` 只剩那个壳。
 * `chat-redact.ts` 本来就没有 fs 依赖，不用动——**脱敏链路到这里就整条可以在浏览器里跑了**。
 *
 * ★ 有守卫盯着 ★ `npm run check:engine` 把这个文件列进「客户端可跑」组，
 * 出现 fs / path / child_process / os 的 import 会硬失败。
 * 这条规矩靠自觉是守不住的：加一行 import 不会报错，只会在某天打包时才炸。
 *
 * 阿里国际站聊天记录导出件（alibaba-chat-export）→ 结构化对象
 *
 * ★ 只认结构，不认版本 ★
 * 手上 785 份样本横跨 v4.0–v6.0，实测下来核心结构从没变过：
 *   .info（抬头）/ .msg.me|.msg.client / .sender / .time / .text / .date-divider
 * 变的全是 v6 新增的分析面板（.cust-box 客户面板、.prof-box 画像、.buy-box 采购偏好、
 * .okki-box、.text-cn 中文对照）。所以这些一律当**可选**读：缺了置 null，不报错。
 * 老文件照样能进，只是明牌信息少，得在人设定稿时补。
 *
 * ★ 不在这里做脱敏 ★
 * 这一层只负责"把 HTML 变成对象"，原样保真。脱敏是下一层 chat-redact.ts 的事。
 * 混在一起会出一种很难查的错：解析改了字段，脱敏规则没跟上，真实信息从新字段漏出去。
 */


import { parse, type HTMLElement } from 'node-html-parser';

export interface ChatMessage {
  /** 所属日期（来自 .date-divider），老文件里可能缺 */
  date: string | null;
  side: 'me' | 'client';
  sender: string;
  time: string;
  text: string;
  /** v6 的中文对照。只做人工阅读用，不喂给人设生成——机翻腔会污染 language_style */
  textCn?: string;
  kind: 'text' | 'file' | 'card' | 'image';
  /** 附件与图片：只留文件名/标记，链接本身在这里就丢掉（带阿里临时密钥，且会过期） */
  attachments: string[];
}

export interface RawChat {
  source: { file: string; exporterVersion: string | null };
  /** .info 抬头：客户 / 地区 / 负责人 / 询价单号 / 消息数量 / 时间范围 */
  header: Record<string, string>;
  /** v6 客户面板（阿里后台原样搬来的明牌） */
  customer: { fields: Record<string, string>; behavior90d: Record<string, string> } | null;
  okki: Record<string, string> | null;
  /** v6 客户画像：身份背景 / 采购需求 / 推进阶段 / 客户信号 / 跟进建议 */
  profile: Record<string, string> | null;
  buying: { cats: string[]; notes: Record<string, string> } | null;
  order: { hasOrder: boolean; text: string } | null;
  messages: ChatMessage[];
}

/**
 * 导出件偶尔是 UTF-8 被按 latin1 存过一道的（表现为「èå¤©è®°å½」这种）。
 * 按 utf8 读完扫一眼特征字节，中招就按 latin1 重读一次。
 */

function clean(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 读 <table class="ct"> 的 th/td 对 */
function readTable(el: HTMLElement | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const tr of el.querySelectorAll('tr')) {
    const k = clean(tr.querySelector('th')?.text ?? '');
    const v = clean(tr.querySelector('td')?.text ?? '');
    if (k) out[k] = v;
  }
  return out;
}

/** 读 <p><b>标题：</b>正文</p> 这种小节 */
function readSections(el: HTMLElement | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const p of el.querySelectorAll('p')) {
    const b = p.querySelector('b');
    if (!b) continue;
    const key = clean(b.text).replace(/[：:]\s*$/, '');
    const full = clean(p.text);
    if (key) out[key] = clean(full.slice(full.indexOf(b.text) + b.text.length));
  }
  return out;
}

function readBehavior(root: HTMLElement): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of root.querySelectorAll('.bcard')) {
    const lab = clean(c.querySelector('.blab')?.text ?? '');
    const num = clean(c.querySelector('.bnum')?.text ?? '');
    if (lab) out[lab] = num;
  }
  return out;
}

/** .info 抬头是「键：值」的平铺文本，逐行切（<br> 在 readHtml 里已换成换行） */
function readHeader(el: HTMLElement | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!el) return out;
  for (const line of el.text.split('\n')) {
    const t = clean(line);
    const m = t.match(/^(.+?)[：:]\s*(.*)$/);
    if (m?.[1]) out[m[1].trim()] = (m[2] ?? '').trim();
  }
  return out;
}

const CJK = /[一-龥]/g;

/** 一行里中文占比够高就算中文行 */
function isChineseLine(s: string): boolean {
  const body = s.replace(/\s/g, '');
  if (!body) return false;
  return (body.match(CJK) ?? []).length / body.length > 0.3;
}

/**
 * 老版本（v4/v5）没有独立的 .text-cn，把「原文\n中文翻译」塞在同一个 .text 里。
 * 不拆开的话，客户的语言风格样本里会混进机翻中文——而 language_style 正是靠这些
 * 原话归纳出来的，污染了人设一开口就不像本人。
 *
 * ★ 只拆客户侧 ★ 翻译是给中国业务员看客户消息用的，我方消息不翻。
 * 业务员自己写的中英对照两段都是他本人的话，拆了反而丢信息。
 * 判据：末尾若干行是中文主导，且前面还剩至少一行含拉丁字母 → 后半段是翻译。
 */
function splitTranslation(text: string, side: 'me' | 'client'): { text: string; cn?: string } {
  if (side !== 'client') return { text };
  const lines = text.split('\n');
  if (lines.length < 2) return { text };

  let i = lines.length;
  while (i > 0 && isChineseLine(lines[i - 1]!)) i--;
  if (i === lines.length || i === 0) return { text };

  const head = lines.slice(0, i).join('\n').trim();
  if (!/[A-Za-z]/.test(head)) return { text };
  return { text: head, cn: lines.slice(i).join('\n').trim() };
}

function readMessages(root: HTMLElement): ChatMessage[] {
  const out: ChatMessage[] = [];
  let date: string | null = null;

  // 日期分隔与消息是兄弟节点，必须按文档顺序走一遍才知道每条消息归哪天
  for (const node of root.querySelectorAll('.date-divider, .msg')) {
    const cls = node.getAttribute('class') ?? '';

    if (cls.includes('date-divider')) {
      // 分隔线用的是制表符 ─（U+2500）不是破折号，各版本还混用过 — 和 -
      date = clean(node.text).replace(/^[─—–\-\s]+|[─—–\-\s]+$/g, '') || null;
      continue;
    }

    const bubble = node.querySelector('.bubble');
    if (!bubble) continue;

    const textEl = bubble.querySelector('.text');
    const textCls = textEl?.getAttribute('class') ?? '';
    const imgs = bubble.querySelectorAll('img.chat-img');

    const attachments: string[] = [];
    let kind: ChatMessage['kind'] = 'text';
    if (textCls.includes('file')) kind = 'file';
    else if (textCls.includes('card')) kind = 'card';
    else if (!textEl && imgs.length) kind = 'image';

    // 文件气泡的正文是「📎 文件名\n大小」，抽出文件名当附件，正文换成占位
    let text = clean(textEl?.text ?? '');
    if (kind === 'file') {
      // 文件图标各版本用过 📎 📄 📁，一律按「开头的非文字符号」剥
      const fname = clean((text.split('\n')[0] ?? '').replace(/^[^\p{L}\p{N}]+/u, ''));
      if (fname) attachments.push(fname);
      text = `[附件] ${fname}`;
    }
    for (let i = 0; i < imgs.length; i++) attachments.push(`[图片${i + 1}]`);
    if (kind === 'image') text = '[图片]';
    else if (imgs.length) text = `${text}\n[图片×${imgs.length}]`.trim();

    const side: 'me' | 'client' = cls.includes('me') ? 'me' : 'client';

    // v6 有独立的 .text-cn；老版本要从正文里把翻译拆出来
    const cn = bubble.querySelector('.text-cn');
    let cnText = cn ? clean(cn.text).replace(/^中文\s*/, '') : '';
    if (!cnText && kind === 'text') {
      const split = splitTranslation(text, side);
      text = split.text;
      cnText = split.cn ?? '';
    }

    out.push({
      date,
      side,
      sender: clean(bubble.querySelector('.sender')?.text ?? ''),
      time: clean(bubble.querySelector('.time')?.text ?? ''),
      text,
      ...(cnText ? { textCn: cnText } : {}),
      kind,
      attachments,
    });
  }
  return out;
}


/**
 * 解析一份导出件。**吃的是 HTML 字符串，不是路径**——这样浏览器里也能调。
 *
 * @param html 已经读进内存的导出件正文。★ `<br>` 必须先换成换行 ★
 *             调用方负责（`chat-parse.readHtml` / 浏览器端的 `prepareHtml`），
 *             不然取 `.text` 时 `<br>` 会被吞掉、整条消息粘成一行，
 *             脱敏规则的 `[^
]` 边界会全部失效。理由详见 `prepareHtml`。
 * @param fileName 只用于 `source.file`。浏览器里传 `File.name`，Node 里传 `basename(path)`。
 */
export function parseChatHtml(html: string, fileName: string): RawChat {
  const root = parse(html);

  const custBox = root.querySelector('.cust-box');
  const orderBox = root.querySelector('.order-box');
  const buyBox = root.querySelector('.buy-box');

  const buyingNotes = readSections(buyBox);

  return {
    source: {
      file: fileName,
      exporterVersion: root.text.match(/alibaba-chat-export v[\d.]+/)?.[0] ?? null,
    },
    header: readHeader(root.querySelector('.info')),
    customer: custBox
      ? { fields: readTable(custBox.querySelector('table.ct')), behavior90d: readBehavior(custBox) }
      : null,
    okki: root.querySelector('.okki-box') ? readTable(root.querySelector('.okki-box .ct')) : null,
    profile: root.querySelector('.prof-box') ? readSections(root.querySelector('.prof-box')) : null,
    buying: buyBox
      ? { cats: buyBox.querySelectorAll('.cat').map((c) => clean(c.text)), notes: buyingNotes }
      : null,
    order: orderBox
      ? {
          // 「无订单记录」标记走 .order-box.none / .bdg.idle，两种版本都出现过
          hasOrder: !(orderBox.getAttribute('class') ?? '').includes('none') && !orderBox.querySelector('.bdg.idle'),
          text: clean(orderBox.text),
        }
      : null,
    messages: readMessages(root),
  };
}
