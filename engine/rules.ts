/**
 * 规则表（技术方案 3.4）
 *
 * ★ 规则不写死在逻辑里 ★
 * 调参时只改这张表，跑一遍测试就能看到影响，不需要真人聊一局。
 * 配合回放工具（步骤 47）可以对历史局批量重放，看结局变化。
 *
 * ★ 这些数值是拍脑袋的初值，不是真理 ★
 * 需求 5.2 给的是相对关系（裸报价最重、空催次重），绝对值要靠回放调。
 * 不许在别处硬编码同样的数字——发现哪里写死了，搬回这张表。
 */

import type { RuleTable, Force, SessionType, Redline } from './types';

export const DEFAULT_RULES: RuleTable = {
  // ── 加分 ──
  firstReplyDirect: { trust: +10 },
  altruisticFraming: { trust: +15 },
  choiceQuestion: { patience: +5 },
  affirmCustomer: { trust: +10 },
  quoteFormatCompliant: { trust: +15 },
  followupWithValue: { patience: +10 },

  // ── 扣分 ──
  quoteWithoutQuantity: { trust: -30, redline: 'R1' },
  lowInvestmentOnSuspicion: { interest: -40, redline: 'R2' },
  emptyChase: { patience: -25, redline: 'R3' },
  quoteWithoutAttribute: { patience: -20 },
  catalogBeforeNeeds: { interest: -20 },
  noQuestionAsked: { patience: -10 },
  onelineBigQuote: { trust: -25 },
  coldContradictionProbe: { trust: -20 },
  /// 拿错误的背调结论当实锤去质问客户 → 客户困惑（需求 6.4）
  citedWrongBgConclusion: { trust: -20 },
  /// 第一封开发信带图片/视频 → 判进垃圾箱，本级跟进作废（第一课第 8 章）
  firstEmailWithImage: { patience: -10 },
  /**
   * 红线④：直接用中文作答（王老师 2026-08-23 加）
   *
   * 课堂原话：「有一点不能用中文回答。这里有翻译功能，你必须先写中文，
   * 可以先翻译过来再发出去。」
   *
   * 扣两头是有意的：**信任**掉，是因为对方收到一条读不懂的消息；
   * **耐心**掉，是因为这一轮等于白等——他还得再问你一次。
   * 数值定在 R3（空催 -25）与「大额报价只回一行字」（-25）之间那一档：
   * 比空催轻——空催是不动脑子，发中文往往只是忘了点翻译；
   * 但比「没抛问题」重得多——客户是真的一个字都看不懂。
   */
  repliedInChinese: { trust: -20, patience: -10, redline: 'R4' },

  // ── 自然衰减 ──
  perTurnDecay: { patience: -5 },

  // ── 离场 ──
  exit: { patienceZero: 0, stagnantTurns: 3, maxTurns: 20 },
};

/**
 * 红线判定可靠性（需求 8.3 / 技术方案三层判定表）
 *
 * ★ 判不准的东西不许伪装成客观 ★ 三条红线的判定来源根本不同：
 *   R1 数量未确认即报价 —— L1 纯代码（读事实表 + 报价表单字段），100% 可靠 → 可直接否决
 *   R3 空催           —— L2 结构化抽取（规则初筛 + LLM 确认），高但非满 → 须复核
 *   R2 疑罪从有        —— L3 自由评分（行为信号 + LLM 判定），中 → 须复核
 *
 * 把 R2/R3 也写成 `if (redline) 不通过` 是假精确：模型把一句正常跟进读成空催，
 * 新人的上岗资格就没了。所以它们**不产生否决效力**（需求 8.3、计划执行方案硬约束③）。
 *
 * ★ 2026-08-24 王老师裁定：人工裁定整个取消 ★
 * 原设计是「R2/R3 排队等主管看对话原文，裁定成立才生效」。这条路 2026-08-21 就名存实亡——
 * 红线退出准入判定之后，裁不裁都不改变任何人的资格，面板当天从教练台下架；
 * 08-24 连接口与组件一起删了。现在的实际口径是：
 *   · R1 / R4（**代码**判的，不是模型判的）→ 直接生效，将来若重新启用红线闸门也能当场否决
 *   · R2 / R3（**模型**判的）→ 永远停在「已触发、未经人工确认」这一档，
 *     只进报告与客户情绪值，不可能变成生效红线——`splitRedlines` 要看到 CONFIRMED 才算，
 *     而已经没有任何入口能写 CONFIRMED 了
 *
 * ★ 代价写在这儿，别装作没有 ★ R2/R3 的误报从此没人能翻案。
 * 能接受，是因为它们本来就不判生死——判错一次的代价是报告里一句话说重了，
 * 不是一个人的上岗资格。哪天要把 'redline' 塞回 `activeGates`，**先回来读这一段**：
 * 那时能否决人的只有 R1/R4，R2/R3 依然否决不了任何人。
 *
 * ★ 只约束考试 ★ 演习模式照常扣分、照常写进报告——演习本来就没有"通过"这回事，
 * 扣分是给人看的反馈，不是判决，不需要复核。
 */
