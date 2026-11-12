/**
 * 事实表更新（需求 8.2）
 *
 * ★ 事实与评价必须分开 ★
 * LLM 评判天然被"话多、礼貌、格式漂亮"带偏。把可机器判定的事实
 * （问没问、问了几项、第几轮报的价、金额多少）从 LLM 手里拿走，
 * 评分时作为**只读证据**注入。LLM 只负责"这么问好不好"，不负责"他问没问"。
 */

import type {
  SessionFacts,
  Extraction,
  CustomerExtraction,
  SixElement,
  ElementSource,
  QuoteRecord,
  QuoteTier,
  Redline,
  DeliverableKind,
  QuoteLine,
} from './types';
import { SIX_ELEMENTS, statusOf } from './types';
import { QUOTE_TIER_BOUNDS } from './rules';
import type { HiddenCards } from './unlock';

/**
 * @param preset 前情里已经定死的六要素（跟进局用）。这几项开局就标成已知，
 *               来源记 preset——既不算业务员的功劳，也不算他的缺失。
 *               传空数组＝探需局的老行为，一切从零开始收集。
 */
export function emptyFacts(preset: readonly string[] = []): SessionFacts {
  const elements = Object.fromEntries(
    SIX_ELEMENTS.map((e) =>
      preset.includes(e)
        ? [e, { status: 'collected' as const, collected: true, source: 'preset' as const, turn: 0 }]
        : [e, { status: 'unasked' as const, collected: false }],
    ),
  ) as SessionFacts['elements'];

  return {
    elements,
    attributeDrilled: false,
    quantitySplitConfirmed: false,
    turnsToCollectAll: null,
    quotes: [],
    redlines: [],
    unlockedCards: [],
    askedQuestionByTurn: [],
    bgInitiated: false,
    bgItemsViewed: [],
    bgErrorDetected: false,
    distractorsFired: [],
    keyInfo: { email: false, whatsapp: false, realPurpose: false },
    followupLevelsUsed: [],
    deliverables: [],
  };
}

/**
 * 按本轮【业务员】抽取结果推进事实表。
 *
 * ★ 2026-08-23 改：问了 ≠ 收到了 ★
 * 老口径是 `asked_elements` 里出现什么就直接 `collected: true`。
 * 可 `asked_elements` 的语义是「业务员这一条消息里问了什么」（见 `llm/extract.ts`），
 * 于是「我问了、客户根本没答，它也打勾」成了必然。红线①读的是同一个字段，
 * 所以「问一句没人答就报价」的裸报价反而漏判——那是全系统唯一能作硬否决的判定。
 *
 * 现在这里**只把要素推到 `asked_no_answer`**；升到 `collected` 是
 * `applyCustomerAnswers()` 的事，要客户真的答了才算。
 *
 * ★ source 这一列是 2026-08-05 手动跑局发现的缺口 ★
 * 只记「收到没收到」，会把客户主动送上门的信息算成新人的功劳，洞察力虚高一档。
 */
export function updateFacts(
  facts: SessionFacts,
  ext: Extraction,
  turn: number,
  _source: ElementSource = 'asked',
): SessionFacts {
  const elements = { ...facts.elements };
  const quoteOf = new Map((ext.asked_element_evidence ?? []).map((e) => [e.element, e.quote]));

  for (const el of ext.asked_elements) {
    const prev = elements[el];
    // 已经拿到手的（含前情 preset）不动：他再问一遍不是功劳，那是没看前情。
    // 已经问过还没答的也不动——记第一次问的轮次，反复追问不叠加功劳。
    if (statusOf(prev) !== 'unasked') continue;
    elements[el] = {
      ...prev,
      status: 'asked_no_answer',
      collected: false,
      askedTurn: turn,
      askedQuote: quoteOf.get(el),
    };
  }

  const askedQuestionByTurn = [...facts.askedQuestionByTurn];
  askedQuestionByTurn[turn - 1] = ext.asked_question;

  const followupLevelsUsed = [...facts.followupLevelsUsed];
  if (ext.followup_level && ext.followup_level !== 'none') {
    followupLevelsUsed.push({ level: ext.followup_level, hasHook: ext.followup_has_hook ?? false, turn });
  }

  const next: SessionFacts = {
    ...facts,
    elements,
    attributeDrilled: facts.attributeDrilled || (ext.attribute_drilled ?? false),
    quantitySplitConfirmed: facts.quantitySplitConfirmed || (ext.quantity_split_confirmed ?? false),
    askedQuestionByTurn,
    followupLevelsUsed,
  };

  return stampCollectAll(next, turn);
}

