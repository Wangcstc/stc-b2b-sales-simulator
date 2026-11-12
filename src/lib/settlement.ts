/**
 * 每晚结算（方案 v1.1 第一节时序 + 第二节人工覆盖）
 *
 * ★ 一天一条，幂等 ★ 同一个业务日重复结算只会更新同一行。
 *
 * ★ 结算读的是「局」，不是「考试的结算状态」★
 * 所以考生不点「结算本组」也逃不掉判定——这是 v3.0 那套最大的一个洞：
 * 判定挂在 ExamAttempt.verdict 上，而那个 verdict 由考生自己点按钮触发，
 * 一个自觉考砸的人只要不点，状态就永远停在「在岗期」。
 *
 * ★ 判定日与生效日分开 ★ 结算算的是 day 这一天及之前的局，
 * 结论在 nextBusinessDay(day) 生效。所以只结算**已经过去的**业务日：
 * 今天白天不结算今天，否则一个人的期别会在一天之内跳来跳去。
 *
 * ★ 人工覆盖期间：照算、照记、不执行 ★（方案第二节）
 * recommendedStage 与 appliedStage 会不一样，两个数字打架的时候人要看得见在打架。
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { businessDay, nextBusinessDay, recentBusinessDays } from './business-day';
import { loadCalendars, type Calendars } from './work-calendar';
import {
  activeGateText,
  ADMISSION_CONFIG,
  examStateOf,
  judgementFingerprint,
  judgeWindow,
  overrideStillActive,
  type ExamState,
  type Stage,
  type WindowSession,
  type WindowVerdict,
} from './admission-v11';
import type { ScoreOutput, SessionFacts } from '../../engine/types';
import { didRealWork } from '../../engine/facts';
import { variantDifficulty } from './variant-difficulty';
// ★ 判定内核 ★ 纯函数、可测试；这个文件只做取数与写库，见 settlement-decide.ts 文件头
import { decideDay, type Banner } from './settlement-decide';

export type { Stage } from './admission-v11';
// Banner 的定义随判定一起搬进了内核；这里 re-export，外部 import 路径不用改
export type { Banner } from './settlement-decide';

/**
 * 往回捞多少局。判定窗口只用得到最近两个业务日的局，24 局是给展示和补算留的余量。
 * ★ 捞多了不会把旧分算进判定 ★ judgeWindow 按业务日排格子，落在窗口两天之外的局自动落选。
 */
const LOOKBACK_SESSIONS = 24;
/** 补算最多往回追几个业务日。系统停了一周再开，不必把上个月重新判一遍 */
/**
 * 补算往回追几个业务日。
 * ★ 与教练台台账的 LEDGER_DAYS(30) 对齐 ★（2026-08-22）原来是 10：
 * 台账摆 30 天，第 11 天以前那些行永远补不上结算，看着像「那几天系统没跑」。
 */
const CATCHUP_DAYS = 30;

/**
 * 结算时一次捞多少局。
 * ★ 不能用 LOOKBACK_SESSIONS(24) ★ 补算 30 个业务日时，24 局根本够不到最老那几天——
 * 窗口会是空的，而「空窗口」现在等于**判他缺考不达标**。捞少了就是冤枉人。
 */
const SETTLE_LOOKBACK_SESSIONS = 240;

/**
 * 期别 → 兼容用的 InquiryAccessStatus。
 *
 * ★ 为什么还留着这个字段 ★ v3.0 的读路径（版头、账号页、正式员工分流）都在读它。
 * 但从 v1.1 起它是**派生值**，唯一权威是 stage——方案第二节写明
 * 「必须按这个实现，否则会互相打架」。
 */
export function accessStatusFor(stage: Stage, hadAccessBefore: boolean): 'ACTIVE' | 'PAUSED' | 'NOT_ADMITTED' {
  if (stage === 'ACTIVE') return 'ACTIVE';
  return hadAccessBefore ? 'PAUSED' : 'NOT_ADMITTED';
}

/**
 * 捞这个人最近的考试局，转成判定证据。
 *
 * ★ 只认 ADMISSION_EXAM ★ 演习局（DRILL）一局都不进来——
 * 「演习不计入准入」这一条从 v0.1 到 v1.1 从来没动过。
 * v2.0 的历史 EXAM 局也不进：口径不同的分不可比。
 */
