/**
 * 周考的取数与落库。**纯判定在 `weekly-exam.ts`，这个文件才 import prisma。**
 *
 * 结构照着 `settlement.ts`：现算（preview）给界面用，upsert 给结算用，
 * catchUp 幂等补算挂在读路径上兜底，settleAll 给定时任务用。
 *
 * ★ 和准入结算最要紧的区别：这里一个字段都不改 User ★
 * `settlement.ts` 会写 `User.stage`、写 `AccessDecision`、停掉询盘分配；
 * 这个文件只写 `WeeklyExamRecord` 一张表。正式业务员没考满不扣任何东西——
 * 2026-08-24 王老师裁定：「只记录 + 教练台提醒，无任何处罚」。
 */

import { prisma } from './db';
import { businessDay, weekStartOf, weekEndOf, recentWeekStarts } from './business-day';
import {
  WEEKLY_EXAM_CONFIG,
  judgeWeek,
  weekIsOver,
  type WeekSession,
  type WeekVerdict,
} from './weekly-exam';

/**
 * 往回捞几局。
 * ★ 要够覆盖 ledgerWeeks 周 ★ 一周最多 6 局（每天 1 场 × 3 局 × 但只需 2 场），
 * 按每周上限 5 个工作日 × 3 局 = 15 局算，8 周就是 120 局。取 200 留足余量：
 * 捞少了最老那几周会算成「没考」，而那是假的。
 */
const LOOKBACK_SESSIONS = 200;

/** 正式业务员的 where。★ 两个字段一起判 ★ 与 examTrackOf('WEEKLY') 同一口径 */
const REGULAR_WHERE = {
  employeeType: 'REGULAR',
  participationMode: 'WEEKLY_EXAM',
  disabledAt: null,
} as const;

/**
 * 捞这个人的考试局，转成周考证据。
 *
 * ★ 只认 ADMISSION_EXAM ★ 与 `settlement.loadWindowSessions` 同一条口径：
 * 演习局（DRILL）一局都不进来。
 * 「考核与学习分离，练习局一律不计入统计」——优化需求梳理 6.2(1) 已经定死。
 *
 * ★ 正式业务员的考试局也是 ADMISSION_EXAM ★ 2026-08-24 起两条轨复用同一个题池，
 * 所以这里的 mode 过滤对两种人都成立；分流靠的是调用方只对 REGULAR 调它。
 */
export async function loadWeekSessions(
  userId: string,
  take: number = LOOKBACK_SESSIONS,
): Promise<WeekSession[]> {
  const sessions = await prisma.session.findMany({
    where: { userId, mode: 'ADMISSION_EXAM', score: { isNot: null } },
    orderBy: [{ endedAt: 'desc' }, { createdAt: 'desc' }],
    take,
    include: { score: true, variant: { include: { persona: true } } },
  });

  return sessions.map(
    (session) =>
      ({
        sessionId: session.id,
        businessDay: businessDay(session.endedAt ?? session.createdAt),
        type: session.variant.persona.sessionType as 'INQUIRY' | 'FOLLOWUP',
        precise: session.score?.precise ?? false,
        rawScore: session.score?.rawScore ?? null,
      }) satisfies WeekSession,
  );
}

/**
 * 界面用：本周的实时进度。**只用于显示，不改任何库里的状态**
 *
 * 对应实习业务员那边的 `previewWindow`。版头「考试中位数」那一格、
 * 首页周考卡、训练台的本周进度卡，全部读它——三处读同一个函数，口径就不会飘。
 */
export async function previewWeek(userId: string, today: string = businessDay()): Promise<WeekVerdict> {
  const sessions = await loadWeekSessions(userId);
  return judgeWeek(sessions, weekStartOf(today), today);
}

/**
 * 落一条周记录。幂等——同一周反复算，永远只有一行（靠 @@unique([userId, weekStart])）。
 *
 * @param sessions 已经捞好的局。批量结算时传进来，省得一周一次往返。
 */