/** 六要素（业务员问出来的那几项）齐了没有——齐了就钉住轮次 */
function stampCollectAll(facts: SessionFacts, turn: number): SessionFacts {
  if (facts.turnsToCollectAll !== null) return facts;
  if (countCollected(facts, 'asked') !== SIX_ELEMENTS.length) return facts;
  return { ...facts, turnsToCollectAll: turn };
}

/**
 * 按【客户】这一条消息推进事实表 —— 六要素真正被"收集到"的唯一入口。
 *
 * ★ 这条路径 2026-08-23 之前根本不存在 ★
 * 老实现只抽业务员那一条消息，`markVolunteered()` 与 `insightFactBasis()`
 * 全仓只有测试在调，生产一次都没调过。所以业务员反馈的
 * 「客户明明已经给了，系统抓不到」不是模型不准——**是压根没抽客户的话**。
 *
 * 归属规则：
 * - 之前业务员问过（`asked_no_answer`）→ 记 `asked`，**这才是他的功劳**
 * - 之前没人问，客户自己吐的 → 记 `volunteered`，不计功劳（洞察力锚点只数 asked）
 * - 已经到手的（含前情 `preset`）→ 不动
 */
export function applyCustomerAnswers(
  facts: SessionFacts,
  cx: CustomerExtraction,
  turn: number,
): SessionFacts {
  const elements = { ...facts.elements };

  for (const { element, quote } of cx.answered_elements) {
    const prev = elements[element];
    const st = statusOf(prev);
    if (st === 'collected') continue;
    elements[element] = {
      ...prev,
      status: 'collected',
      collected: true,
      turn,
      gotTurn: turn,
      gotQuote: quote,
      vague: false,
      // 问过才算功劳；没问过是客户自己送上门的
      source: st === 'asked_no_answer' ? 'asked' : 'volunteered',
    };
  }

  // 模糊回答（"a lot" / "depends"）不算收集到，只打个标，报告里提示需要追问确认
  for (const element of cx.vague_elements) {
    const prev = elements[element];
    if (statusOf(prev) === 'collected') continue;
    elements[element] = { ...prev, vague: true };
  }

  return stampCollectAll({ ...facts, elements }, turn);
}

/**
 * 客户主动吐出来的信息：记下来但标 volunteered，评分时不计新人功劳。
 * 保留为 `applyCustomerAnswers` 的薄封装——没有原话引文的调用方还在用它。
 */
export function markVolunteered(facts: SessionFacts, elements: SixElement[], turn: number): SessionFacts {
  return applyCustomerAnswers(
    facts,
    { answered_elements: elements.map((element) => ({ element, quote: '' })), vague_elements: [] },
    turn,
  );
}

/** 数几项六要素。传 source 只数该来源的 */
export function countCollected(facts: SessionFacts, source?: ElementSource): number {
  return SIX_ELEMENTS.filter((e) => {
    const r = facts.elements[e];
    if (statusOf(r) !== 'collected') return false;
    return source ? r.source === source : true;
  }).length;
}

/** 数「问了但客户没给」的项——报告里要点名，这是最该追问的几项 */
export function countAskedNoAnswer(facts: SessionFacts): number {
  return SIX_ELEMENTS.filter((e) => statusOf(facts.elements[e]) === 'asked_no_answer').length;
}

// ───────────────────────── 报价（L1 纯代码，100% 可靠） ─────────────────────────

export function computeTier(total: number): QuoteTier {
  if (total < QUOTE_TIER_BOUNDS.aMax) return 'A';
  if (total <= QUOTE_TIER_BOUNDS.bMax) return 'B';
  return 'C';
}

/** 格式合规（第一课 4 章）：A 可纯文字；B 至少截图；C 必须表 + 截图 */
export function isFormatCompliant(tier: QuoteTier, hasQuoteSheet: boolean, hasScreenshot: boolean): boolean {
  if (tier === 'A') return true;
  if (tier === 'B') return hasScreenshot;
  return hasQuoteSheet && hasScreenshot;
}

export interface QuoteForm {
  /** 逐个产品的报价行。至少一行（接口层校验），一行就是老的单产品报价 */
  lines: QuoteLine[];
  freight?: number;
  /** 贸易术语（FOB 深圳 / DDP 汉堡…）。报价级，不逐行填，理由见 QuoteRecord */
  tradeTerms?: string;
  /** 交期天数 */
  leadTimeDays?: number;
  hasQuoteSheet: boolean;
  hasScreenshot: boolean;
}