export async function loadWindowSessions(
  userId: string,
  until?: string,
  /**
   * 往回捞几局。默认 24 够算判定窗口。
   * ★ 教练台的历史台账要传大一点 ★ 它给每一天都现算一次窗口，
   * 只捞 24 局的话，往前数第 9 天以前那几行的窗口会是空的——
   * 表面上像「那几天没考」，其实是没捞到。
   */
  take: number = LOOKBACK_SESSIONS,
): Promise<WindowSession[]> {
  const sessions = await prisma.session.findMany({
    where: { userId, mode: 'ADMISSION_EXAM', score: { isNot: null } },
    orderBy: [{ endedAt: 'desc' }, { createdAt: 'desc' }],
    take,
    include: { score: true, variant: { include: { persona: true } } },
  });
  const reviews = await prisma.redlineReview.findMany({
    where: { sessionId: { in: sessions.map((session) => session.id) } },
  });

  const evidence = sessions.map((session) => {
    const facts = session.facts as unknown as SessionFacts;
    const forces = (session.score?.forces ?? {}) as ScoreOutput;
    const insight = forces.insight?.score;
    const day = businessDay(session.endedAt ?? session.createdAt);
    return {
      sessionId: session.id,
      businessDay: day,
      type: session.variant.persona.sessionType as 'INQUIRY' | 'FOLLOWUP',
      precise: session.score?.precise ?? false,
      rawScore: session.score?.rawScore ?? null,
      insight: typeof insight === 'number' ? insight : null,
      answerQuality: session.score?.answerQuality ?? null,
      redlines: (facts.redlines ?? []).map((code) => {
        const review = reviews.find((item) => item.sessionId === session.id && item.redline === code);
        const status = review?.status === 'CONFIRMED' || review?.status === 'DISMISSED' ? review.status : 'PENDING';
        return { code, status: code === 'R1' ? ('CONFIRMED' as const) : (status as 'PENDING' | 'CONFIRMED' | 'DISMISSED') };
      }),
    } satisfies WindowSession;
  });

  return until ? evidence.filter((session) => session.businessDay <= until) : evidence;
}

/**
 * 界面用：把「今天已经打完的局」也算进来的实时窗口。**只用于显示，不用于改状态**
 *
 * ★ 判的是今天 ★ 窗口 = 今天 + 前一个业务日。今天还没考的那几局是空格，
 * 所以白天看到的多半是「不构成判定」——这是对的：今天的判定本来就要等考完。
 */
export async function previewWindow(userId: string, today: string = businessDay()): Promise<WindowVerdict> {
  const [sessions, examState, calendars] = await Promise.all([
    loadWindowSessions(userId),
    todayExamState(userId, today),
    loadCalendars([userId]),
  ]);
  // 今天还没考完 → 今天那几个空格说成「还没考完」，不说「缺考」。
  // 不传这个，业务员上午打开首页会看到「今天整天缺考」——那是假的。
  return judgeWindow(sessions, today, {
    calendar: calendars.forUser(userId),
    dayInProgress: examState !== '已考',
  });
}

/**
 * 结算某人的某个业务日。幂等：同一个 (人, 日) 只有一行，重复跑只更新。
 *
 * @param day 被结算的业务日。**必须是已经过去的日子**，理由见文件头。
 */
