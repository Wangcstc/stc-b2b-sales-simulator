/**
 * 正式业务员的周考规则。**纯函数，不碰数据库、不读时钟。**
 *
 * ★ 2026-08-24 王老师定 ★
 * 「正式业务员每周至少考两场，也就是每周至少有 6 局的考试分数出来。
 *   这 6 局的考试分数出来之后，也同样像实习业务员那样记录在那里。」
 *
 * ★ 它和准入判定最要紧的区别：不定生死 ★
 * `admission-v11.judgeWindow` 算出来的东西会改 `User.stage`、会停掉询盘分配；
 * 这一份**只出数字**。没考满不扣任何东西，只是台账上记一笔、教练台上提一句。
 * 所以这里没有 `consecutiveFails`、没有 `stage`、没有 banner——
 * 一个字段都不许从 admission 那边抄过来，抄过来迟早会有人接上处罚逻辑。
 *
 * 文件结构照 `admission-v11.ts`：阈值集中在 WEEKLY_EXAM_CONFIG，判定是纯函数，
 * 取数与落库在 `weekly-settlement.ts`（那个才 import prisma）。
 */

import { median } from './exam';
import { weekStartOf, weekEndOf, weekdayOf } from './business-day';

/**
 * ★ 周考阈值的唯一真源 ★ 改规则改这里，别在页面上另写一份。
 *
 * 与 `ADMISSION_CONFIG` 刻意分开两份：两套规则服务两种人，
 * 合成一份的话，动实习生的门槛会顺手动到正式业务员，反过来也一样。
 */
export const WEEKLY_EXAM_CONFIG = {
  /** ★ 每周至少几场 ★ 王老师定的 2 场 */
  examsPerWeek: 2,
  /** 一场几局。与 ADMISSION_CONFIG.sessionsPerExam 对齐，两条轨共用同一套开考流程 */
  sessionsPerExam: 3,
  /** 一周该出几局分 = examsPerWeek × sessionsPerExam */
  sessionsPerWeek: 6,
  /**
   * 中位数参考线（D4 下沿，与准入同一把尺）。
   * ★ 只展示，不处罚 ★ 摆出来是让他知道自己在哪一档，不是门槛。
   */
  medianScoreMin: 65,
  /** 周表往回看几周 */
  ledgerWeeks: 8,
} as const;

export interface WeekSession {
  sessionId: string;
  /** 这一局所属的上海业务日 */
  businessDay: string;
  type: 'INQUIRY' | 'FOLLOWUP';
  /** 拿到精确分才算数。证据不足的局照样陈列，但不进中位数 */
  precise: boolean;
  rawScore: number | null;
}

export interface WeekVerdict {
  /** 周一 */
  weekStart: string;
  /** 周日 */
  weekEnd: string;
  /** 本周开了几场（按业务日去重——每天最多 1 场） */
  examCount: number;
  /** 本周考试局总数 */
  sampleCount: number;
  /** 其中拿到精确分的局数 */
  preciseCount: number;
  /** 精确分的中位数。一局都没有时为 null，**不许写 0** */
  medianScore: number | null;
  /**
   * 本周考够没有。
   * ★ 三态 ★ true=够了；false=这一周已经过完但没考够；
   * null=**这一周还没过完**，现在下结论等于提前判人缺考。
   */
  met: boolean | null;
  /** 还差几场。已达标为 0 */
  examGap: number;
  /** 还差几局出分。已达标为 0 */
  sessionGap: number;
  /** 中位数够不够参考线。样本不足时为 null */
  scoreOk: boolean | null;
  /** 面板直接渲染的人话 */
  detail: string;
  /** 本周考了哪几天，从旧到新 */
  examDays: string[];
}

/** 这一周过完了没有：asOfDay 已经走过这一周的周日 */
export function weekIsOver(weekStart: string, asOfDay: string): boolean {
  return asOfDay > weekEndOf(weekStart);
}

/**
 * 判一周。
 *
 * @param sessionsNewestFirst 这个人的**考试局**，从新到旧。演习局不要传进来——
 *   「考核与学习分离」是定死的规则（优化需求梳理 6.2(1)）：练习局一律不计入统计。
 * @param weekStart 这一周的周一。用 `weekStartOf()` 求。
 * @param asOfDay 算到哪一天。决定 `met` 是不是还能是 null。
 *
 * ★ 场次按业务日去重，不数 ExamAttempt ★ 一场考试 = 一个业务日的 3 局，
 * 数据库那道 `@@unique([userId, businessDay, attemptType])` 已经保证了每天最多一场。
 * 这里数「有局的天数」而不是数场次记录，是因为跨天作废（EXPIRED）的场次
 * 仍然可能留下已出分的局——**局在分就在，一局都不该浪费**，那天就该算他考过。
 */
