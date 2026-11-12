/**
 * 留档自洽性检查（2026-08-22）
 *
 * ★ 解决什么 ★ 判定留档（DailyEvaluation）是当晚按**当时的日历**算的，
 * 而日历随时会被主管改。原来只检测了一个方向——「这天现在标着放假，库里却还有留档」，
 * 于是另外几个方向全是黑的：
 *
 *   | 日历动作            | 旧留档该怎么办      | 改之前 |
 *   |---------------------|---------------------|--------|
 *   | 工作日 → 放假       | 该删                | ✅ 检测到 |
 *   | 工作日 → 某人请假   | 该删他那天          | ❌ 漏  |
 *   | 请假 → 撤销         | 该补判那天          | ❌ 漏  |
 *   | 放假 → 撤销         | 该补判那天          | ❌ 漏  |
 *   | 周末 → 调休上班     | 该补判那天          | ❌ 漏  |
 *
 * ★ 「请假那天的旧留档」不是纸面问题 ★ 台账上它被 TaskCells 的「请假」整行短路挡住了，
 * 看不见——但它活着：连续不达标天数的递推会读它、次日横幅会读它、
 * 业务员自己首页的历次记录会显示它。主管以为批了假，系统还在按缺考扣他。
 *
 * ★ 后三种为什么不能靠 catchUpSettlement 自愈 ★ 它确实会把缺的那天补上，
 * 但**只补那一天**——补出来的那天插在序列中间，而「连续不达标天数」是链式的
 * （每天读前一天的留档）。它之后那些已经有留档的日子不会重跑，链就从插入点起全错了。
 * 所以这里不去数「缺了哪几天」（那是自愈的），而是**验链条本身自不自洽**：
 * 一处对不上，就说明中间被插过、删过，或者有人手改过库。
 *
 * ★ 本文件的纯函数部分不碰数据库、不读时钟 ★ 喂什么查什么，好测。
 */

import { prisma } from './db';
import { businessDay } from './business-day';
import { judgementFingerprint } from './admission-v11';
import { loadCalendars } from './work-calendar';

/** 一条留档，只取校验用得上的几个字段 */
export interface LedgerRow {
  userId: string;
  day: string;
  /** 三态：达标 / 不达标 / 不构成判定 */
  passed: boolean | null;
  consecutiveFails: number;
  /**
   * 这一行是按哪套判定口径算出来的（`detail.ruleFingerprint`）。
   *
   * ★ null 一律不报 ★ 2026-08-22 之前的留档没有这个字段，口径无从对起。
   * 把它们全报成「待重算」，第一次打开就是三千行红字——人只会当噪音略过去，
   * 连带真正该看的那几条也一起被略掉。所以：**认不出来的不报，只报对不上的。**
   */
  ruleFingerprint?: string | null;
}

export type StaleReason =
  /** 这天现在是公司假期或周末，不该有留档 */
  | 'REST_DAY'
  /** 这天他请假（含「停用期」），对他不是业务日，不该有留档 */
  | 'ON_LEAVE'
  /** 连续不达标天数和前一天对不上——中间被插过/删过日子，链条已经不作数 */
  | 'CHAIN_BROKEN'
  /** 这天是按**老的判定口径**算的（阈值/窗口改过，留档没跟着重算） */
  | 'RULE_CHANGED';

export interface StaleDay {
  userId: string;
  day: string;
  reason: StaleReason;
}

export const STALE_LABEL: Record<StaleReason, string> = {
  REST_DAY: '这天现在标着放假／周末，却还留着判定',
  ON_LEAVE: '这天他请假，却还留着判定',
  CHAIN_BROKEN: '连续不达标天数和前一天对不上',
  RULE_CHANGED: '这天是按老的判定口径算的，阈值改过但没重算',
};

/**
 * 连续不达标天数的递推——**唯一真源在这里**。
 *
 * ★ 样本不足的日子既不加也不清零 ★「没考够」不是「没考好」，
 * 拿它去打断或延长连续计数，两个方向都是冤枉人。
 * settlement.evaluateUserDay 里那段三元表达式必须和这个函数一致，
 * 否则这份检查会把正确的留档报成断链。
 */
export function nextFails(previous: number, passed: boolean | null): number {
  if (passed === false) return previous + 1;
  if (passed === true) return 0;
  return previous;
}

/**
 * 查一个人的留档。
 *
 * @param rows 这个人的留档，**必须按日期从早到晚**
 * @param cal  当前日历。isWorkday 走公司日历，onLeave 是他自己的请假
 *
 * ★ 窗口里第一行不查链条 ★ 它的连续天数是从窗口之外继承来的，无从对起。
 * 拿它当起点往后推。
 *
 * ★ 断链只报第一处 ★ 一旦某天对不上，它之后每一天都会跟着对不上——
 * 报一整片，人只会当成噪音略过去；而要做的动作只有一个：从第一处起重算。
 */