export async function evaluateUserDay(
  userId: string,
  day: string,
  opts?: {
    /**
     * 预载数据。补算 30 天时，日历和局各捞一次就够——
     * 不传的话是「每天一次 loadCalendars + 一次 loadWindowSessions」，30 天就是 60 次往返。
     */
    sessions?: WindowSession[];
    calendars?: Calendars;
    /**
     * 这一次结算是谁触发的。**只写进 AccessDecision.reason，不参与任何判定**。
     *
     * ★ 为什么要有它 ★（2026-08-22）重算会真的改人的期别与分配权，而重放出来的
     * AccessDecision 和每晚定时任务写的长得一模一样——事后翻台账，看不出「他那天掉期别
     * 是系统判的，还是某人点了一次重算」。审计表是第三批的事，这一行先把最要紧的
     * 那几条（真的改了状态的）标出来。
     */
    trigger?: string;
  },
) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.employeeType !== 'INTERN' || user.participationMode !== 'ADMISSION') return null;

  // ★ 不上班的日子不结算，一行留档都不写 ★（2026-08-21）
  // 公司放假、他自己请假——那天对他就不是业务日，判定无从谈起。
  // 硬写一行 passed=null 的留档也行，但那会在台账上留下一片「不构成判定」，
  // 让人以为系统那几天出了问题；直接没有行才是对的。
  const calendars = opts?.calendars ?? (await loadCalendars([userId]));
  if (!calendars.company.isWorkday(day)) return null;
  if (calendars.leaveOn(userId, day)) return null;

  const all = opts?.sessions ?? (await loadWindowSessions(userId, day, SETTLE_LOOKBACK_SESSIONS));
  const sessions = all.filter((session) => session.businessDay <= day);

  // ★ 开始判他之前的日子不判 ★ 不然一个今天刚加进来的人会被补记一片「整天缺考」，
  // 而缺考现在是要扣资格的。
  if (day <= startDayOf(user, all)) return null;
  const verdict = judgeWindow(sessions, day, { calendar: calendars.forUser(userId) });
  const previous = await prisma.dailyEvaluation.findFirst({
    where: { userId, day: { lt: day } },
    orderBy: { day: 'desc' },
  });

  /**
   * ★ 到这里为止是「取数」，下面一行是「判定」，再往下是「写库」★（2026-08-25 拆开）
   * 判定整段搬进了 lib/settlement-decide.ts —— 那是个纯函数，可以穷举测试。
   * 这个函数从此只负责：把料备齐 → 交给内核判 → 把结论落库。
   * 不要再往 decideDay 与 upsert 之间塞判定逻辑；要加规则请加在内核里，顺带补上测试。
   */
  const decision = decideDay({
    day,
    verdict,
    stageBefore: user.stage as Stage,
    stageOverride: user.stageOverride,
    stageSetAt: user.stageSetAt,
    previousConsecutiveFails: previous?.consecutiveFails ?? 0,
    companyCalendar: calendars.company,
  });
  const { overrideActive, appliedStage: applied, recommendedStage: recommended, stageBefore, consecutiveFails } = decision;

  // Prisma 的 InputJsonValue 不接受带具名字段的对象数组（GateView[] 过不了索引签名），
  // 这里过一次 unknown。读回来时由 lib/evaluation-view.ts 统一收窄，别在各页面各写一套解析。
  const detail = decision.detail as unknown as Prisma.InputJsonObject;
  const row = { ...decision, detail };

  const evaluation = await prisma.dailyEvaluation.upsert({
    where: { userId_day: { userId, day } },
    update: row,
    create: { userId, day, ...row },
  });

  // ★ 人工设定到期要当场摘掉标记 ★ 哪怕期别没变。
  // 不摘的话界面上那个橙色「主管定的」会一直挂着，而它其实已经不生效了——
  // 挂一个不作数的标记，比不挂更误导。
  const overrideExpired = user.stageOverride && !overrideActive;
  const stageChanged = !overrideActive && applied !== stageBefore;

  if (stageChanged || overrideExpired) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        ...(stageChanged
          ? {
              stage: applied,
              stageSetBy: 'SYSTEM' as const,
              stageSetAt: new Date(),
              inquiryAccessStatus: accessStatusFor(applied, stageBefore === 'ACTIVE'),
              accessSetBy: 'SYSTEM' as const,
              accessSetAt: new Date(),
              accessEffectiveDay: row.effectiveDay,
            }
          : {}),
        ...(overrideExpired ? { stageOverride: false, overrideReason: null, overrideUntil: null } : {}),
      },
    });
  }

  if (stageChanged) {
    await prisma.accessDecision.create({
      data: {
        subjectId: userId,
        attemptIds: [],
        gateResults: detail,
        recommendedStatus: accessStatusFor(recommended, stageBefore === 'ACTIVE'),
        appliedStatus: accessStatusFor(applied, stageBefore === 'ACTIVE'),
        manualOverride: false,
        // ★ 触发来源写在最前面 ★ 重放出来的这一条和定时任务写的长得一模一样，
        // 不标一句，事后翻台账分不出「系统判的」和「某人点了重算」。
        reason: `${opts?.trigger ? `【${opts.trigger}】` : ''}v1.1 每晚结算（${day}）：${applied === 'ACTIVE' ? `局分中位数达标（${activeGateText()}），获得分配权` : `连续 ${consecutiveFails} 天不达标，暂停分配新询盘`}`,
        effectiveDay: row.effectiveDay,
        poolVersion: 'v1.1',
        scoreRuleVersion: 'v1.1-2day-6',
      },
    });
  }

  return evaluation;
}