export function judgeWeek(
  sessionsNewestFirst: WeekSession[],
  weekStart: string,
  asOfDay: string,
): WeekVerdict {
  const weekEnd = weekEndOf(weekStart);
  const inWeek = sessionsNewestFirst.filter(
    (session) => session.businessDay >= weekStart && session.businessDay <= weekEnd,
  );

  const examDays = [...new Set(inWeek.map((session) => session.businessDay))].sort();
  const examCount = examDays.length;
  const sampleCount = inWeek.length;
  const precise = inWeek.filter((session) => session.precise && typeof session.rawScore === 'number');
  const preciseCount = precise.length;
  const medianScore =
    preciseCount > 0 ? median(precise.map((session) => session.rawScore as number)) : null;

  const examGap = Math.max(0, WEEKLY_EXAM_CONFIG.examsPerWeek - examCount);
  const sessionGap = Math.max(0, WEEKLY_EXAM_CONFIG.sessionsPerWeek - preciseCount);
  const enough = examGap === 0 && sessionGap === 0;

  const over = weekIsOver(weekStart, asOfDay);
  // ★ 周中不下结论 ★ 周三考了 1 场就说他「没考够」，是拿没到期的账催人
  const met: boolean | null = enough ? true : over ? false : null;

  const scoreOk = medianScore === null ? null : medianScore >= WEEKLY_EXAM_CONFIG.medianScoreMin;

  return {
    weekStart,
    weekEnd,
    examCount,
    sampleCount,
    preciseCount,
    medianScore,
    met,
    examGap,
    sessionGap,
    scoreOk,
    detail: detailTextOf({ examCount, preciseCount, medianScore, examGap, sessionGap, met, over }),
    examDays,
  };
}

/**
 * 「还差多少」那句话。
 *
 * ★ 未达标必须带距离 ★ 只说「未达标」等于让人自己去数——
 * 和准入面板 `activeGateText` 同一条规矩。
 */
function detailTextOf(input: {
  examCount: number;
  preciseCount: number;
  medianScore: number | null;
  examGap: number;
  sessionGap: number;
  met: boolean | null;
  over: boolean;
}): string {
  const { examsPerWeek, sessionsPerWeek } = WEEKLY_EXAM_CONFIG;
  const head = `本周已考 ${input.examCount}/${examsPerWeek} 场 · 已出分 ${input.preciseCount}/${sessionsPerWeek} 局`;
  const scoreText =
    input.medianScore === null ? '还没有出分的局，暂不显示中位数' : `中位数 ${fmt(input.medianScore)} 分`;

  if (input.met === true) return `${head}；${scoreText}。本周的考试要求已经完成。`;
  if (input.met === false) {
    const gap =
      input.examGap > 0
        ? `这一周还差 ${input.examGap} 场没考`
        : `场次够了，但只有 ${input.preciseCount}/${sessionsPerWeek} 局出了分`;
    return `${head}；${scoreText}。这一周已经过完——${gap}。`;
  }
  const todo =
    input.examGap > 0 ? `这周还要再考 ${input.examGap} 场` : `场次够了，还差 ${input.sessionGap} 局出分`;
  return `${head}；${scoreText}。${todo}。`;
}

/** 版头那一格：「68 分 · 本周 6/6 局」。样本不齐时必须把分母摆出来 */
export function weekMedianLabel(verdict: WeekVerdict): string {
  const W = WEEKLY_EXAM_CONFIG.sessionsPerWeek;
  if (verdict.medianScore === null) return `— · 本周 ${verdict.preciseCount}/${W} 局`;
  return `${fmt(verdict.medianScore)} 分 · 本周 ${verdict.preciseCount}/${W} 局`;
}

/**
 * 一行状态。教练台和训练台共用，两处口径就不会飘。
 *
 * ★ 差多少，要按「差在哪一头」说 ★ 场次够了但有局没出分时 examGap 是 0，
 * 原来周中那一支只认 examGap，于是屏上会写「进行中 · 还差 0 场」——
 * 一句自相矛盾的话。差的单位跟着缺口走：缺场说场，缺出分说局。
 */
export function weekStatusLine(verdict: WeekVerdict): string {
  if (verdict.met === true) return '本周已考满';
  const gap = verdict.examGap > 0 ? `${verdict.examGap} 场` : `${verdict.sessionGap} 局出分`;
  if (verdict.met === false) return `未考满 · 差 ${gap}`;
  return `进行中 · 还差 ${gap}`;
}

/** 「8月24日 – 8月30日」。周表那一列 */
export function weekRangeText(weekStart: string): string {
  const short = (day: string) => {
    const [, month, date] = day.split('-') as [string, string, string];
    return `${Number(month)}月${Number(date)}日`;
  };
  return `${short(weekStart)} – ${short(weekEndOf(weekStart))}`;
}

/** 一位小数，整数不带小数点。中位数可能是 x.5 */
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export { weekStartOf, weekEndOf, weekdayOf };
