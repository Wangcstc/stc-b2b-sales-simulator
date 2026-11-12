/**
 * 工作日历取数（2026-08-21，王老师定：放假要能豁免，别让假期打断训练判定）
 *
 * ★ 两层，分开存 ★
 *   · 公司日历 `BusinessCalendar`：全员的法定假期与调休，只存例外
 *   · 个人请假 `LeaveDay`：病假/事假/出差，只影响那一个人
 * 对「判定窗口该跳过哪天」两者作用完全一样，所以在这里合成一本日历交给引擎；
 * 引擎不需要知道某一天是公司放假还是他自己请假。
 *
 * ★ 但界面需要知道 ★ 台账上「公司放假」那天根本不出现行，
 * 「他请假」那天要出现一行写着请假原因——所以请假明细也一并返回。
 */

import { prisma } from './db';
import { calendarFrom, daysBetween, withLeaveDays, type WorkCalendar } from './business-day';

/** 全员共用的公司日历。没记录的日子走默认（周一至周五上班） */
export async function loadCompanyCalendar(): Promise<WorkCalendar> {
  const rows = await prisma.businessCalendar.findMany({ select: { day: true, isWorkday: true } });
  return calendarFrom(new Map(rows.map((row) => [row.day, row.isWorkday])));
}

export interface LeaveMark {
  day: string;
  reason: string | null;
}

export interface Calendars {
  /** 公司日历。台账那一列有哪几天、结论哪天生效，用这本 */
  company: WorkCalendar;
  /** 某人的日历 = 公司日历 + 他自己的请假。判定窗口用这本 */
  forUser(userId: string): WorkCalendar;
  /** 某人在某天是不是请假。台账那一行要写原因 */
  leaveOn(userId: string, day: string): LeaveMark | null;
}

/**
 * 一次把公司日历和这批人的请假全捞出来。
 * ★ 不要在循环里按人查 ★ 台账一屏 30 天 × N 人，按人查就是 N 次往返。
 */
export async function loadCalendars(userIds: string[]): Promise<Calendars> {
  const [company, leaves] = await Promise.all([
    loadCompanyCalendar(),
    userIds.length === 0
      ? Promise.resolve([])
      : prisma.leaveDay.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, day: true, reason: true },
        }),
  ]);

  const daysOf = new Map<string, Map<string, string | null>>();
  for (const leave of leaves) {
    let bucket = daysOf.get(leave.userId);
    if (!bucket) {
      bucket = new Map();
      daysOf.set(leave.userId, bucket);
    }
    bucket.set(leave.day, leave.reason);
  }

  const calendarOf = new Map<string, WorkCalendar>();
  for (const userId of userIds) {
    const bucket = daysOf.get(userId);
    calendarOf.set(userId, bucket ? withLeaveDays(company, new Set(bucket.keys())) : company);
  }

  return {
    company,
    forUser: (userId) => calendarOf.get(userId) ?? company,
    leaveOn: (userId, day) => {
      const bucket = daysOf.get(userId);
      if (!bucket || !bucket.has(day)) return null;
      return { day, reason: bucket.get(day) ?? null };
    },
  };
}

/** 单个人用。内部还是走 loadCalendars，口径只有一套 */
export async function loadCalendarFor(userId: string): Promise<WorkCalendar> {
  return (await loadCalendars([userId])).forUser(userId);
}

/**
 * 日历维护到哪天了。
 * ★ 这类功能最常见的死法不是写错，是没人维护 ★ 界面上要显眼地写出来，
 * 快到头了就在教练台待办条上报警——不然明年春节前谁都不会想起它。
 */
export async function calendarMaintainedUntil(): Promise<string | null> {
  const last = await prisma.businessCalendar.findFirst({ orderBy: { day: 'desc' }, select: { day: true } });
  return last?.day ?? null;
}

/**
 * 日历还够用几天，够不够到该提醒的程度。
 *
 * ★ 这个函数在 2026-08-22 之前一直没人调用 ★ 上面那句注释从 08-21 就写着
 * 「快到头了就在教练台待办条上报警」，而 `calendarMaintainedUntil` 是**死代码**——
 * 界面上唯一的提示是工作日历面板底下一行小字「最后标记到 X」，
 * 且只在 `lastMark < today` 时才变红。**今天随手标一天明年的假，那行就永远不红了。**
 * 现在把它接到待办条上：主管每天都会看那一条。
 *
 * ★ 两档阈值 ★ 45 天≈两个月，够从容排下一段假期；15 天是「再不弄就要出事」。
 * 判定窗口只往前看 2 个业务日，所以真正的风险不是「明天没日历」，
 * 而是「下一个长假到了没人标」——提前量必须按月算，不能按天。
 */
export const CALENDAR_WARN_DAYS = 45;
export const CALENDAR_URGENT_DAYS = 15;

export interface CalendarHealth {
  /** 最后标记到哪天。null = 一天都没标过 */
  until: string | null;
  /** 从今天到 until 还有几个自然日。null = 一天都没标过；负数 = 已经过期 */
  daysLeft: number | null;
  level: 'ok' | 'warn' | 'urgent' | 'never';
  /** 待办条上那句话。level 为 ok 时是空字符串 */
  text: string;
}

export async function calendarHealth(today: string): Promise<CalendarHealth> {
  const until = await calendarMaintainedUntil();
  if (until === null) {
    return {
      until: null,
      daysLeft: null,
      level: 'never',
      text: '工作日历一天都没标过 —— 国庆、春节会被当成工作日，全员整段判缺考',
    };
  }
  const daysLeft = daysBetween(today, until);
  if (daysLeft < 0) {
    return { until, daysLeft, level: 'urgent', text: `工作日历只标到 ${until}，已经全是过去的了 —— 该排下一段假了` };
  }
  if (daysLeft <= CALENDAR_URGENT_DAYS) {
    return { until, daysLeft, level: 'urgent', text: `工作日历只标到 ${until}，还剩 ${daysLeft} 天` };
  }
  if (daysLeft <= CALENDAR_WARN_DAYS) {
    return { until, daysLeft, level: 'warn', text: `工作日历标到 ${until}，还剩 ${daysLeft} 天` };
  }
  return { until, daysLeft, level: 'ok', text: '' };
}
