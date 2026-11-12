/** v3.0 全系统唯一业务日口径：Asia/Shanghai。禁止再用 toISOString().slice(0, 10)。 */
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function businessDay(at: Date = new Date()): string {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseDay(day: string): { year: number; month: number; date: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`无效业务日：${day}`);
  return { year: Number(match[1]), month: Number(match[2]), date: Number(match[3]) };
}

/** 用 UTC 正午承载纯日期，避开任何时区的跨日边界。 */
function dayCarrier(day: string): Date {
  const { year, month, date } = parseDay(day);
  return new Date(Date.UTC(year, month - 1, date, 12));
}

function carrierToDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

/* ────────────────── 工作日历 ────────────────── */

/**
 * 一本工作日历只回答一件事：**这一天上不上班**。
 *
 * ★ 为什么抽成接口 ★ 公司放假是全员的、个人请假是一个人的，
 * 两者对「窗口该跳过哪天」的作用完全一样，只是范围不同。
 * 判定引擎不该知道这个区别，它只需要一本能问的日历。
 */
export interface WorkCalendar {
  isWorkday(day: string): boolean;
}

function isWeekend(day: string): boolean {
  const weekday = dayCarrier(day).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * 默认日历：周一至周五上班，**不认任何法定假期**。
 *
 * ★ 这是兜底，不是正确答案 ★ 真实排班一定要用 `calendarFrom()` 带上公司日历。
 * 留着它是为了让纯函数测试不必伪造一本日历；生产代码里出现它，
 * 多半意味着有人忘了把日历传下来——国庆当天才会发现。
 */
export const DEFAULT_CALENDAR: WorkCalendar = { isWorkday: (day) => !isWeekend(day) };

/**
 * 用「例外表」做一本日历。**只存例外**，没记录的日子走默认。
 *
 * @param overrides day → 上不上班。false=放假，true=调休上班。
 *
 * ★ 必须支持双向 ★ 中国的法定假期一定带调休：国庆放 10/1–10/7，
 * 通常配一个周日上班。只能标放假、不能标调休的日历，一年至少错六次。
 */
export function calendarFrom(overrides: ReadonlyMap<string, boolean>): WorkCalendar {
  return { isWorkday: (day) => overrides.get(day) ?? !isWeekend(day) };
}

/**
 * 把「某个人的请假」压在公司日历上。
 *
 * ★ 为什么不做成通用的 mergeCalendars(a, b) ★ 试过，是个陷阱：
 * 用 calendarFrom() 造一本「只写了请假日」的日历，它对其余日子会回答
 * 「周末不上班」——两本一 AND，调休上班的那个周六就被它悄悄取消了。
 * 请假集合是**例外集合**，不是一本日历，所以只暴露这个专用函数。
 */
export function withLeaveDays(base: WorkCalendar, leaveDays: ReadonlySet<string>): WorkCalendar {
  if (leaveDays.size === 0) return base;
  return { isWorkday: (day) => base.isWorkday(day) && !leaveDays.has(day) };
}

/**
 * ★ 扫描上限 ★ 日历是人填的，有人把一整年标成放假并非不可能。
 * 不设上限的话，下面两个 while 循环会转到天荒地老（页面挂死，且没有任何线索）。
 * 撞到上限就抛错——一本连续一年不上班的日历本身就是要被人看见的事故。
 */
const MAX_SCAN_DAYS = 366;

/** 下一个工作日。跳过周末，也跳过日历里标成放假的日子。 */
export function nextBusinessDay(day: string, calendar: WorkCalendar = DEFAULT_CALENDAR): string {
  const cursor = dayCarrier(day);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS; scanned += 1) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (calendar.isWorkday(carrierToDay(cursor))) return carrierToDay(cursor);
  }
  throw new Error(`${day} 之后连续 ${MAX_SCAN_DAYS} 天都不是工作日——工作日历填错了`);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((dayCarrier(b).getTime() - dayCarrier(a).getTime()) / 86_400_000);
}


/**
 * 最近 N 个业务日，从新到旧（含 from 那天，如果那天上班）。
 * 跳过周末，也跳过日历里标成放假的日子——和 nextBusinessDay 同一口径，
 * 否则面板上会多出一排永远「缺考」的假期。
 */
