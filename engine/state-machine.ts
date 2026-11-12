/**
 * 状态机（技术方案 3.3）
 *
 * ★ 全是纯函数 ★
 * 同样的输入永远得到同样的输出，不碰数据库、不调 LLM、不读时钟、不用随机数。
 * 这是整个系统唯一能被自动化测试保障的部分，也是回放工具的基础。
 *
 * ★ 状态机永远不进 prompt ★
 * 2026-08-04/05 两次实测：让模型自己记账，它只执行得了最简单的「每轮 −5」，
 * 需要判断条件的「没抛问题就 −10」整条忘掉，离场判定一次都没触发过，
 * 还出现过 trust=145 这种越界值。这不是模型不行，是这活本来就不该交给它。
 */

import type {
  Redline,
  DrillState,
  Extraction,
  SessionFacts,
  RuleTable,
  RuleEffect,
  ExitReason,
  Directive,
  SessionType,
  QuoteRecord,
} from './types';
import { STATE_MAX, STATE_MIN, statusOf } from './types';
import { BIG_QUOTE_THRESHOLD } from './rules';

export function initialState(interest: number): DrillState {
  return { patience: 100, trust: 50, interest, turn: 0, stagnantTurns: 0 };
}

/** 三个状态值一律夹在 0–100。不 clamp 就会出现 trust=145（08-04 实测） */
export function clamp(v: number): number {
  return Math.max(STATE_MIN, Math.min(STATE_MAX, v));
}

function applyEffect(state: DrillState, e: RuleEffect): DrillState {
  return {
    ...state,
    patience: clamp(state.patience + (e.patience ?? 0)),
    trust: clamp(state.trust + (e.trust ?? 0)),
    interest: clamp(state.interest + (e.interest ?? 0)),
  };
}

/** 本轮触发了哪些规则——单独抽出来，方便测试与回放时逐条比对 */
export function matchRules(
  ext: Extraction,
  facts: SessionFacts,
  state: DrillState,
  opts: { quote?: QuoteRecord } = {},
): (keyof RuleTable)[] {
  const hits: (keyof RuleTable)[] = ['perTurnDecay'];

  if (state.turn === 0 && ext.asked_elements.length >= 0) {
    // 首轮直接回应、没干无关的事
    if (!ext.sent_catalog) hits.push('firstReplyDirect');
  }

  // 红线④：用中文作答。★ 放在最前面判 ★ 它是这一轮最重的事实——
  // 对方一个字都看不懂，后面那些"问得好不好"的判定都建立在他读得懂的前提上。
  if (ext.replied_in_chinese) hits.push('repliedInChinese');

  if (ext.has_altruistic_framing) hits.push('altruisticFraming');
  if (ext.question_type === 'choice') hits.push('choiceQuestion');
  if (ext.affirmed_customer) hits.push('affirmCustomer');
  if (ext.sent_catalog && statusOf(facts.elements.product_attr) !== 'collected') hits.push('catalogBeforeNeeds');
  if (!ext.asked_question) hits.push('noQuestionAsked');
  if (ext.is_empty_chase) hits.push('emptyChase');
  if (ext.low_investment_on_suspicion) hits.push('lowInvestmentOnSuspicion');
  if (ext.followup_has_hook) hits.push('followupWithValue');
  if (ext.contradiction_probe && state.trust < 40) hits.push('coldContradictionProbe');

  // 背调：拿错误结论当实锤去质问客户（需求 6.4）
  if (ext.cited_bg_conclusion && facts.bgInitiated && !facts.bgErrorDetected) hits.push('citedWrongBgConclusion');

  // 跟进：第一封邮件带图片/视频 → 进垃圾箱，本级作废（第一课第 8 章）
  if (ext.followup_level === '3' && ext.email_with_attachment) hits.push('firstEmailWithImage');

  const q = opts.quote;
  if (q) {
    if (statusOf(facts.elements.quantity) !== 'collected') hits.push('quoteWithoutQuantity');
    if (!facts.attributeDrilled) hits.push('quoteWithoutAttribute');
    if (q.formatCompliant) hits.push('quoteFormatCompliant');
    if (q.total > BIG_QUOTE_THRESHOLD && !q.hasQuoteSheet && !q.hasScreenshot) hits.push('onelineBigQuote');
  }

  return hits;
}

/**
 * 推进一轮状态。**纯函数**——传进来什么就算什么，不查库不猜。
 */