/**
 * 报价提交时代码做的五件事（技术方案第 6 章）：
 * 判红线① / 判档位与格式 / 比对真实数量 / 写事实表 / 生成报价消息（消息在调用方拼）
 *
 * @param realQuantity 暗牌里的真实数量。**取不到就传 null，不要传 0** ——
 *        传 0 等于宣称"这一局的真实数量是 0"，而没人会报 0 个，
 *        于是每一份报价都被判成失真（2026-08-24 修掉的那个洞）。
 *        null 表示这一局没有可对照的真实数量，这项比对整个跳过。
 */
export function submitQuote(
  facts: SessionFacts,
  form: QuoteForm,
  turn: number,
  realQuantity: number | null,
): { facts: SessionFacts; quote: QuoteRecord } {
  const freight = form.freight ?? 0;
  /**
   * ★ 档位按整份报价的总额算，不按单行 ★（2026-08-19 反馈 #6）
   * 第一课第 4 章那三档说的是"这一次报出去多少钱"。按行算的话，
   * 两个各 200 美元的产品会被判成两个 B 档，而客户实际收到的是一张 400 美元的单子——
   * 那是 C 档，要报价表 + 截图。按行算等于给拆单开了一道免检门。
   */
  const goods = form.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const total = goods + freight;
  const tier = computeTier(total);
  const first = form.lines[0]!;

  const quote: QuoteRecord = {
    turn,
    lines: form.lines,
    // 首行镜像，留给还在读平铺字段的老代码与老数据（见 QuoteRecord 注释）
    unitPrice: first.unitPrice,
    quantity: first.quantity,
    freight,
    ...(form.tradeTerms ? { tradeTerms: form.tradeTerms } : {}),
    ...(form.leadTimeDays ? { leadTimeDays: form.leadTimeDays } : {}),
    total,
    tier,
    hasQuoteSheet: form.hasQuoteSheet,
    hasScreenshot: form.hasScreenshot,
    formatCompliant: isFormatCompliant(tier, form.hasQuoteSheet, form.hasScreenshot),
    /**
     * ★ 多产品时，只要有一行报的是真实数量就不算失真 ★
     * 暗牌里的真实数量说的是**主产品**要多少。业务员同时报了别的产品，
     * 那几行本来就该是别的数——拿它们去比对，等于因为多报了一个产品而判他失真。
     * 单行时这条判据与老口径逐位相同。
     *
     * ★ 没有可对照的真实数量就不判 ★（2026-08-24）见 `readRealQuantity` 的注释：
     * 拿不到时老代码取 0，于是全库 164 份人设的每一份报价都被判成失真。
     */
    quantityMismatch: realQuantity !== null && !form.lines.some((l) => l.quantity === realQuantity),
    quantityChecked: realQuantity !== null,
    quantityConfirmed: statusOf(facts.elements.quantity) === 'collected',
  };

  const redlines: Redline[] = [...facts.redlines];
  // 红线①：事实表里数量未确认就发送报价。纯代码判定，无解释空间，可作考试硬否决
  //
  // ★ 2026-08-23 起这条才真正管用 ★ 在那之前 `collected` 是「业务员问了」就置 true，
  // 于是最典型的场景——问一句 "How many?"、客户没答、直接报价——反而不触发。
  // 三态化之后 `collected` 的含义变成「客户真的给了数量」，这条红线随之恢复正确触发。
  if (statusOf(facts.elements.quantity) !== 'collected' && !redlines.includes('R1')) redlines.push('R1');

  return { facts: { ...facts, quotes: [...facts.quotes, quote], redlines }, quote };
}

/**
 * 投递一份资料（2026-08-19 反馈 #4）。
 *
 * ★ 同一种资料重复发只记第一次 ★ 「他第几轮把目录给出去的」是判定要用的事实，
 * 发第二遍不改变这个事实。重复发本身该不该说，是点评的事，不是事实表的事。
 *
 * ★ 这里不判对错 ★ 「需求还没问清就先甩目录」由 `catalogBeforeNeeds` 规则管
 * （见 state-machine），那条规则读的是 `ext.sent_catalog`，调用方会把它置上。
 * 事实表只负责记「发生了」。
 */
export function submitDeliverable(
  facts: SessionFacts,
  kind: DeliverableKind,
  turn: number,
): SessionFacts {
  const sent = facts.deliverables ?? [];
  if (sent.some((d) => d.kind === kind)) return facts;
  return { ...facts, deliverables: [...sent, { turn, kind }] };
}