export const REDLINE_RELIABILITY = {
  R1: 'hard',
  /// 'review' 现在的含义是「模型判的，只作反馈」——已经没有「复核」这个动作了
  R2: 'review',
  R3: 'review',
  /// R4 用中文作答 —— L1 纯代码（CJK 正则），100% 可靠，无解释空间 → 不进复核队列
  R4: 'hard',
} as const satisfies Record<Redline, 'hard' | 'review'>;

/** 这条红线能否单独把考试判死 */
export function isHardRedline(r: string): boolean {
  return REDLINE_RELIABILITY[r as Redline] === 'hard';
}

/** 报价金额分档（第一课第 4 章）。单位 USD */
export const QUOTE_TIER_BOUNDS = { aMax: 100, bMax: 300 } as const;

/** 大额订单阈值——超过这个金额只回一行字要扣信任 */
export const BIG_QUOTE_THRESHOLD = 300;

/**
 * 动作类按钮之后，业务员还能再说几句话客户才回（2026-08-19 反馈 #7）。
 *
 * ★ 取 1，因为王铖的原话就是一句 ★「客户先不要回复，等业务员再讲一句话后再回复。」
 * 文档里写的是「1 条（或 N 条，建议可配置）」，所以做成配置项而不是写死的 if。
 *
 * ★ 调大意味着什么 ★ 改成 2，业务员报完价可以连说两句客户才开口。
 * 别往上乱调：真实客户不会一直等着听，窗口开太大等于在训练"自说自话"。
 * 调成 0 ＝ 关掉这个机制，回到 2026-08-23 之前"报完价客户立刻回"的老行为。
 */
export const SUPPLEMENT_TURNS = 1;

// ───────────────────────── 权重（需求 9.2） ─────────────────────────

/** 探需局权重 */
export const INQUIRY_WEIGHTS: Record<Force, number> = {
  insight: 0.3,
  guidance: 0.2,
  solution: 0.15,
  trust: 0.1,
  closing: 0.1,
  negotiation: 0.05,
  stability: 0.1,
};

/** 跟进局用通用权重，局型标签＝沉默激活 */
export const FOLLOWUP_WEIGHTS: Record<Force, number> = {
  insight: 0.25,
  solution: 0.2,
  guidance: 0.15,
  trust: 0.1,
  closing: 0.1,
  stability: 0.1,
  negotiation: 0.1,
};

export function pickWeights(sessionType: SessionType): Record<Force, number> {
  return sessionType === 'followup' ? FOLLOWUP_WEIGHTS : INQUIRY_WEIGHTS;
}

/** v6.0 双门槛：覆盖率 ≥0.60 且 可评维度 ≥4，否则拒绝出精确分 */
export const DUAL_THRESHOLD = { minCoverage: 0.6, minCount: 4 } as const;

/** 演习段位分档（需求 9.5）。D 与 L 同引擎、同锚点、同阈值，不同池子 */
export const DRILL_TIERS = [
  { tier: 'D1', name: '起步期', min: 0, max: 24 },
  { tier: 'D2', name: '成长期', min: 25, max: 49 },
  { tier: 'D3', name: '熟练期', min: 50, max: 64 },
  { tier: 'D4', name: '进阶期', min: 65, max: 79 },
  { tier: 'D5', name: '专家期', min: 80, max: 100 },
] as const;

/** 红旗阈值（需求 9.6） */
export const FLAG_THRESHOLD = { minScore: 60 } as const;
