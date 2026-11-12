/**
 * 调用③｜中译英：把新人打的中文改写成欧美买手读着自然的商务英语
 *
 * ★ 为什么这个功能不算作弊 ★
 * 这套系统考的是「问什么、问的顺序、有没有问到六要素」，七力里没有「英语水平」
 * 这一项。真实阿里后台本来就带一键翻译，业务员天天在用——演习环境跟真实环境
 * 一致，训练才迁移得过去。让英语不好的新人把脑力耗在憋句子上，考出来的是英语，
 * 不是业务能力。
 *
 * ★ 但它有一条绝不能越的线：不许替新人多说一个字 ★
 * 新人只写了「你要多少？」，译文里就不能冒出交期、用途、定制需求。
 * 抽取（调用①）读的是发出去的英文，多译一句 = 系统判他问过了 = 六要素凭空多打一个勾。
 * 这是这个功能唯一可能污染评分公正性的地方，所以「不增不减」在下面写成第一铁律，
 * 而不是放在风格要求里凑数。
 */

import { call } from './client';
import { hasChinese } from '../../../engine/language';

/**
 * 段 1 固定前缀（逐字节稳定，可命中缓存）。
 *
 * 反例是照着外贸新人真实写法列的——只说「要地道」模型给不出东西，
 * 得把「哪句话是中式的、该换成什么」摆出来。
 */
const SYSTEM = [
  'You rewrite a Chinese supplier-side message into English that a native business writer would actually send to an overseas buyer on Alibaba.',
  '',
  '════════ RULE 1 — NOTHING ADDED, NOTHING DROPPED ════════',
  '',
  'This overrides every style rule below.',
  '',
  '- Do NOT add any question, condition, detail or courtesy the writer did not write.',
  '- Do NOT merge in a "helpful" follow-up question. If the writer asked one thing, the output asks one thing.',
  '- Do NOT drop anything the writer did write.',
  '- Numbers, quantities, prices, currencies, units, incoterms (FOB/CIF/EXW/DDP), MOQ, model codes, dates and lead times must survive EXACTLY as written.',
  '',
  '★ NO GREETING, NO SIGN-OFF, EVER ★',
  'This is a live chat window, not an email. Unless the writer actually wrote one:',
  'do NOT open with "Hi", "Hello", "Dear ...", and do NOT close with "Best regards", "Thanks", "Sincerely", a name, or a blank line + signature.',
  'Output the message body and nothing else. One greeting the writer did not type is one line of fake content sent under their name.',
  '',
  'Tone is yours to fix; content is not. If the writer boasts, brags or over-promises, keep the point and say it plainly —',
  'do not delete the claim, and do not sharpen it either.',
  '',
  'Test before you answer: does the English ask for, promise, or say anything the Chinese did not? If yes, delete it.',
  '',
  '════════ RULE 2 — WRITE IT, DON\'T TRANSLATE IT ════════',
  '',
  'Read the Chinese, understand the intent, then write what a native speaker would write to convey that intent.',
  'Never map word by word. Chinese sentence structure carried into English is exactly what makes it read foreign.',
  '',
  '════════ THE CHINGLISH PATTERNS TO KILL ════════',
  '',
  'These are how Chinese sales reps actually write. Replace them:',
  '',
  '- "Please kindly tell me / Please kindly check"  →  "Could you let me know" / "Take a look when you get a chance"',
  '- "Waiting for your early reply" / "Your early reply will be highly appreciated"  →  "Looking forward to your reply" — or just end the message',
  '- "Dear friend" / "Dear Sir or Madam"  →  "Hi <Name>," ONLY if the writer actually wrote a greeting; otherwise no greeting at all',
  '- "We are a professional manufacturer with 15 years experience, our quality is very good, please rest assured"',
  '     →  keep the facts, drop the puffery: "We\'ve been making camping gear for 15 years." Do not delete the sentence; do not add a guarantee either.',
  '- "the goods" / "this goods"  →  "the order", "your order", or the actual product name — never bare "goods"',
  '- "I will try my best to help you"  →  "Let me look into it" / "I\'ll check and get back to you"',
  '- "Please check it and give me your feedback"  →  "Let me know what you think"',
  '- "as soon as possible" used as filler  →  give a real timeframe, or drop it',
  '- "Do you have any other question?"  →  "Anything else you\'d like to know?"',
  '- "notice you" / "notify you"  →  "let you know"',
  '- "the goods"  →  "the order" / "your order" / the actual product name',
  '- Stacked intensifiers ("very much appreciated", "highly recommend", "greatly help")  →  say it once, plainly',
  '- Opening every message with "Thanks for your inquiry"  →  only if it is genuinely the first reply',
  '',
  '════════ STYLE ════════',
  '',
  '1. Short sentences. One idea each. Break long Chinese sentences into two or three English ones.',
  '2. Active voice. "We can ship it by 20 Nov", not "It can be shipped by 20 Nov".',
  '3. Contractions are fine and normal (I\'ll, we\'ve, don\'t). This is chat, not a legal notice.',
  '4. Professional and equal — not deferential. A supplier is a business partner, not a servant.',
  '   No begging, no over-apologising, no exclamation marks stacked up.',
  '5. Do not pad. If the Chinese is one short line, the English is one short line.',
  '6. Keep the writer\'s own directness. If they were blunt, stay blunt; don\'t smooth it into mush.',
  '',
  '════════ OUTPUT ════════',
  '',
  'Output ONLY the English message. No quotes, no notes, no explanation, no alternatives, no preamble.',
  'Never prefix the answer with things like "Here is the rewritten message:".',
  'ALWAYS output English, however short the input is. "好的。" becomes "Sure." — never echo Chinese back.',
].join('\n');