export function addRedline(facts: SessionFacts, r: Redline): SessionFacts {
  return facts.redlines.includes(r) ? facts : { ...facts, redlines: [...facts.redlines, r] };
}

export function recordUnlock(facts: SessionFacts, key: string, turn: number): SessionFacts {
  if (facts.unlockedCards.some((c) => c.key === key)) return facts;
  return { ...facts, unlockedCards: [...facts.unlockedCards, { key, turn }] };
}

// ───────────────────────── 暗牌里的真实数量（2026-08-24 修） ─────────────────────────

/**
 * ★ 这一段修的是「数据失真红线误报」★（08-19 反馈 #5）
 *
 * 业务员原话：「我们就是按照他给的数据填的……发送之后就会出现一个『数据失真』的红字。」
 * 上一轮把这条告警改得可解释了，但**没查它为什么会误报**——查下来是取数就没取到：
 *
 *   老实现只认键名里带 `quantity` 的暗牌，值只认「结尾的那串数字」。
 *   全库 167 份人设里，键名带 `quantity` 的只有 15 份，能解析出数字的只有 3 份。
 *   其余 164 份一律拿到 0，而没有人会报 0 个——**于是每一份报价都被判成数量失真**。
 *
 * 更糟的是这条判定会以「系统记录，绝对准确，你不得推翻」的名义喂进评分提示词
 * （见 `llm/score.ts`），等于每一局都先给业务员扣一顶帽子。
 *
 * ★ 新口径：拿不准就不判 ★ 拿到 0 当成"真实数量是 0"是这个洞的根源。
 * 现在取不到、或取出来有歧义，一律返回 null，`submitQuote` 不做这项比对。
 * 宁可放过一次真失真，也不能每一局都冤枉人——一个永远亮着的红灯，等于没有红灯。
 */

/** 键名里可能藏着真实数量的暗牌。全库实际用过的写法：quantity / qty / volume / 数量 */
const QUANTITY_KEY = /quantity|qty|volume|数量/i;

/**
 * 「这一单一共要多少」的明写法。★ 顺序就是优先级 ★
 * 「首单按每款 600 pcs（两款各 600，合计 1200 pcs）」——合计在前，才不会取成 600。
 */
const TOTAL_MARKERS: RegExp[] = [
  /(?:合计|总共|一共|共计|总计|共)\D{0,6}(\d+)/,
  /total\D{0,8}(\d+)/i,
  /**
   * ★ 「首单」这一条必须卡一个「是」★ 单元测试当场抓出来的：
   * 写成 `首单\D{0,10}(\d+)` 的话，「他首单在 300 套与 600 套之间纠结」会被读成 300 ——
   * 那句话的意思恰恰是**他自己还没定**，按 300 去判失真是凭空定罪。
   * 「首单是 100 pcs」「首批就是 3000」才是把数说死了的写法。
   */
  /(?:首单|首批|首次|第一单|这一单)(?:就)?是\s*(\d+)/,
];

/** 千分位逗号会把 5,000 切成 5 和 000，先抹平 */
function stripThousandSeparators(text: string): string {
  let out = text;
  for (let i = 0; i < 3; i += 1) out = out.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  return out;
}

/**
 * 从一段人写的暗牌描述里读出「真实数量」。读不准就返回 null。
 *
 * 三档判据，从严到宽：
 *   1. 有「合计 / 共 / total / 首单」这类明写法 → 取它后面那个数；
 *   2. 整段只出现一个数 → 就是它（「他要 1000 个，正好够定制起订量」）；
 *   3. 出现多个不同的数 → **有歧义，不判**（「他要 400 台，而 MOQ 是 1000」——
 *      400 和 1000 谁是他要的量，代码分不出来，那就不要替业务员定罪）。
 */