/**
 * 从哪天开始判这个人。
 *
 * ★ 取「身份定下来那天」和「他第一场考试那天」里更早的那个 ★
 * 只看身份日：一个 08-01 就在考试、08-20 才被主管点成实习业务员的人，
 * 前面三周的历史会凭空消失。
 * 只看第一场考试：一场没考过的人就永远判不到——而「一场不考也要判不达标」
 * 正是 2026-08-22 这一轮要修的东西。
 *
 * 返回的是「起点日」，**起点日当天不判**（从第二天起判）：
 * 那一天他多半是半路进来的，判定窗口要两天，前一天本来就没有。
 */
export function startDayOf(
  user: { identityConfirmedAt: Date | null; createdAt: Date },
  sessions: WindowSession[],
): string {
  const identityDay = businessDay(user.identityConfirmedAt ?? user.createdAt);
  const firstExamDay = sessions.reduce<string | null>(
    (min, session) => (min === null || session.businessDay < min ? session.businessDay : min),
    null,
  );
  return firstExamDay !== null && firstExamDay < identityDay ? firstExamDay : identityDay;
}

/**
 * 人工设定过了当天就作废——**就算那天他一局没考、结算根本没跑**。
 *
 * ★ 为什么不能只靠结算去摘这个标记 ★ 结算的日子是从「有考试局的日子」推出来的
 * （见《docs/机制规则/考核运行机制.md》漏洞 B）。主管在一个他没考试的日子做了人工设定，
 * 那一天永远不会被结算，标记也就永远摘不掉——等于又回到「锁死」那套。
 * 所以放在每次补算之前跑一遍：读路径（首页 / 考试页 / 教练台 / 账号管理）
 * 和每晚的定时任务都会经过 catchUpSettlement，四个入口一次覆盖。
 *
 * ★ 只摘标记，不动期别 ★ 主管设的那个期别留在原地，系统从那儿继续管。
 * 回滚到他改之前的状态，等于系统跟主管对着干。
 */
async function releaseStaleOverride(userId: string, today: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { stageOverride: true, stageSetAt: true },
  });
  if (!user?.stageOverride) return;
  if (businessDay(user.stageSetAt) >= today) return;
  await prisma.user.update({
    where: { id: userId },
    data: { stageOverride: false, overrideReason: null, overrideUntil: null },
  });
}

/**
 * 补算：把还没结算过的过去业务日一次补齐。
 *
 * ★ 2026-08-22：日子改成按工作日历推，不再按「有考试局的日子」推 ★
 * 原来是 `[...new Set(sessions.map(s => s.businessDay))]`——**一个人一场不考，
 * 就一天都不会被结算**：DailyEvaluation 一行不产生、期别永不变化、横幅一条不发。
 * 那正是「不考试的人系统管不着」的根，也是「缺考算不达标」这条新规则
 * 光改判定引擎修不掉的那一半——那一天压根不会进结算。
 *
 * ★ 为什么不只依赖定时任务 ★ 定时任务会漏跑（部署窗口、冷启动、免费额度）。
 * 判定漏一天，一个该被暂停的人就多接一天真实询盘。所以读路径上也补一次，幂等。
 */
export async function catchUpSettlement(userId: string, today: string = businessDay()): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { disabledAt: true, createdAt: true, identityConfirmedAt: true },
  });
  // ★ 停用的人不结算 ★ 定时任务一直是这么过滤的，读路径原来没过滤，两条路口径不一致
  if (!user || user.disabledAt) return;

  await releaseStaleOverride(userId, today);
  // 局捞一次就够，别每天捞一次；起点也要用它算
  const [calendars, sessions] = await Promise.all([
    loadCalendars([userId]),
    loadWindowSessions(userId, undefined, SETTLE_LOOKBACK_SESSIONS),
  ]);
  const startDay = startDayOf(user, sessions);

  // 往回数 CATCHUP_DAYS 个**工作日**（recentBusinessDays 含 today，所以多要一个）
  const days = recentBusinessDays(CATCHUP_DAYS + 1, today, calendars.company)
    .filter((day) => day < today && day > startDay && !calendars.leaveOn(userId, day))
    .sort();
  if (days.length === 0) return;

  const settled = await prisma.dailyEvaluation.findMany({
    where: { userId, day: { in: days } },
    select: { day: true },
  });
  const done = new Set(settled.map((item) => item.day));
  const pending = days.filter((day) => !done.has(day));
  if (pending.length === 0) return;

  for (const day of pending) {
    await evaluateUserDay(userId, day, { sessions, calendars });
  }
}