/**
 * 纯英文输入时改走润色。
 * ★ 结尾必须重申输出格式 ★ 这段是拼在 SYSTEM 后面的，成了最后一条指令——
 * 2026-08-06 实测：不重申的话它会盖过上面的 OUTPUT 段，模型开始输出
 * 「Here's the rewritten message:」这种前缀。
 */
const POLISH_NOTE = [
  '',
  'NOTE: the input below is already in English. Do not translate it — rewrite it so it reads like a native business writer,',
  'applying the same rules. RULE 1 still applies in full: no new questions, no new commitments, nothing dropped.',
  'If it is already natural and clear, return it unchanged.',
  'Output ONLY the message itself — no preamble, no "Here is...", no explanation.',
].join('\n');

/**
 * ★ 判定搬走了 ★（2026-08-23）
 * `hasChinese` 现在住在 `engine/language.ts`——状态机要用它判红线④，
 * 而引擎是无菌区，不许反过来 import `llm/`。这里只是转出去，口径全站一套。
 */
export { hasChinese } from '../../../engine/language';

export interface TranslateResult {
  text: string;
  /** true = 输入本来就是英文，做的是润色不是翻译 */
  polished: boolean;
}

/**
 * temperature 压到 0.3。
 * 翻译要的是稳定与准确，不是文采——同一句中文来回译出不同措辞，
 * 新人会以为系统在乱改，反复点重译，白烧 token。
 */
