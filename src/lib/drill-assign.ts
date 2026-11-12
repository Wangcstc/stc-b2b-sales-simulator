/**
 * 演习派单的**判定内核**：今天该练哪个考点（2026-08-28 第四批）
 *
 * ★ 它替掉的是什么 ★
 * 原来的排序是「这个**考点**练得最少、最久没练」优先。那既不是刻意练习
 * （跟他弱在哪毫无关系），也不是间隔重复（"最久没练"是**倒序**，练过的考点
 * 越往后越不回来）。它实现的是**平均覆盖**——三种目标里最没用的一种：
 * 一个洞察力长期 2 分的人，和一个洞察力 4 分但闭环力 1 分的人，拿到的是同一套题。
 *
 * ★ 三项加权 ★
 *   优先级 ＝ 弱项分 × 0.40 ＋ 到期分 × 0.35 ＋ 新鲜分 × 0.25
 *
 * ★ 「弱项」用的是**他在这个考点上的历史局分**，不是七力→考点的映射 ★
 * 这一条是查了数据之后改的设计。库里 32 个骨架的 `activeForces` 实测分布：
 *
 *   insight / guidance / solution / trust / closing —— **32 个考点全都主考**（完全不区分）
 *   stability —— 18 个考点        negotiation —— 11 个考点
 *
 * 也就是说「七力最低项 → 该练哪个考点」这条映射，对七力里的五力**给不出任何信息**：
 * 无论他哪一力最弱，命中的都是全部 32 个考点。硬按它派题，等于随机派题还多写一层。
 * 真正带信息量的是**他自己在这个考点上考成什么样**——那是逐考点、逐个人的实测，
 * 不需要任何映射表。七力只在两处仍然有用，都保留了：
 *   ① 最弱的是 negotiation 或 stability 时，优先那 11 / 18 个考点（`forceFocus`）；
 *   ② 探需局洞察力权重 0.30、跟进局 0.25，跟进局博弈力 0.10、探需局 0.05——
 *      弱项不同，该多练哪种局型也不同（`preferSessionType`）。
 *
 * ★ 间隔重复：Leitner 五盒，进位线 65 ★（王老师裁 D5 选项 A）
 * 用准入线本身当进位线，全系统一个数，好解释：
 * 「你在这个考点上打到准入水平了，它就往后排。」
 *
 * ★ 复习时换一个变体，不换考点 ★ 这是整套设计的支点，也正好是这个仓库的骨架/变体
 * 结构天生支持的：肌肉记忆要的是**同一个考点反复**，防背题要的是**不同化身**。
 * 两个需求在别的系统里打架，在这里天然兼容——「同一骨架的另一个化身」这句话
 * 本来就是为这个写的，只是一直没人拿它做复习。
 *
 * ★ 只作用于演习派单，绝不碰考试选题 ★ 考试要的是随机不可预测，
 * 复习要的是按时回来。把「按时回来」接进考试选题，等于告诉考生明天考什么。
 *
 * 这个文件是纯函数：不碰数据库、不读时钟。喂什么判什么，好测。
 */

import type { Force, SessionType } from '../../engine/types';

/* ═══════════════════ Leitner 五盒 ═══════════════════ */

/**
 * 盒号 → 下次复习的间隔（自然日）。
 *
 * ★ 为什么用自然日不用业务日 ★ 间隔重复对付的是**记忆衰退**，那件事在周末照样发生。
 * 用业务日会让一个跨了长假的间隔实际拉到三周，而盒子以为只过了 3 天。
 * （判定窗口那边用业务日是另一回事：那管的是"该不该记他缺考"。）
 */
export const LEITNER_INTERVALS = [1, 3, 7, 21, 60] as const;
export const MAX_BOX = LEITNER_INTERVALS.length;

/**
 * 进位线。★ 用准入线本身 ★（王老师裁 D5 选项 A）
 * 全系统一个数，对业务员好解释：打到准入水平，这个考点就往后排。
 */
export const PASS_SCORE = 65;

/** 盒号对应的间隔天数。越界一律夹回合法范围 */
export function intervalOf(box: number): number {
  const idx = Math.min(MAX_BOX, Math.max(1, Math.round(box))) - 1;
  return LEITNER_INTERVALS[idx]!;
}