/** 重算最多往回追几个业务日。一次误标不该把三个月的历史全部重跑 */
const RESETTLE_MAX_DAYS = 40;

/**
 * 按**当前日历**把 fromDay 起到昨天为止重新结算一遍。
 *
 * ★ 改了工作日历就必须跑这个 ★ 留档是当晚按当时的日历算的。
 * 把 10-01~10-07 补标成国庆之后，那几天的旧留档还写着「整天缺考」，
 * 而界面已经按新日历不再显示那几天——两边对不上账。
 *
 * ★ 为什么先删再建 ★ 变成假期的那些日子，evaluateUserDay 会直接跳过、
 * 不会把旧行删掉。不删就会留一堆按旧日历算出来的孤儿留档。
 *
 * ★ 顺序必须按日期从早到晚 ★ 每一天的「连续不达标」读的是它前一天的留档，
 * 倒着跑或并发跑，连续天数会算错。
 *
 * ★ 副作用 ★ 这会真的改人的期别与分配权（重放一遍历史，落到当前日历下的正确终点）。
 * AccessDecision 是只增的审计流水，重放可能多出几条——是噪音，不是错账。
 * 那几条的 reason 会带上 `【…】` 前缀写明是谁点的重算，见 evaluateUserDay 的 trigger。
 */
export interface ResettleResult {
  /** 实际重跑了几个业务日 */
  days: number;
  users: number;
  /** 重算覆盖到哪一天（含）。null = 一天都没跑 */
  through: string | null;
  /** true = 撞上 RESETTLE_MAX_DAYS 上限，后面还有已经过去的业务日没重算 */
  truncated: boolean;
  /** 没跑完时，从这一天起再点一次。跑完了是 null */
  resumeFrom: string | null;
}

export async function resettleRange(
  fromDay: string,
  opts: { trigger?: string } = {},
): Promise<ResettleResult> {
  const today = businessDay();
  const empty: ResettleResult = { days: 0, users: 0, through: null, truncated: false, resumeFrom: null };
  const users = await prisma.user.findMany({
    where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
    select: { id: true },
  });
  if (users.length === 0) return empty;
  const ids = users.map((user) => user.id);
  const calendars = await loadCalendars(ids);

  const span: string[] = [];
  if (calendars.company.isWorkday(fromDay) && fromDay < today) span.push(fromDay);
  let cursor = fromDay;
  while (span.length < RESETTLE_MAX_DAYS) {
    cursor = nextBusinessDay(cursor, calendars.company);
    if (cursor >= today) break;
    span.push(cursor);
  }

  /**
   * ★ 撞上限了没有 ★（2026-08-22 加）span 封顶 40 天，而下面那条 deleteMany 原来一律删到今天——
   * 跨度超过 40 个业务日时，**删掉的比重建的多**：中间那段留档凭空消失，
   * 连续不达标的链条也从缺口处断掉，而界面上一点提示都没有。
   * 现在删到哪、就重建到哪；没跑完的部分如实报出来，让人再点一次。
   */
  const through = span.length > 0 ? span[span.length - 1]! : null;
  let resumeFrom: string | null = null;
  if (through !== null && span.length >= RESETTLE_MAX_DAYS) {
    const next = nextBusinessDay(through, calendars.company);
    if (next < today) resumeFrom = next;
  }

  /**
   * ★ 上界按日期区间取，不按 span 那个列表取 ★ span 里只有工作日，
   * 而**要清掉的恰恰是「现在已经不是工作日、库里却还留着」的那些行**——
   * 按列表删就把它们一个不剩地漏掉，等于白删一场。
   * 没截断就删到今天（把 through 之后那些周末/假期的孤儿行也一并清掉）；
   * 截断了就删到 resumeFrom 之前，后面那段留着，等下一次重算来处理。
   */
  await prisma.dailyEvaluation.deleteMany({
    where: { userId: { in: ids }, day: { gte: fromDay, lt: resumeFrom ?? today } },
  });

  for (const day of span) {
    for (const id of ids) await evaluateUserDay(id, day, { trigger: opts.trigger });
  }
  return { days: span.length, users: ids.length, through, truncated: resumeFrom !== null, resumeFrom };
}