export async function toBusinessEnglish(
  input: string,
  sessionId?: string,
): Promise<TranslateResult> {
  const text = input.trim();
  const polished = !hasChinese(text);

  const res = await call({
    purpose: 'translate',
    sessionId,
    temperature: 0.3,
    messages: [
      { role: 'system', content: polished ? SYSTEM + POLISH_NOTE : SYSTEM },
      { role: 'user', content: text },
    ],
  });

  let out = res.content.trim();

  // 「Here is the rewritten message:」这类前缀。prompt 里已经禁了，这里是第二道
  out = out.replace(/^(here('s| is)[^\n:]{0,40}:|下面是[^\n:：]{0,20}[:：]|以下是[^\n:：]{0,20}[:：])\s*\n+/i, '').trim();

  // 模型偶尔会给整段裹上引号，去掉——但只去成对的首尾引号，不动句内引号
  if (/^["'“‘](.|\n)*["'”’]$/.test(out) && !out.slice(1, -1).includes('\n\n')) {
    out = out.slice(1, -1).trim();
  }

  if (!out) return { text, polished };

  /**
   * 中文残留检查。
   * ★ 2026-08-06 实测：输入「好的。」时模型原样把中文吐回来 ★
   * 太短的句子它会当成不需要处理。悄悄返回原文最坏——新人点了按钮、看见没变化，
   * 只会以为按钮坏了，然后把中文直接发给客户。宁可明确报错让他知道。
   */
  if (!polished && hasChinese(out)) {
    throw new Error('这句太短或太口语，没能译好，请把话说完整一点再试');
  }

  return { text: out, polished };
}


/* ════════════════════════════════════════════════════════════════════════
 * 调用③'｜英译中：把客户说的英文翻成中文，给看不懂的新人对照着读
 *
 * ★ 和上面那条是两件事，别混 ★
 *   · 中译英是「替新人把话说得地道」，有一条铁律：不许替新人多说一个字；
 *   · 英译中是「让新人读懂客户在说什么」，铁律是反过来的：**忠实**——
 *     客户没说的不许添，客户说了的不许漏，也不许替客户「润色」或「解读」。
 *     译出来的话如果比原文更客气、更清楚、更有诚意，新人就会按一个不存在的客户去谈。
 *
 * ★ 译文只是旁注，从不进评分 ★ 评分与抽取读的永远是英文原文；这条译文不写库、
 * 不进对话记录，页面一刷新就没了（前端自己缓存着，不用再花钱）。
 * ════════════════════════════════════════════════════════════════════════ */

const SYSTEM_ZH = [
  '你是外贸业务场景的翻译。把海外买家发来的英文消息，翻译成通顺自然的简体中文，给中国业务员对照着读。',
  '',
  '【第一条：忠实，不增不减】',
  '- 原文说了什么就译什么。不添加原文没有的信息、礼貌话、建议或你的理解；不省略任何一句。',
  '- 不替买家润色：原文生硬、冷淡、含糊，译文也保持生硬、冷淡、含糊；原文有语病或没说清，译文照样没说清。',
  '- 语气要译出来：客气、催促、不耐烦、试探、压价，读中文也要能感觉出来。',
  '',
  '【第二条：这些原样保留，不翻译、不改写】',
  '- 数字、数量、价格、币种、单位、日期、时间（USD 9.8、300 pcs、1.1 kg、20 Nov）。',
  '- 贸易术语与缩写（FOB、CIF、EXW、DDP、MOQ、OEM、ODM、L/C、T/T）。',
  '- 型号、货号、网址、邮箱。',
  '- 人名、公司名、品牌名、地名（Jonas、Bergfeld Outdoor GmbH、Ningbo）。',
  '',
  '【格式】',
  '- 保留原文的分段和换行。',
  '- 只输出中文译文本身：不要引号包裹、不要「译文：」之类的前缀、不要解释、不要备选译法。',
  '- 原文里「Best regards, Jonas」这类落款也照译（「此致，Jonas」），不要省。',
].join('\n');

export interface TranslateZhResult {
  text: string;
}

/** 英文消息 → 中文。输入里没有一个拉丁字母（纯中文、纯数字符号）就不翻 */
export async function toChinese(input: string, sessionId?: string): Promise<TranslateZhResult> {
  const text = input.trim();
  if (!/[A-Za-z]/.test(text)) throw new Error('这句话里没有英文，不需要翻译');

  const res = await call({
    purpose: 'translate',
    sessionId,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_ZH },
      { role: 'user', content: text },
    ],
  });

  let out = res.content.trim();
  out = out.replace(/^(译文|翻译|中文|以下是[^\n:：]{0,20}|下面是[^\n:：]{0,20})[:：]\s*\n*/i, '').trim();
  if (/^["'“‘「](.|\n)*["'”’」]$/.test(out) && !out.slice(1, -1).includes('\n\n')) out = out.slice(1, -1).trim();

  // 没有一个汉字 = 模型把英文原样吐了回来。悄悄显示原文最坏：人会以为「译文」就是这样
  if (!out || !hasChinese(out)) throw new Error('没能译成中文，请稍后再试');
  return { text: out };
}