/**
 * 打完一局之后，这个考点进哪个盒。
 *
 * ★ 退位退一格，不是退到底 ★ 一次失手把 21 天的进度清零，人会觉得白练了；
 * 而退一格既承认了这次没过，又保住了之前的积累。第 1 盒失败就留在第 1 盒。
 *
 * ★ 没出精确分的局不动盒子 ★ 证据不足不是学员的错（与判定那边同一条原则），
 * 拿它退位就是冤枉人。传 null 表示"这一局没有可用的分"。
 */
export function leitnerNext(box: number, score: number | null): number {
  const current = Math.min(MAX_BOX, Math.max(1, Math.round(box)));
  if (score === null) return current;
  if (score >= PASS_SCORE) return Math.min(MAX_BOX, current + 1);
  return Math.max(1, current - 1);
}

/* ═══════════════════ 一个考点在某人身上的状态 ═══════════════════ */

export interface MasteryState {
  /** 考点编号（`Persona.code`） */
  code: string;
  /** 1–5。没练过的考点不进这张表 */
  box: number;
  /** 上一次练这个考点是哪一天（YYYY-MM-DD） */
  lastDay: string;
  /** 上一次的局分。证据不足为 null */
  lastScore: number | null;
  /** 这个考点一共练过几局 */
  plays: number;
}

/** `YYYY-MM-DD` 相差几天。★ 纯字符串算术，不读时钟 ★ */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/* ═══════════════════ 三项分 ═══════════════════ */

export const ASSIGN_WEIGHTS = { weak: 0.4, due: 0.35, fresh: 0.25 } as const;

/** 七力权重差异带来的局型偏好。真源是 `engine/rules.pickWeights`，这里只取方向 */
const FORCE_PREFERS: Partial<Record<Force, SessionType>> = {
  insight: 'inquiry', // 探需 0.30 > 跟进 0.25
  guidance: 'inquiry', // 0.20 > 0.15
  solution: 'followup', // 0.20 > 0.15
  negotiation: 'followup', // 0.10 > 0.05
};

export interface CandidateInput {
  /** 这个考点主考哪几力（`Persona.activeForces`） */
  activeForces: readonly string[];
  sessionType: SessionType;
  /** 他在这个考点上的状态。undefined ＝ 没练过 */
  mastery?: MasteryState;
}

export interface PriorityInput {
  today: string;
  /**
   * 他最近若干局里最弱的那一力。null ＝ 样本不够，别猜。
   * ★ 只有 negotiation / stability 能区分考点 ★ 其余五力全部 32 个考点都主考，
   * 拿它们做筛选等于没筛——所以 `forceFocus` 只对这两力生效，理由见文件头。
   */
  weakestForce: Force | null;
}

export interface PriorityBreakdown {
  total: number;
  parts: { weak: number; due: number; fresh: number };
  /** 界面上要说得出「为什么今天派这一封」。空串＝没有特别理由，按覆盖派的 */
  reason: string;
}

/**
 * 一个考点今天有多该练。返回 0–1。
 *
 * ★ 三项都归一化到 0–1 再加权 ★ 免得某一项量纲失控把总分带跑，
 * 与机制难度指数同一条做法。
 */
