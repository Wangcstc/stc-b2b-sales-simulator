/**
 * 难度系数的读写（DB 侧）。纯函数部分在 `engine/difficulty.ts`，
 * 这里只管"当前生效的是哪个值"和"改一次留一行档"。
 *
 * ★ 为什么是一张只增不改的历史表，而不是一行配置 ★
 * 判定窗口横跨 2 个业务日、6 局。主管今天改了系数，窗口里就会同时存在
 * 两个口径的局。要把结论讲清楚，必须能回答「那一局是按哪个系数打的」——
 * 覆盖写的单行配置永远答不出这个问题。
 */

import { prisma } from './db';
import { businessDay, nextBusinessDay, BUSINESS_TIME_ZONE } from './business-day';
import { loadCompanyCalendar } from './work-calendar';
import { DIFFICULTY_BOUNDS, normalizeFactor } from '../../engine/difficulty';

/**
 * 当前生效的难度系数。
 *
 * ★ 读不到就是 1.0 ★ 表是空的（从没调过）、连不上、脏数据——一律按标准难度跑。
 * 绝不能因为读不到设置就让全队的局静默变简单或变难。
 */
export async function currentDifficultyFactor(at: Date = new Date()): Promise<number> {
  try {
    const row = await prisma.difficultyProfile.findFirst({
      where: { effectiveFrom: { lte: at } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: { factor: true },
    });
    return row ? normalizeFactor(row.factor) : DIFFICULTY_BOUNDS.default;
  } catch {
    return DIFFICULTY_BOUNDS.default;
  }
}

export interface DifficultyStatus {
  /** 今天正在用的 */
  current: number;
  /** 已经排好队、还没到生效日的那一个（没有就是 null） */
  pending: { factor: number; effectiveFrom: Date; note: string | null } | null;
  /** 最近几次变更，给教练台看 */
  history: { factor: number; effectiveFrom: Date; note: string | null; createdAt: Date; setBy: string }[];
}

export async function difficultyStatus(at: Date = new Date()): Promise<DifficultyStatus> {
  const [current, upcoming, history] = await Promise.all([
    currentDifficultyFactor(at),
    prisma.difficultyProfile.findFirst({
      where: { effectiveFrom: { gt: at } },
      orderBy: { effectiveFrom: 'asc' },
      select: { factor: true, effectiveFrom: true, note: true },
    }),
    prisma.difficultyProfile.findMany({
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { factor: true, effectiveFrom: true, note: true, createdAt: true, setBy: true },
    }),
  ]);

  return {
    current,
    pending: upcoming ? { ...upcoming, factor: normalizeFactor(upcoming.factor) } : null,
    history: history.map((h) => ({ ...h, factor: normalizeFactor(h.factor) })),
  };
}

/**
 * 下一个业务日的 00:00（上海）——新系数的生效时刻。
 *
 * ★ 为什么不是"立刻生效" ★ 与「每晚结算、次日生效」同节奏。
 * 立刻生效会让当天已经考完的人和还没考的人按两套标尺打分，
 * 而他们要放进同一个 6 局窗口里算中位数。
 */
export async function nextEffectiveFrom(at: Date = new Date()): Promise<Date> {
  const calendar = await loadCompanyCalendar();
  const day = nextBusinessDay(businessDay(at), calendar);
  // 用"上海当天 00:00"对应的 UTC 时刻。上海固定 UTC+8，无夏令时
  return new Date(`${day}T00:00:00+08:00`);
}

export interface SetDifficultyInput {
  factor: number;
  setBy: string;
  note?: string | null;
  at?: Date;
}

/** 排一次变更。只增不改——同一天改两次就是两行，最后写的那行赢（按 createdAt 排序） */
export async function scheduleDifficulty(input: SetDifficultyInput): Promise<{
  factor: number;
  effectiveFrom: Date;
}> {
  const factor = normalizeFactor(input.factor);
  const effectiveFrom = await nextEffectiveFrom(input.at ?? new Date());
  await prisma.difficultyProfile.create({
    data: { factor, effectiveFrom, setBy: input.setBy, note: input.note ?? null },
  });
  return { factor, effectiveFrom };
}

/** 生效日的人话写法，界面和审计流水共用一套措辞 */
export function effectiveFromLabel(d: Date): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    month: 'long',
    day: 'numeric',
  }).format(d);
}