/**
 * 停用期回填上限。
 * ★ 只回填 catchUpSettlement 够得到的那一段 ★ 它往回追 30 个业务日，
 * 更早的日子无论标不标请假都不会再被结算——多写只是往库里塞噪音。
 * 多给一倍余量，是防着以后有人把 CATCHUP_DAYS 调大。
 */
const DISABLED_BACKFILL_DAYS = CATCHUP_DAYS * 2;

/**
 * 把「他被停用的那几天」标成对他不是业务日（2026-08-22）。
 *
 * ★ 解决什么 ★ 停用期间 catchUpSettlement 直接 return，一行留档都不写——对的。
 * 可一旦恢复，`disabledAt` 变成 null，补算按工作日历往回追 30 个业务日，
 * **把停用那几天全部补判成「缺考、不达标」**，连续 2 天就退回训练期、停发新询盘。
 * 而账号一览的说明正教主管「离职走停用，别删」，于是产假、长病假、借调都会走这条路——
 * 人回来上班的第一天，先被系统扣一次资格。
 *
 * ★ 为什么用 LeaveDay 而不是新加一张停用区间表 ★ 语义本来就一样：
 * 「那几天对这个人不是业务日」。请假这条路已经全线打通（不结算、不进窗口、
 * 台账写「请假」而不是「缺考」），复用它不必动数据模型，也不会多出第二套跳过逻辑。
 * 事由写死成「停用期」，在工作日历上看得见、也撤得掉。
 *
 * ★ 不覆盖已有的请假 ★ 他停用前就批过的病假，事由比「停用期」准确，留着原来的。
 *
 * @returns 回填了几天
 */
export async function markDisabledSpanAsLeave(
  userId: string,
  disabledAt: Date,
  operatorId: string,
): Promise<number> {
  const today = businessDay();
  const from = businessDay(disabledAt);
  const calendars = await loadCalendars([userId]);
  // 含停用当天：他多半是那天上午就进不来了，判他那天缺考同样是冤枉
  const days = recentBusinessDays(DISABLED_BACKFILL_DAYS, today, calendars.company).filter(
    (day) => day >= from && day < today,
  );
  if (days.length === 0) return 0;
  const written = await prisma.leaveDay.createMany({
    data: days.map((day) => ({ userId, day, reason: '停用期', setBy: operatorId })),
    skipDuplicates: true,
  });
  return written.count;
}

/** 定时任务用：给所有实习业务员补算到昨天为止 */
export async function settleAllInterns(today: string = businessDay()): Promise<{ userId: string; ok: boolean; error?: string }[]> {
  const interns = await prisma.user.findMany({
    where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
    select: { id: true },
  });
  const results = [];
  for (const intern of interns) {
    try {
      await catchUpSettlement(intern.id, today);
      results.push({ userId: intern.id, ok: true });
    } catch (error) {
      results.push({ userId: intern.id, ok: false, error: (error as Error).message });
    }
  }
  return results;
}

/* ────────────────── 界面要用的现场数据 ────────────────── */

/**
 * 当日已完成的**有效**演习局数（训练期解锁闸门的分子）。
 *
 * ★ 为什么要有「有效」两个字 ★ 方案说的是「练够 3 局」，不看分数。
 * 但如果只数「开过局」，开三局各发一句就结束也算数，那这道闸门就只是三次点击。
 * 所以底线定在：正常结束 + 业务员自己说满 6 轮（或客户提前走人）。
 * ★ 这条底线要写进界面文案 ★ 不写，被拦住的人会以为是分数不够。
 *
 * ★ 2026-08-22 加第二条：还要出了报告 ★（王老师裁定）
 * 只卡 6 轮的话，「三次点击」只是变成「三次敷衍」：各聊六句、点一下「结束并复盘」
 * 把局置成 ENDED，然后**不答题、不评分**，当天的考试照样解锁——
 * 而这一整套系统的价值有一半在复盘那五问上。
 *
 * 同时它把系统里那两套「有效局」定义并成了一套：训练任务那边
 * （`training.taskSessionValid`）一直要求「已评分 + 报告已生成 + 复盘答满不跳过」，
 * 闸门这边却只要 6 轮。同一个词在同一个系统里有两个意思，迟早出事。
 *
 * ★ 只要求「出了分」，不要求「精确分」★ 证据不足拿不到精确局分不是学员的错
 * （判定那边也是这么分的），拿它去挡解锁就是冤枉人。
 *
 * ★ 2026-08-28 换掉第三条：复盘 → 干了活 ★（王老师裁 D4 选项 A）
 * 复盘五问改成可选之后，「出了分 ⇒ 复盘真做了」这条链断了，闸门又只剩
 * 「聊 6 轮 + 点评分」——N-6 修掉的「三次敷衍」会原样回来。
 * 所以第三条换成 `didRealWork()`：本局至少解锁 1 张暗牌，或至少开口问过 1 项六要素。
 * 仍然是行为量、不是水平门槛，但敷衍不出来。判据与理由见 `engine/facts.didRealWork`。
 */