export async function upsertWeekRecord(
  userId: string,
  weekStart: string,
  today: string = businessDay(),
  sessions?: WeekSession[],
): Promise<WeekVerdict> {
  const all = sessions ?? (await loadWeekSessions(userId));
  const verdict = judgeWeek(all, weekStart, today);

  const weekEnd = weekEndOf(weekStart);
  const sessionIds = all
    .filter((session) => session.businessDay >= weekStart && session.businessDay <= weekEnd)
    .map((session) => session.sessionId);

  const data = {
    weekEnd,
    sessionIds,
    examCount: verdict.examCount,
    sampleCount: verdict.sampleCount,
    preciseCount: verdict.preciseCount,
    medianScore: verdict.medianScore,
    met: verdict.met,
    detail: {
      text: verdict.detail,
      examDays: verdict.examDays,
      examGap: verdict.examGap,
      sessionGap: verdict.sessionGap,
      scoreOk: verdict.scoreOk,
      /** 留档时用的是哪套阈值。改过门槛之后要答得出「那一周是按几场算的」 */
      config: {
        examsPerWeek: WEEKLY_EXAM_CONFIG.examsPerWeek,
        sessionsPerWeek: WEEKLY_EXAM_CONFIG.sessionsPerWeek,
        medianScoreMin: WEEKLY_EXAM_CONFIG.medianScoreMin,
      },
    },
  };

  await prisma.weeklyExamRecord.upsert({
    where: { userId_weekStart: { userId, weekStart } },
    create: { userId, weekStart, ...data },
    update: data,
  });

  return verdict;
}

/**
 * 幂等补算最近几周。挂在读路径上兜底——定时任务哪天没跑，
 * 业务员一开页面就把账补上，不必等主管发现。
 *
 * ★ 每次都把本周也重算一遍 ★ 本周是活的：今天考完一场，这一行的场次就该 +1。
 */
export async function catchUpWeeks(userId: string, today: string = businessDay()): Promise<void> {
  const sessions = await loadWeekSessions(userId);
  const weeks = recentWeekStarts(WEEKLY_EXAM_CONFIG.ledgerWeeks, today);
  for (const weekStart of weeks) {
    await upsertWeekRecord(userId, weekStart, today, sessions);
  }
}

/** 近 N 周的留档，新到旧。周表读它 */
export async function loadWeekRecords(userId: string, weeks: number = WEEKLY_EXAM_CONFIG.ledgerWeeks) {
  return prisma.weeklyExamRecord.findMany({
    where: { userId },
    orderBy: { weekStart: 'desc' },
    take: weeks,
  });
}

/**
 * 定时任务入口。挂在现有的每晚那趟结算 cron 上，**不加第二个 cron**。
 *
 * 每晚都 upsert 最近几周：本周滚动更新，周一那趟顺带把上一周封板成 met=true/false
 * （`weekIsOver` 一到就不再是 null）。
 */
export async function settleAllRegulars(
  today: string = businessDay(),
): Promise<{ userId: string; ok: boolean; error?: string }[]> {
  const users = await prisma.user.findMany({ where: REGULAR_WHERE, select: { id: true } });
  const results: { userId: string; ok: boolean; error?: string }[] = [];
  for (const user of users) {
    try {
      await catchUpWeeks(user.id, today);
      results.push({ userId: user.id, ok: true });
    } catch (error) {
      // 一个人算炸了不该拖垮整趟——和 settleAllInterns 同一种兜底
      results.push({ userId: user.id, ok: false, error: (error as Error).message });
    }
  }
  return results;
}

/**
 * 教练台用：全体正式业务员的本周进度，一人一行。
 *
 * ★ 现算，不读留档 ★ 「今天这一行」必须是此刻算出来的——
 * 教练台那边的今日判定也是这个规矩：刚考完的局要立刻算进去。
 */
export async function loadRegularWeekRows(today: string = businessDay()): Promise<
  Array<{ userId: string; name: string; code: string; verdict: WeekVerdict }>
> {
  const users = await prisma.user.findMany({
    where: REGULAR_WHERE,
    select: { id: true, name: true, code: true },
    orderBy: { createdAt: 'asc' },
  });
  const weekStart = weekStartOf(today);
  const rows = [];
  for (const user of users) {
    const sessions = await loadWeekSessions(user.id);
    rows.push({
      userId: user.id,
      name: user.name,
      code: user.code,
      verdict: judgeWeek(sessions, weekStart, today),
    });
  }
  return rows;
}

export { weekIsOver };
