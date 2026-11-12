/**
 * 暗牌解锁正则与泄露信号的自检（原 `scripts/import/verify-persona.ts` 的判定部分）。
 *
 * 纯函数：只跑判定引擎的 detectUnlocks / checkLeak，不调模型、不连库。
 * 返回问题清单；命令行与抽屉质检工序共用这一份。
 */
import { checkLeak, detectUnlocks, emptyUnlockState, type HiddenCards } from '../../engine/unlock.js';
import type { Persona } from '../../bank-kit/index';

export interface Problem {
  level: '✗' | '⚠';
  what: string;
}

/** 客户扮演时极可能说出口的普通话术——不该被判成泄露 */
export const INNOCENT_REPLIES = [
  'Ok, please send me your quotation.',
  'I will reach out to my colleague and come back to you.',
  'We have worked with another supplier before.',
  'Thank you, I will check with my team.',
  'Can you tell me the price for this item?',
  'The supplier we used before was not reliable.',
  'Please reach me here, I check this every day.',
  'What is the production time after payment?',
];

/** 新人说的再普通不过的话——不该凭空解锁暗牌（引擎按子串匹配，裸短词会在别的单词里命中） */
export const INNOCENT_ASKS = [
  'What is your best price?',
  'Hello, what is the price for one container?',
  'Could you send me the price list?',
  'When can you arrange shipping?',
  'Once shipping is arranged please let me know.',
  'The goods arrived broken.',
  'Some items arrived broken in the last shipment.',
  'Please send the packing list and the invoice.',
  'Thank you, I will look into it.',
  'Our lead time is 25 days.',
  'When the shipping is ready we will confirm.',
  'When your order is ready we will send you photos.',
];

const REGEX_LIKE = /\\[bdwsBDWS]|\||\.\*|\.\+|\[[^\]]*\]|\(\?|\)[?*+]|\][?*+]/;

/** 只取真正的暗牌（下划线开头的是说明） */
export function cardsOf(p: Pick<Persona, 'hidden_card'>): HiddenCards {
  return Object.fromEntries(Object.entries(p.hidden_card ?? {}).filter(([k]) => !k.startsWith('_'))) as HiddenCards;
}

export function checkRegex(p: Persona): Problem[] {
  const out: Problem[] = [];
  const cards = cardsOf(p);
  const cases = p.verify_cases ?? [];
  if (!cases.length) return [{ level: '✗', what: '题目里没有 verify_cases，暗牌的解锁条件无从验证' }];

  const covered = new Set(cases.map((c) => c.card));
  for (const key of Object.keys(cards)) if (!covered.has(key)) out.push({ level: '⚠', what: `暗牌 ${key} 没有任何用例，正则未经验证` });

  // ⓪ 正则转义：JSON 里的 \b 是退格符，不是词边界
  const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
  for (const [key, card] of Object.entries(cards)) {
    for (const group of ['unlock_patterns', 'unlock_patterns_topic', 'unlock_patterns_framing'] as const) {
      for (const pat of (card[group] ?? []) as string[]) {
        if (/^\/.+\/[a-z]*$/s.test(pat.trim())) out.push({ level: '✗', what: `${key}.${group}：正则写成了 /…/ 字面量，引擎会把斜杠当字符去匹配，永远解不开——去掉两边的斜杠和标志` });
        if (CTRL.test(pat)) out.push({ level: '✗', what: `${key}.${group}：正则里混进了控制字符，多半是 \\\\b 少了一层转义` });
        try {
          new RegExp(pat, 'i');
        } catch {
          out.push({ level: '✗', what: `${key}.${group}：正则写错了，编译不过：${pat}` });
        }
      }
    }
  }

  // 编译不过的正则会让后面每一项都抛异常：报出来就停，先修正则
  if (out.some((x) => x.level === '✗' && /编译不过/.test(x.what))) return out;

  // ① 泄露信号卫生：按字面子串匹配，不许有正则语法；太短会误命中
  for (const [key, card] of Object.entries(cards)) {
    for (const sig of card.leak_signals ?? []) {
      // 只抓明摆着是正则写法的（\b、|、.*、[…]、(?、)+ 这类）；「50+50」「really?」「(FOB)」是正常文字，按字面照样匹配得上
      if (REGEX_LIKE.test(sig)) out.push({ level: '✗', what: `${key}：泄露信号「${sig}」含正则语法，但引擎按字面匹配，永远命中不了` });
      if (sig.replace(/\s/g, '').length <= 3 && /^[a-z]+$/i.test(sig)) out.push({ level: '⚠', what: `${key}：泄露信号「${sig}」太短，容易在别的单词里误命中` });
    }
  }

  // ② 普通话术不该被判泄露
  for (const reply of INNOCENT_REPLIES) {
    const hits = checkLeak(cards, reply, emptyUnlockState());
    if (hits.length) out.push({ level: '✗', what: `普通话术「${reply}」被判成泄露：${hits.map((h) => `${h.card}「${h.signal}」`).join('、')}` });
  }

  // ②b 普通话不该白送暗牌
  for (const msg of INNOCENT_ASKS) {
    const { fresh } = detectUnlocks(cards, msg, emptyUnlockState(), 2);
    if (fresh.length) out.push({ level: '✗', what: `「${msg}」凭空解锁了 ${fresh.join('、')}——正则太宽：要么是 ≤3 字母的裸词在别的单词里命中（改成 \\bXX\\b），要么只认关键词不认问法（业务员在说自己的情况，不是在问客户；加上 you / your 之类的问句结构）` });
  }

  // ③ 正反例
  for (const c of cases) {
    const card = cards[c.card];
    if (!card) {
      out.push({ level: '✗', what: `用例指向的暗牌 ${c.card} 不存在` });
      continue;
    }
    const base = emptyUnlockState();
    for (const r of card.requires ?? []) {
      base.unlocked.push(r);
      base.unlockedAt[r] = 1;
    }
    for (const msg of c.should) {
      if (!detectUnlocks(cards, msg, base, 2).fresh.includes(c.card)) out.push({ level: '✗', what: `${c.card} 应解锁却没解锁：「${msg}」` });
    }
    for (const msg of c.shouldNot) {
      if (detectUnlocks(cards, msg, base, 2).fresh.includes(c.card)) out.push({ level: '✗', what: `${c.card} 不该解锁却解锁了：「${msg}」` });
    }
  }

  // ④ 干扰项与开场询盘自己不该泄露
  for (const d of (p.distractors ?? []) as { content?: string }[]) {
    const hits = checkLeak(cards, d.content ?? '', emptyUnlockState());
    if (hits.length) out.push({ level: '✗', what: `干扰项自己就泄露了：${hits.map((h) => h.signal).join('、')}` });
  }
  const openHits = checkLeak(cards, p.open_card.inquiry_text, emptyUnlockState());
  if (openHits.length) out.push({ level: '✗', what: `开场询盘里就带着暗牌信号：${openHits.map((h) => h.signal).join('、')}` });

  return out;
}