export function recentBusinessDays(
  count: number,
  from: string = businessDay(),
  calendar: WorkCalendar = DEFAULT_CALENDAR,
): string[] {
  const days: string[] = [];
  const cursor = dayCarrier(from);
  for (let scanned = 0; scanned < MAX_SCAN_DAYS && days.length < count; scanned += 1) {
    const day = carrierToDay(cursor);
    if (calendar.isWorkday(day)) days.push(day);
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  if (days.length < count) {
    throw new Error(`${from} 往前 ${MAX_SCAN_DAYS} 天里凑不满 ${count} 个工作日——工作日历填错了`);
  }
  return days;
}

const stampFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * 年月日时分秒（上海时区）。台账与流水一律用这个，不要各处自己 toLocaleString——
 * 服务器时区一漂，同一条记录在两页上就是两个时间。
 */
export function stamp(at: Date | null | undefined): string {
  if (!at) return '—';
  const parts = Object.fromEntries(
    stampFormatter
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/**
 * 「今天 14:33」「昨天 14:33」「8月20日 14:33」——给人看的时间。
 *
 * ★ 不是 stamp 的替代 ★ 台账、局流水那种要能逐秒对账的地方仍旧用 stamp；
 * 这个只用在「他上次什么时候登的」这类一眼扫过去、不需要精确到秒的位置。
 * 一屏摆七八个 `2026-08-21 14:33:00`，读的人得自己在心里换算「这是几天前」。
 */
export function friendlyStamp(at: Date | null | undefined): string {
  if (!at) return '';
  const full = stamp(at);
  if (full === '—') return '';
  const day = full.slice(0, 10);
  const hhmm = full.slice(11, 16);
  const today = businessDay();
  if (day === today) return `今天 ${hhmm}`;
  const carrier = dayCarrier(today);
  carrier.setUTCDate(carrier.getUTCDate() - 1);
  if (day === carrierToDay(carrier)) return `昨天 ${hhmm}`;
  const [year, month, date] = day.split('-') as [string, string, string];
  const monthDay = `${Number(month)}月${Number(date)}日`;
  return year === today.slice(0, 4) ? `${monthDay} ${hhmm}` : `${year}年${monthDay}`;
}

/** 只要时分秒。同一天的多条记录并排时，日期是噪音 */
export function clockOnly(at: Date | null | undefined): string {
  const full = stamp(at);
  return full === '—' ? full : full.slice(11);
}

/* ────────────────── 自然周 ────────────────── */

/**
 * 往前/往后挪 N 个自然日。**不跳周末、不看日历**——它是纯日期算术。
 * 要跳假期请用 `nextBusinessDay` / `recentBusinessDays`。
 */
export function shiftDay(day: string, delta: number): string {
  const cursor = dayCarrier(day);
  cursor.setUTCDate(cursor.getUTCDate() + delta);
  return carrierToDay(cursor);
}

/** 星期几。**0=周日、1=周一 … 6=周六**（跟 JS 的 getDay 对齐，别自己发明一套） */
export function weekdayOf(day: string): number {
  return dayCarrier(day).getUTCDay();
}

/**
 * 这一天所在自然周的**周一**。
 *
 * ★ 为什么是自然周而不是「最近 7 个业务日」★（2026-08-24 王老师定）
 * 正式业务员的周考要求是「每周至少 2 场」，业务员心里那个「这周」就是周一到周日。
 * 换成滚动 7 业务日，同一句「这周考了几场」会随着日期漂移，他没法自己数。
 * 代价是跨节假日不自动顺延——但周考只要 2 场，一周五个工作日里放两天假也够考。
 */
export function weekStartOf(day: string): string {
  const weekday = weekdayOf(day);
  // 周日(0) 属于**上一个**周一开头的那一周，往回退 6 天；其余退 weekday-1 天
  return shiftDay(day, -(weekday === 0 ? 6 : weekday - 1));
}

/** 这一天所在自然周的**周日**。 */
export function weekEndOf(day: string): string {
  return shiftDay(weekStartOf(day), 6);
}

/**
 * 最近 N 个自然周的周一，从新到旧（含 from 那一周）。
 * 周表按这个排，缺的那周照样占一行——**没考就是没考，不能靠没有行糊过去**。
 */
export function recentWeekStarts(count: number, from: string = businessDay()): string[] {
  const first = weekStartOf(from);
  return Array.from({ length: count }, (_, index) => shiftDay(first, -7 * index));
}