export function auditUserLedger(
  rows: readonly LedgerRow[],
  cal: { isWorkday(day: string): boolean; onLeave(day: string): boolean },
  /** 当前判定口径的指纹。默认取实时配置；测试里可以显式喂一个 */
  currentFingerprint: string = judgementFingerprint(),
): StaleDay[] {
  const stale: StaleDay[] = [];
  let previous: number | null = null;
  let chainReported = false;

  for (const row of rows) {
    // ★ 不该存在的行不推进链条 ★ 它本来就要被删掉，拿它当基准会把后面全带偏
    if (!cal.isWorkday(row.day)) {
      stale.push({ userId: row.userId, day: row.day, reason: 'REST_DAY' });
      continue;
    }
    if (cal.onLeave(row.day)) {
      stale.push({ userId: row.userId, day: row.day, reason: 'ON_LEAVE' });
      continue;
    }
    if (previous !== null && !chainReported && row.consecutiveFails !== nextFails(previous, row.passed)) {
      stale.push({ userId: row.userId, day: row.day, reason: 'CHAIN_BROKEN' });
      chainReported = true;
    }
    /**
     * ★ 口径变了照样推进链条 ★ 这一行本身是自洽的（当时那套规则下它没算错），
     * 只是那套规则已经不作数了。它不像放假日/请假日那样「不该存在」，
     * 所以不 continue——把它从链条里摘掉反而会把后面全报成断链。
     */
    if (row.ruleFingerprint && row.ruleFingerprint !== currentFingerprint) {
      stale.push({ userId: row.userId, day: row.day, reason: 'RULE_CHANGED' });
    }
    // ★ 以库里的值往下走，不用算出来的 ★ 用算出来的，一处错就会连锁报一整片
    previous = row.consecutiveFails;
  }
  return stale;
}

export interface LedgerAudit {
  stale: StaleDay[];
  /** 最早那个异常日。重算从这里起 */
  from: string | null;
  /** 涉及多少个不同的业务日（同一天多个人只算一天） */
  dayCount: number;
  /** 按原因分类计数，界面上要分开说——三种原因要做的动作是同一个，但读的人得知道为什么 */
  byReason: Record<StaleReason, number>;
  /** 最早那几天，给界面列出来。最多 6 个 */
  sampleDays: string[];
}

/**
 * 全员留档体检。
 *
 * ★ 不分页、整段捞 ★ 这套系统十几个人、一人一天一行，一年也就三千来行。
 * 分页只会让「最早那个异常日」算不准，而那正是重算起点。
 */
export async function loadLedgerAudit(): Promise<LedgerAudit> {
  const today = businessDay();
  const rows = await prisma.dailyEvaluation.findMany({
    where: { day: { lt: today } },
    select: { userId: true, day: true, passed: true, consecutiveFails: true, detail: true },
    orderBy: [{ userId: 'asc' }, { day: 'asc' }],
  });

  const empty: LedgerAudit = {
    stale: [],
    from: null,
    dayCount: 0,
    byReason: { REST_DAY: 0, ON_LEAVE: 0, CHAIN_BROKEN: 0, RULE_CHANGED: 0 },
    sampleDays: [],
  };
  if (rows.length === 0) return empty;

  const userIds = [...new Set(rows.map((row) => row.userId))];
  const calendars = await loadCalendars(userIds);

  // detail 是 Json 列，类型系统管不住它——指纹按字符串收窄，别的一律当「没有」
  const fingerprintOf = (detail: unknown): string | null => {
    if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return null;
    const value = (detail as Record<string, unknown>).ruleFingerprint;
    return typeof value === 'string' ? value : null;
  };

  const byUser = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    const item: LedgerRow = {
      userId: row.userId,
      day: row.day,
      passed: row.passed,
      consecutiveFails: row.consecutiveFails,
      ruleFingerprint: fingerprintOf(row.detail),
    };
    const bucket = byUser.get(row.userId);
    if (bucket) bucket.push(item);
    else byUser.set(row.userId, [item]);
  }

  const stale: StaleDay[] = [];
  for (const [userId, userRows] of byUser) {
    stale.push(
      ...auditUserLedger(userRows, {
        isWorkday: (day) => calendars.company.isWorkday(day),
        onLeave: (day) => calendars.leaveOn(userId, day) !== null,
      }),
    );
  }
  if (stale.length === 0) return empty;

  const days = [...new Set(stale.map((item) => item.day))].sort();
  const byReason = { ...empty.byReason };
  for (const item of stale) byReason[item.reason] += 1;

  return {
    stale,
    from: days[0]!,
    dayCount: days.length,
    byReason,
    sampleDays: days.slice(0, 6),
  };
}