export function personaPriority(candidate: CandidateInput, input: PriorityInput): PriorityBreakdown {
  const mastery = candidate.mastery;

  /* ── 新鲜分：没碰过的考点 ── */
  const fresh = !mastery || mastery.plays === 0 ? 1 : 0;

  /* ── 弱项分 ── */
  let weak = 0;
  let scoreReason = '';
  if (mastery && mastery.lastScore !== null) {
    // 离准入线差多少，差得越多越该练。已经过线的一律 0
    weak = Math.min(1, Math.max(0, (PASS_SCORE - mastery.lastScore) / PASS_SCORE));
    if (weak > 0) {
      scoreReason = `上次这个考点 ${mastery.lastScore} 分，离 ${PASS_SCORE} 还差 ${PASS_SCORE - mastery.lastScore}`;
    }
  }

  /**
   * ★ 七力侧的加成分两种，强弱差一个数量级，别混 ★
   *
   * ① `forceFocus`（+0.5）——「这个考点主考你最弱的那一力」。**只对 negotiation
   *    与 stability 生效**：其余五力 32 个考点全都主考，拿它们筛等于没筛，
   *    给了加成反而会让"定向"看起来在工作、其实是随机（理由见文件头）。
   * ② 局型偏好（+0.15）——权重差带来的方向：探需局洞察力 0.30 / 跟进 0.25，
   *    跟进局博弈力 0.10 / 探需 0.05。这一条**对通用力也成立**，因为它区分的是
   *    局型不是考点，信息是真的。但它只值一点点，不该喧宾夺主，也不配单独当理由。
   */
  const focusForce = input.weakestForce;
  const forceFocus =
    (focusForce === 'negotiation' || focusForce === 'stability') && candidate.activeForces.includes(focusForce);
  if (forceFocus) weak = Math.min(1, weak + 0.5);
  if (focusForce && FORCE_PREFERS[focusForce] === candidate.sessionType) weak = Math.min(1, weak + 0.15);

  /* ── 到期分：间隔重复 ── */
  let due = 0;
  let dueReason = '';
  if (mastery && mastery.plays > 0) {
    const interval = intervalOf(mastery.box);
    const elapsed = daysBetween(mastery.lastDay, input.today);
    // 到期当天记 1，越拖越高但封顶；没到期是 0（不是负数——负数会把总分拉花）
    due = elapsed >= interval ? Math.min(1, 1 + (elapsed - interval) / (interval * 2)) : 0;
    if (due > 0) dueReason = `第 ${mastery.box} 盒该复习了（上次 ${mastery.lastDay}，间隔 ${interval} 天）`;
  }

  /**
   * ★ 理由按「信息量」排，不按计算顺序排 ★
   * 第一版按计算顺序取第一条，于是一个「你最弱的是博弈力、这个考点正好主考它」
   * 的考点，界面上显示的却是「这个考点还没练过」——把最有用的那句话盖掉了。
   * 顺序：主考你的弱项力 > 上次分低 > 该复习了 > 还没练过。
   */
  const reason =
    (forceFocus ? `你最弱的是${focusForce === 'negotiation' ? '博弈力' : '稳定力'}，这个考点正好主考它` : '') ||
    scoreReason ||
    dueReason ||
    (fresh === 1 ? '这个考点还没练过' : '');

  const total = ASSIGN_WEIGHTS.weak * weak + ASSIGN_WEIGHTS.due * due + ASSIGN_WEIGHTS.fresh * fresh;
  return { total, parts: { weak, due, fresh }, reason };
}

/**
 * 从最近的局里挑出最弱的那一力。
 *
 * ★ 样本不够就返回 null，不猜 ★ 一两局打出来的"最弱项"多半是噪音，
 * 拿它去定向派题，会把一个偶然失手放大成一整周的训练方向。
 *
 * @param forceScores 最近若干局的七力分。每一项是一局的 { force: 分 }，
 *                    只含数值分（`INSUFFICIENT` 的维度请在调用前剔掉）
 */
export function weakestForceOf(
  forceScores: readonly Partial<Record<Force, number>>[],
  minSamples = 3,
): Force | null {
  if (forceScores.length < minSamples) return null;
  const sum = new Map<Force, { total: number; n: number }>();
  for (const row of forceScores) {
    for (const [force, score] of Object.entries(row) as [Force, number][]) {
      if (typeof score !== 'number') continue;
      const cur = sum.get(force) ?? { total: 0, n: 0 };
      cur.total += score;
      cur.n += 1;
      sum.set(force, cur);
    }
  }
  let worst: Force | null = null;
  let worstAvg = Infinity;
  for (const [force, { total, n }] of sum) {
    // 一力至少要有 minSamples 个样本才算数，否则"只评过一次的力"永远是最弱的
    if (n < minSamples) continue;
    const avg = total / n;
    if (avg < worstAvg) {
      worstAvg = avg;
      worst = force;
    }
  }
  return worst;
}