export const VALID_DRILL_MIN_TURNS = ADMISSION_CONFIG.validDrillMinTurns;

export async function countDrillsToday(userId: string, day: string = businessDay()) {
  // ★ 按业务日在库里筛，不用「取最近 40 局再在内存里挑」★
  // 原来是 `take: 40` + 内存过滤：对「今天」够用，对**任何历史日子会静默返回 0**——
  // 最近 40 局早被后面几天的局占满了，一局都落不到那天。
  // 函数名叫 today，但它一直收 day 参数、也一直被人拿去问历史日子
  //（造数脚本的自检就是这么被坑的：明明造了演习，它答 0/3）。
  const from = new Date(`${day}T00:00:00+08:00`);
  const to = new Date(from.getTime() + 86_400_000);
  const sessions = await prisma.session.findMany({
    where: {
      userId,
      mode: 'DRILL',
      status: 'ENDED',
      // status=ENDED 一般都有 endedAt，但不敢赌：没有就退回 createdAt，口径与下面那行一致
      OR: [{ endedAt: { gte: from, lt: to } }, { endedAt: null, createdAt: { gte: from, lt: to } }],
    },
    orderBy: { endedAt: 'desc' },
    include: {
      // 变体自己的 difficulty 随 include 全字段带出来；解析走 variantDifficulty
      variant: { include: { persona: { select: { difficulty: true } } } },
      // 只取「有没有分」这一个事实，不把整份七力捞回来
      score: { select: { id: true } },
      _count: { select: { messages: { where: { role: 'trainee' } } } },
    },
  });
  const today = sessions.filter((session) => businessDay(session.endedAt ?? session.createdAt) === day);
  const valid = today.filter(
    (session) =>
      // 聊够了（或客户提前走人）
      (session._count.messages >= VALID_DRILL_MIN_TURNS || Boolean(session.exitReason)) &&
      // 出了报告
      session.score !== null &&
      // 且这一局真的干了活（见上面第三条）
      didRealWork(session.facts as unknown as SessionFacts),
  );
  // ★ 简单局照算进 done，另外单独数一遍非简单局 ★（2026-08-23）
  // 解锁要同时满足两条：局数够 + 其中至少 minNonSimpleDrillsForUnlock 局不是简单局。
  // 判定合并在纯函数 `admission-v11.unlockState` 里，这里只负责数数——
  // 两边各判一次，迟早出现「面板说解锁了、接口不给考」。
  const nonSimple = valid.filter((session) =>
    ['standard', 'hard'].includes(variantDifficulty(session.variant)),
  );
  return { done: valid.length, nonSimple: nonSimple.length, started: today.length };
}

/**
 * 当日考试状态。面板「今日」那一列。
 * ★ 数已出分的局，不看 attempt.verdict ★ 理由见 admission-v11.examStateOf
 */