export function parseRealQuantity(text: string | undefined): number | null {
  if (!text) return null;
  const flat = stripThousandSeparators(text);

  for (const marker of TOTAL_MARKERS) {
    const hit = flat.match(marker);
    const n = Number(hit?.[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const distinct = [...new Set((flat.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))];
  return distinct.length === 1 ? distinct[0]! : null;
}

/**
 * 这一局的暗牌有没有给出可对照的真实数量。
 *
 * ★ 多张牌给出不同的数也算拿不准 ★ 同一局里两张牌各说一个数，
 * 说明这一局的"真实数量"本来就不是一个数（分款、分批、区间），不该拿来判失真。
 */
export function readRealQuantity(cards: HiddenCards | undefined): number | null {
  if (!cards) return null;
  const found = new Set<number>();
  for (const [key, card] of Object.entries(cards)) {
    if (!QUANTITY_KEY.test(key)) continue;
    const n = parseRealQuantity(card?.value);
    if (n !== null) found.add(n);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * 这一局他到底干活了没有。**「有效演习局」的第三条判据**（2026-08-28 王老师裁 D4 选项 A）。
 *
 * ★ 为什么要新加这一条 ★
 * 复盘五问从阻塞路径挪走（改成可选）之后，原来那条推理链断了：
 *
 *     出了分 ⇒ 过了 score 接口的复盘硬闸（五答未齐 409）⇒ 复盘真做了
 *
 * 有效局的定义本来是「聊满 6 轮 ＋ 出了分」，它够用全靠上面这条链兜着最后一段。
 * 链一断，有效局就退回成「聊 6 轮 ＋ 点一下评分」——正是漏洞台账 N-6 修掉的那个
 * 「三次敷衍」：各聊六句、点结束、点评分，当天的考试照样解锁，成本只是一点 token。
 *
 * ★ 为什么用暗牌和六要素来量，而不是用局分 ★
 * 这道闸的定位是**行为量，不是水平**（方案第一节：训练期"练够 3 局"只看局数不看分数）。
 * 拿局分当判据会把它变成第二道水平门槛，跟定位冲突，也会冤枉证据不足的那些局。
 * 而「他问出东西来了没有」恰好既是行为量、又敷衍不出来——
 * 解锁一张暗牌要问对措辞，问一项六要素要真的开口问。
 *
 * ★ 「问了客户没给」算数 ★ `asked_no_answer` 三态是 2026-08-19 业务员喊冤喊出来的：
 * 明明问了、客户含糊其辞，点评说他没问。那一条在评分侧已经修了，这里不许再犯一次——
 * 判据是**他开没开口**（`askedTurn`），不是他拿没拿到。
 *
 * ★ 前情已定（preset）的不算 ★ 跟进局开局就标成 collected 的那几项来源是 `preset`，
 * 既不是他的功劳也不是他的缺失。全靠它就能算"干了活"的话，跟进局会白送这道闸。
 */
export function didRealWork(facts: SessionFacts | null | undefined): boolean {
  if (!facts) return false;
  if ((facts.unlockedCards ?? []).length > 0) return true;
  return SIX_ELEMENTS.some((element) => {
    const record = facts.elements?.[element];
    if (!record) return false;
    // 他开口问了（不管客户答没答）
    if (typeof record.askedTurn === 'number') return true;
    // 老数据没有 askedTurn：退回「他问出来的」这一条
    return statusOf(record) === 'collected' && record.source === 'asked';
  });
}

/**
 * 第 `turn` 轮到底发生了什么。**轮内提示的取数口径**（2026-08-28）。
 *
 * ★ 全部从已经落库的事实表里读，不需要任何模型调用 ★
 * 暗牌解锁记在 `unlockedCards[].turn`，六要素开口记在 `elements[].askedTurn`，
 * 拿到手记在 `elements[].turn`，动作记在 `quotes[].turn` / `deliverables[].turn`。
 * 所以提示零成本、也不会因为模型抖动而时有时无——这是它敢做成"每轮都出现"的前提。
 *
 * ★ 判定本身不在这里 ★ 这里只数数，"要不要提示"在 `turn-decide.decideTurnNudge`。
 * 分层与结算那边一致：取数一个函数、判定一个函数，判定的那个才带测试和文案。
 */
export function turnActivity(
  facts: SessionFacts | null | undefined,
  turn: number,
): { unlocked: number; asked: number; collected: number; formAction: boolean } {
  if (!facts || turn <= 0) return { unlocked: 0, asked: 0, collected: 0, formAction: false };
  const unlocked = (facts.unlockedCards ?? []).filter((card) => card.turn === turn).length;
  let asked = 0;
  let collected = 0;
  for (const element of SIX_ELEMENTS) {
    const record = facts.elements?.[element];
    if (!record) continue;
    if (record.askedTurn === turn) asked += 1;
    // ★ preset 不算 ★ 跟进局前情已定的那几项 turn 是 0，本来也撞不上真实轮次，
    // 但写明白：这里数的是"这一轮新拿到的"，不是"这一轮已知的"
    if (record.source !== 'preset' && statusOf(record) === 'collected' && record.turn === turn) collected += 1;
  }
  const formAction =
    (facts.quotes ?? []).some((quote) => quote.turn === turn) ||
    (facts.deliverables ?? []).some((item) => item.turn === turn);
  return { unlocked, asked, collected, formAction };
}