export function updateState(
  state: DrillState,
  ext: Extraction,
  facts: SessionFacts,
  rules: RuleTable,
  opts: { quote?: QuoteRecord; producedNewInfo?: boolean } = {},
): { state: DrillState; hits: (keyof RuleTable)[] } {
  const hits = matchRules(ext, facts, state, opts);

  let next: DrillState = { ...state, turn: state.turn + 1 };
  for (const key of hits) {
    if (key === 'exit') continue;
    next = applyEffect(next, rules[key] as RuleEffect);
  }

  const newInfo = opts.producedNewInfo ?? ext.asked_elements.length > 0;
  next.stagnantTurns = newInfo ? 0 : state.stagnantTurns + 1;

  return { state: next, hits };
}

/**
 * 本轮触发的规则里带红线的，收集出来写进事实表。
 * ★ 之前只有报价路径记了 R1，R2/R3 从未落表 ★ —— 那样红线在报告里就是空的。
 */
export function collectRedlines(hits: (keyof RuleTable)[], rules: RuleTable): Redline[] {
  const out: Redline[] = [];
  for (const key of hits) {
    if (key === 'exit') continue;
    const r = (rules[key] as RuleEffect).redline;
    if (r && !out.includes(r)) out.push(r);
  }
  return out;
}

/**
 * 离场判定。返回 null 表示继续。
 * 三条来自需求 5.2：耐心归零 / 连续 3 轮无新信息 / 探需局超 20 轮仍未报价。
 */
export function checkExit(
  state: DrillState,
  facts: SessionFacts,
  sessionType: SessionType,
  rules: RuleTable,
): ExitReason | null {
  if (state.patience <= rules.exit.patienceZero) return 'patienceZero';
  if (state.stagnantTurns >= rules.exit.stagnantTurns) return 'stagnant';
  if (sessionType === 'inquiry' && state.turn > rules.exit.maxTurns && facts.quotes.length === 0) {
    return 'maxTurns';
  }
  return null;
}

/**
 * 把状态翻译成给扮演模型的行为指令。
 * ★ 这里是「代码决定客户怎么反应，LLM 只负责说得像人话」的接缝 ★
 * prompt 里绝不出现「你自己判断还有多少耐心」这种句子。
 */
export function decideDirective(state: DrillState, opts: { chineseReceived?: boolean } = {}): Directive {
  const s = { patience: state.patience, trust: state.trust, interest: state.interest };

  /**
   * ★ 中文优先于一切语气档位 ★（红线④，2026-08-23）
   *
   * 客户是海外买家，他读不懂中文——这不是"态度差一点"，是**信息没送达**。
   * 所以不管耐心还剩多少，这一轮他只能回一句"看不懂"。
   *
   * 这条自然代价比扣分本身更有教育意义：一轮白费、耐心照常自然衰减，
   * 业务员立刻就知道下次要先点翻译。
   *
   * 唯一例外是已经走到离场：人都走了，就不必再演一次听不懂。
   */
  if (opts.chineseReceived && state.patience > 0) {
    return {
      tone: state.patience < 40 ? 'impatient' : 'shorter',
      state: s,
      chineseReceived: true,
      lines: [
        '★ 对方这一条发的是中文，你一个字都看不懂 ★',
        '只回一句意思是「抱歉，我看不懂中文，能用英文写吗」的话（例如 "Sorry, I cannot read Chinese — could you write it in English?"）。',
        '【不许回答他任何问题】——你根本不知道他问了什么。',
        '【不许猜】他想说什么，也不许顺着话题往下接。',
        '不要提供任何新信息，不要说告别的话。',
      ],
    };
  }

  if (state.patience <= 0) {
    return { tone: 'leaving', state: s, lines: ['本轮只输出 [客户已离开对话]，不再有任何文字。'] };
  }
  if (state.patience < 40) {
    return {
      tone: 'impatient',
      state: s,
      lines: [
        '回复明显变短，语气不耐烦。',
        '可以质疑对方效率，可以说 "This is taking too long."、"Can you just send me the price?"。',
        '不主动提供任何新信息。',
        '还没到离开的程度，不要说告别的话。',
      ],
    };
  }
  if (state.patience < 70) {
    return {
      tone: 'shorter',
      state: s,
      lines: ['回复变短，只答被问到的。', '不再补充任何客气话，不主动展开。'],
    };
  }
  return {
    tone: 'normal',
    state: s,
    lines: ['正常配合，回复完整，态度好。', '仍然只回答被问到的，不主动补充。'],
  };
}