export async function todayExamState(userId: string, day: string = businessDay()): Promise<ExamState> {
  const from = new Date(`${day}T00:00:00+08:00`);
  const to = new Date(from.getTime() + 86_400_000);
  const [attempt, scored] = await Promise.all([
    prisma.examAttempt.findFirst({
      where: { userId, businessDay: day, attemptType: 'DAILY' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.session.count({
      where: {
        userId,
        mode: 'ADMISSION_EXAM',
        score: { isNot: null },
        OR: [{ endedAt: { gte: from, lt: to } }, { endedAt: null, createdAt: { gte: from, lt: to } }],
      },
    }),
  ]);
  return examStateOf(scored, Boolean(attempt));
}

/** 次日登录时首页顶部那条横幅：只取「今天才生效」的那一条 */
export async function bannerForToday(userId: string, today: string = businessDay()) {
  const evaluation = await prisma.dailyEvaluation.findFirst({
    where: { userId, effectiveDay: today, banner: { not: null } },
    orderBy: { day: 'desc' },
  });
  return evaluation;
}

/* ────────────────── 人工覆盖（方案第二节）────────────────── */

/**
 * 管理员手动切换期别。
 *
 * ★ 从此不再自动改这个人的状态 ★ 不设到期时间——
 * v3.0 那套「覆盖 7 天后自动失效」是系统在替管理员撤销他自己的决定，
 * 而且撤的时候不通知任何人。锁就是锁，只能由人来解。
 */
export async function setStageByManager(input: {
  code: string;
  stage: Stage;
  operatorId: string;
  reason: string;
}) {
  const target = await prisma.user.findUnique({ where: { code: input.code } });
  if (!target) return;
  if (target.employeeType !== 'INTERN' || target.participationMode !== 'ADMISSION') return;
  const hadAccess = target.stage === 'ACTIVE';
  const today = businessDay();
  // 管到今天下班为止：今天 24:00（上海）。业务日的结论一结算，它就失效。
  const overrideUntil = new Date(new Date(`${today}T00:00:00+08:00`).getTime() + 86_400_000);
  await prisma.$transaction([
    prisma.user.update({
      where: { code: input.code },
      data: {
        stage: input.stage,
        stageOverride: true,
        stageSetBy: 'MANAGER',
        stageSetAt: new Date(),
        inquiryAccessStatus: accessStatusFor(input.stage, hadAccess),
        accessSetBy: 'MANAGER',
        accessSetAt: new Date(),
        accessEffectiveDay: today,
        overrideReason: input.reason,
        overrideUntil,
      },
    }),
    prisma.accessDecision.create({
      data: {
        subjectId: target.id,
        operatorId: input.operatorId,
        attemptIds: [],
        gateResults: { source: 'manager_stage_override', stage: input.stage },
        recommendedStatus: accessStatusFor(input.stage, hadAccess),
        appliedStatus: accessStatusFor(input.stage, hadAccess),
        manualOverride: true,
        reason: input.reason,
        effectiveDay: today,
        poolVersion: 'manual',
        scoreRuleVersion: 'manual',
      },
    }),
  ]);
}

/**
 * 恢复自动。
 * ★ 解锁的同时立刻按最近一次判定把状态摆正 ★
 * 否则「恢复自动」之后到明天结算之前，这个人挂着的还是人工设定的那个状态，
 * 而管理员以为自己已经把它交还给系统了。
 */
export async function restoreAutomaticStage(code: string, operatorId: string) {
  const target = await prisma.user.findUnique({ where: { code } });
  if (!target) return;
  const latest = await prisma.dailyEvaluation.findFirst({
    where: { userId: target.id },
    orderBy: { day: 'desc' },
  });
  const stage = (latest?.recommendedStage ?? target.stage) as Stage;
  const hadAccess = target.stage === 'ACTIVE';
  const today = businessDay();
  await prisma.$transaction([
    prisma.user.update({
      where: { code },
      data: {
        stage,
        stageOverride: false,
        stageSetBy: 'SYSTEM',
        stageSetAt: new Date(),
        inquiryAccessStatus: accessStatusFor(stage, hadAccess),
        accessSetBy: 'SYSTEM',
        accessSetAt: new Date(),
        accessEffectiveDay: today,
        overrideReason: null,
        overrideUntil: null,
      },
    }),
    prisma.accessDecision.create({
      data: {
        subjectId: target.id,
        operatorId,
        attemptIds: [],
        gateResults: { source: 'restore_automatic', stage },
        recommendedStatus: accessStatusFor(stage, hadAccess),
        appliedStatus: accessStatusFor(stage, hadAccess),
        manualOverride: false,
        reason: '管理员点了「恢复自动」，交回系统判定',
        effectiveDay: today,
        poolVersion: 'manual',
        scoreRuleVersion: 'manual',
      },
    }),
  ]);
}
