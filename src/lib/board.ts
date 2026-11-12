/**
 * 数据面板取数（方案第三节）
 *
 * ★ 不做排行榜 ★ 方案原话：7 个人考同一个池子，排名会直接催生对答案和挑软柿子。
 * 所以这里只有两个视图：管理员看全员一行一人，业务员看自己。
 * 任何按分数排序、任何「第 N 名」都不要往这儿加。
 */

import { prisma } from './db';
// ★ 中位数只用 exam.ts 那一份 ★ 这里原来有个私有副本，两份在空数组上行为不一致（见 exam.ts 的注释）
import { median } from './exam';
import { businessDay, clockOnly, recentBusinessDays, stamp } from './business-day';
import { calendarHealth, loadCalendarFor, loadCalendars, type CalendarHealth, type LeaveMark } from './work-calendar';
import {
  ADMISSION_CONFIG,
  buildWindow,
  examStateOf,
  fmt,
  type ExamState,
  judgeWindow,
  statusLine,
  unlockState,
  type GateView,
  type WindowSession,
  type WindowVerdict,
} from './admission-v11';
import {
  countDrillsToday,
  loadWindowSessions,
  previewWindow,
  startDayOf,
  todayExamState,
  VALID_DRILL_MIN_TURNS,
  type Stage,
} from './settlement';
import { didRealWork } from '../../engine/facts';
import { variantDifficulty } from './variant-difficulty';
import {
  EXAM_POOL_HEALTH,
  EXAM_SLOTS,
  EXAM_SLOT_LABEL,
  examSlotOf,
  type ExamSlot,
} from './exam';
import {
  baseTaskDoneOf,
  baseTaskTextOf,
  cellOf,
  dayInProgressOf,
  lockedDaysOf,
  type DayGate,
  type WindowCell,
} from './board-decide';
import type { SessionFacts } from '../../engine/types';

export interface DayRow {
  day: string;
  /** 当日那场考试的三局局分。证据不足的局是 null */
  scores: Array<number | null>;
  dayMedian: number | null;
  /** 当晚结算时那 6 局（当天 + 前一个业务日）的中位数 */
  rollingMedian: number | null;
  gates: GateView[];
  passed: boolean | null;
  sampleText: string;
  consecutiveFails: number;
  /** 这一场是否落在当前判定窗口（今天 + 前一个业务日）里 */
  inWindow: boolean;
  overrideActive: boolean;
  recommendedStage: Stage;
  appliedStage: Stage;
  banner: string | null;
}

interface EvaluationDetail {
  gates?: GateView[];
  sampleText?: string;
  pendingRedlines?: string[];
  effectiveRedlines?: string[];
}

/** detail 是 Json 列，类型系统管不住它。所有页面只许从这里收窄，别各写一套 */
export function readDetail(raw: unknown): EvaluationDetail {
  if (!raw || typeof raw !== 'object') return {};
  return raw as EvaluationDetail;
}

/** 某人的按日期倒序明细。管理员展开一个人、业务员看自己，用的是同一张表 */
export async function loadDayRows(userId: string, take = 10): Promise<DayRow[]> {
  const [attempts, evaluations] = await Promise.all([
    prisma.examAttempt.findMany({
      where: { userId, attemptType: 'DAILY' },
      orderBy: { businessDay: 'desc' },
      take,
    }),
    prisma.dailyEvaluation.findMany({ where: { userId }, orderBy: { day: 'desc' }, take }),
  ]);

  // 判定窗口＝今天 + 前一个业务日。表里要标出来哪几场真正在管事，
  // 否则主管会以为这几行都参与判定。
  // ★ 不能再写 slice(0, 6) ★ 那是「最近 6 局」，缺考的人会把上周的场次标成「在窗口内」。
  const windowIds = new Set(
    buildWindow(await loadWindowSessions(userId), businessDay(), await loadCalendarFor(userId))
      .map((slot) => slot.session?.sessionId)
      .filter((id): id is string => Boolean(id)),
  );

  const sessionIds = attempts.flatMap((attempt) => attempt.sessionIds);
  const scores = await prisma.score.findMany({
    where: { sessionId: { in: sessionIds } },
    select: { sessionId: true, rawScore: true, precise: true },
  });
  const scoreOf = (id: string) => {
    const hit = scores.find((score) => score.sessionId === id);
    return hit?.precise ? hit.rawScore : null;
  };

  const days = [...new Set([...attempts.map((a) => a.businessDay ?? a.day), ...evaluations.map((e) => e.day)])]
    .filter((day): day is string => Boolean(day))
    .sort((a, b) => (a < b ? 1 : -1))
    .slice(0, take);

  return days.map((day) => {
    const attempt = attempts.find((item) => (item.businessDay ?? item.day) === day);
    const evaluation = evaluations.find((item) => item.day === day);
    const detail = readDetail(evaluation?.detail);
    const dayScores = attempt ? attempt.sessionIds.map(scoreOf) : [];
    const valid = dayScores.filter((score): score is number => typeof score === 'number');
    return {
      day,
      scores: dayScores,
      dayMedian: valid.length > 0 ? median(valid) : null,
      rollingMedian: evaluation?.medianScore ?? null,
      gates: detail.gates ?? [],
      passed: evaluation?.passed ?? null,
      sampleText: detail.sampleText ?? (evaluation ? '' : '当晚尚未结算'),
      consecutiveFails: evaluation?.consecutiveFails ?? 0,
      inWindow: attempt ? attempt.sessionIds.some((id) => windowIds.has(id)) : false,
      overrideActive: evaluation?.overrideActive ?? false,
      recommendedStage: (evaluation?.recommendedStage ?? 'TRAINING') as Stage,
      appliedStage: (evaluation?.appliedStage ?? 'TRAINING') as Stage,
      banner: evaluation?.banner ?? null,
    };
  });
}


export interface RosterRow {
  userId: string;
  code: string;
  name: string;
  disabled: boolean;
  stage: Stage;
  stageOverride: boolean;
  stageSetBy: 'SYSTEM' | 'MANAGER';
  stageSetAt: Date;
  /** 「今日」那一列：已考 / 进行中 / 2/3 局，未考 */
  todayText: string;
  window: WindowVerdict;
  statusText: string;
  /** 系统判定推荐的期别。与 stage 不一致时，面板必须把两个都显示出来 */
  recommendedStage: Stage | null;
  consecutiveFails: number;
}

/**
 * 管理员主表。
 *
 * ★ 被人工覆盖的人要同时给两行 ★（方案第二节）
 * 只显示「在岗期」，管理员会忘记这是自己手动开的、且系统一直判不过；
 * 只显示系统判定，又不知道当前实际状态是什么。两个数字打架的时候，人要看得见在打架。
 *
 * ★ 停用的人不进来 ★（2026-08-22 补）这一处原来是全系统唯一没过滤 disabledAt 的取数：
 * loadDailyTaskRows、loadTodoBar、catchUpSettlement、settleAllInterns 四处都滤了，只有它没滤。
 * 后果有两个：白给停用的人算一次 previewWindow（每人多几次往返），
 * 而且账号一览那一行会继续挂着「系统算下来应该是 X」——一个已经停用的人，
 * 系统算他应该在岗期，读的人没法不困惑。
 */
export async function loadRoster(): Promise<RosterRow[]> {
  const today = businessDay();
  const users = await prisma.user.findMany({
    where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return Promise.all(
    users.map(async (user) => {
      const stage = user.stage as Stage;
      const [window, drills, examState, latest] = await Promise.all([
        previewWindow(user.id),
        countDrillsToday(user.id, today),
        todayExamState(user.id, today),
        prisma.dailyEvaluation.findFirst({ where: { userId: user.id }, orderBy: { day: 'desc' } }),
      ]);
      const unlock = unlockState(drills.done, stage);
      const todayText =
        examState === '已考'
          ? '已考'
          : examState === '进行中'
            ? '考试进行中'
            : stage === 'TRAINING'
              ? `${unlock.done}/${unlock.required} 局，未考`
              : '未考';
      return {
        userId: user.id,
        code: user.code,
        name: user.name,
        disabled: Boolean(user.disabledAt),
        stage,
        stageOverride: user.stageOverride,
        stageSetBy: user.stageSetBy as 'SYSTEM' | 'MANAGER',
        stageSetAt: user.stageSetAt,
        todayText,
        window,
        statusText: statusLine(window),
        recommendedStage: (latest?.recommendedStage ?? null) as Stage | null,
        consecutiveFails: latest?.consecutiveFails ?? 0,
      };
    }),
  );
}

/** 「✗ 差 7 分」这种一格字。达标就一个勾 */
export function verdictCell(window: WindowVerdict): string {
  if (!window.enough) return '样本不足';
  if (window.passed) return '✓';
  const failed = window.gates.filter((gate) => !gate.passed);
  const score = failed.find((gate) => gate.key === 'score');
  if (score) return `✗ 差 ${fmt(window.scoreGap)} 分`;
  return `✗ ${failed.map((gate) => gate.label).join('/')}`;
}

export { STAGE_LABEL } from './admission-v11';
export const WINDOW_SIZE = ADMISSION_CONFIG.windowSessions;

/** 载入今天的判定窗口（今天 + 前一个业务日）里那几局的明细，给展开区用。缺考的格子不返回 */
export async function loadWindowDetail(userId: string) {
  const sessions = await loadWindowSessions(userId);
  return buildWindow(sessions, businessDay(), await loadCalendarFor(userId))
    .map((slot) => slot.session)
    .filter((session): session is WindowSession => session !== null);
}

export { judgeWindow };

/* ══════════════ 教练台三张表的取数 ══════════════
 *
 * ★ 一条原则：只呈现库里真有的东西 ★
 * 这三张表全部来自已经在写的数据（Session / Score / ExamAttempt / DailyEvaluation /
 * RedlineReview / LoginEvent），没有任何推算出来的"指标"。
 */


/** 一个人一天一行（方案第三节的「今日」列，摊开成日历） */
export interface DailyTaskRow {
  day: string;
  userId: string;
  name: string;
  code: string;
  /** 那一天他处在哪个期别 */
  stage: Stage;
  drillDone: number;
  /** 训练期 3，在岗期 0 */
  drillRequired: number;
  examState: ExamState;
  /**
   * 那天他请假了。非 null 时整行不判定——那天对他不是业务日。
   * ★ 请假和缺考必须分开 ★ 一个是批过的，一个是没来；记成同一件事，
   * 等于让病假在台账上留下和翘考一样的痕迹。
   */
  onLeave: LeaveMark | null;
  /**
   * 这一行是不是「今天」。
   *
   * ★ 界面要靠它区分「缺考」和「还没考到」★ 今天上午十点，今天这三格当然是空的，
   * 画成红叉等于说他缺考——而他只是还没开始。过去的日子就没这个问题，空着就是缺考。
   */
  isToday: boolean;
  /**
   * 判定窗口那 6 个格子，**按时间从旧到新**：前一个业务日 3 格 + 这一天 3 格。
   *
   * ★ 2026-08-21 两格并一格 ★ 原来是「当日三局 / 中位」+「滚动 6 局中位数」。
   * 分开摆有两个毛病：① 当日中位 66（看着过了 65）、滚动中位 61.5（其实没过），
   * 一个绿一个红，一眼看过去容易读反，而判定只认后面那个；
   * ② 今日这一行的滚动列**永远是空的**——结算只跑已经过去的业务日。
   *
   * ★ 同日再改：格子按天排死，缺考就空着 ★ 原来这里摆的是「最近 6 局」，
   * 一个人昨天今天都没考，这一格照样摆着上周那 6 个漂亮分数，右边还跟一个「局分✓」。
   * 现在缺考的格子是 missing，界面画红叉，中位数也算不出判定来。
   */
  windowScores: WindowCell[];
  /** 上面那几个数的中位数（只算拿到精确局分的） */
  windowMedian: number | null;
  /** 6 个格子里实际有局的几个。不足 6 ＝有缺考，不构成判定 */
  windowCount: number;
  /** 其中有几局拿到了精确局分 */
  windowPrecise: number;
  /** 期别是不是主管人工设定的（人工设定期间自动判定照算照记，只是不执行） */
  stageOverride: boolean;
  /** 系统判定推荐的期别。与 stage 不一致时必须两个都显示出来 */
  recommendedStage: Stage | null;
  /** 按准入方案，这一天的基本任务完成没有 */
  baseTaskDone: boolean;
  baseTaskText: string;
  /**
   * 四条。
   *
   * ★ 今天这一行是现算的 ★（2026-08-21 合并「准入判定」那块之后）
   * 已经过去的日子读当晚结算的留档；今天没有留档——结算只跑过去的业务日——
   * 就拿此刻的窗口现judge 一遍。原来这一格今天永远写着「当晚尚未结算」，
   * 而主管中午要决定给谁分询盘，问的正是「他今天这场考完，现在过了没有」。
   */
  gates: GateView[];
  passed: boolean | null;
  sampleText: string;
  /**
   * 判定窗口里那些「考试没解锁」的日子及当天演习差多少。
   * 空数组＝窗口里没有这种日子。给「差在哪」那一格换一句准确的话用——
   * 引擎算出来的 sampleText 只会说「整天缺考」，它看不见演习。
   */
  lockedDays: Array<{ day: string; done: number; required: number }>;
  consecutiveFails: number;
}

/**
 * 窗口里的一格。★ 定义与判定都搬到 board-decide 了 ★（2026-08-28）
 * 这里保留导出，页面不用改 import。
 */
export type { WindowCell };

/**
 * 有效演习局。★ 口径必须和 `settlement.countDrillsToday` 一字不差 ★
 * 两套实现是有意的（这边一次捞全员、那边算一个人），但判据只有一套。
 *
 * ★ 2026-08-22 加了「出了分」这一条 ★ 只卡 6 轮的话，闸门拦得住「三次点击」，
 * 拦不住「三次敷衍」：各聊六句、点一下结束，不答复盘不评分，考试照样解锁。
 *
 * ★ 2026-08-28 加第三条「干了活」★ 复盘改可选之后，「出了分 ⇒ 复盘真做了」
 * 这条链断了，第二条挡不住敷衍了。第三条要求本局至少解锁 1 张暗牌、
 * 或至少开口问过 1 项六要素。理由详见 `engine/facts.didRealWork` 与 settlement.ts。
 */
function validDrill(session: {
  exitReason: string | null;
  score: { id: string } | null;
  facts: unknown;
  _count: { messages: number };
}): boolean {
  return (
    (session._count.messages >= VALID_DRILL_MIN_TURNS || Boolean(session.exitReason)) &&
    session.score !== null &&
    didRealWork(session.facts as SessionFacts)
  );
}

/**
 * 每日任务台账。
 *
 * @param days 往回摆几个业务日
 * @param onlyUserId 只算这一个人。★ 业务员的训练台用它 ★（2026-08-22）
 *   同一张表，主管看全员、业务员只看自己——过滤放在这里，页面就不必再筛一遍，
 *   也不会出现「页面忘了筛，把别人的行渲染出来」这种事。
 */
export async function loadDailyTaskRows(days = 7, onlyUserId?: string): Promise<DailyTaskRow[]> {
  const users = await prisma.user.findMany({
    where: {
      employeeType: 'INTERN',
      participationMode: 'ADMISSION',
      disabledAt: null,
      ...(onlyUserId ? { id: onlyUserId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  if (users.length === 0) return [];
  const ids = users.map((user) => user.id);
  // ★ 多取一个业务日 ★ 最老那一行的判定窗口要往前伸一天（窗口＝那天 + 前一个业务日）。
  // 不多取的话，最老一行左边三格永远判断不出「那天是不是没解锁」，只能一律当缺考。
  // ★ 日历先加载 ★ 台账有哪几天、判定窗口跳过哪几天，全看它。
  // 公司放假的日子根本不会进 dayList——没有行，就没有一排红叉。
  const calendars = await loadCalendars(ids);
  const mapDays = recentBusinessDays(days + 1, businessDay(), calendars.company);
  const dayList = mapDays.slice(0, days);
  const today = dayList[0]!;
  // ★ 只有真的就在这一天，才算「今天」★ 周六打开教练台时 dayList[0] 是周五，
  // 而周五已经过完了——它的空格是真缺考，不是「今天还没考到」。
  const liveDay = businessDay() === today ? today : null;
  const oldest = mapDays[mapDays.length - 1]!;
  // 多留两天缓冲：业务日是上海时区，UTC 边界上会差一天
  const since = new Date(`${oldest}T00:00:00+08:00`);

  const [drills, attempts, evaluations] = await Promise.all([
    prisma.session.findMany({
      where: { userId: { in: ids }, mode: 'DRILL', status: 'ENDED', endedAt: { gte: since } },
      select: {
        userId: true,
        endedAt: true,
        createdAt: true,
        exitReason: true,
        // 只取「有没有分」这一个事实——有效局还要求出了报告，见 validDrill
        score: { select: { id: true } },
        // 事实表：有效局第三条「干了活」读的就是它（暗牌 + 六要素），见 didRealWork
        facts: true,
        variant: { select: { difficulty: true, persona: { select: { difficulty: true } } } },
        _count: { select: { messages: { where: { role: 'trainee' } } } },
      },
    }),
    prisma.examAttempt.findMany({
      where: { userId: { in: ids }, attemptType: 'DAILY', businessDay: { in: dayList } },
    }),
    prisma.dailyEvaluation.findMany({ where: { userId: { in: ids }, day: { in: dayList } } }),
  ]);

  // ★ 每人的考试局捞一次，每一天的窗口在内存里切 ★
  // 判定窗口是「那天 + 前一个业务日」，每一行都不一样。
  // 一天一次查库是 天数 × 人数 次往返，没必要——一次捞够，judgeWindow 在内存里排格子。
  const examSessions = new Map<string, WindowSession[]>();
  /**
   * 台账有多少天，就要往回捞够多少局，否则最老那几行的窗口会是空的。
   *
   * ★ 2026-08-22 放宽到两倍 ★ 原来是 `days * 3 + 6`：台账 30 天算出来 96 局，
   * 而实际需要 31 个业务日 × 3 局 = 93 局——**只余 3 局的垫**。
   * 一天里有补考、有重开、有跨天才出分的局，多出来几局就会把最老那几行挤出捞取范围，
   * 窗口捞不到局 → 界面画红叉 → **误显示成缺考**。而缺考现在是要扣资格的，
   * 捞少了就是冤枉人（和 settlement.SETTLE_LOOKBACK_SESSIONS 那条注释是同一个道理）。
   * 乘 2 是给「一天不止 3 局」留的余量；真要根治得改成按业务日范围查，不按局数 take。
   */
  const lookback = (days + 1) * ADMISSION_CONFIG.sessionsPerExam * 2 + ADMISSION_CONFIG.windowSessions;
  await Promise.all(
    users.map(async (user) => {
      examSessions.set(user.id, await loadWindowSessions(user.id, undefined, lookback));
    }),
  );

  /**
   * 每人的起判日。**起判日当天及之前的格子不算他的**。
   *
   * ★ 口径直接用结算那一个函数，不在这儿另写一遍 ★（2026-08-22）
   * settlement.startDayOf 取「身份定下来那天」和「他第一场考试那天」里更早的一个。
   * 各写一套的话，会出现「台账画着入职前、结算却判了那天」这种自相矛盾。
   */
  const startDayOfUser = new Map<string, string>(
    users.map((user) => [user.id, startDayOf(user, examSessions.get(user.id) ?? [])]),
  );

  /** 那一天他实际处在哪个期别：结算记录里有就用它，没有（今天）就用当前状态 */
  const stageOn = (user: (typeof users)[number], day: string): Stage =>
    (evaluations.find((item) => item.userId === user.id && item.day === day)?.appliedStage ??
      user.stage) as Stage;

  /** 当日**有效**演习局数。口径必须和 settlement.countDrillsToday 一致，否则闸门两套算法 */
  const countedDrills = (userId: string, day: string) =>
    drills.filter(
      (session) =>
        session.userId === userId &&
        businessDay(session.endedAt ?? session.createdAt) === day &&
        validDrill(session),
    );

  /** 其中不是简单局的那些。解锁的第二道条件，口径同上 */
  const countedNonSimple = (userId: string, day: string) =>
    countedDrills(userId, day).filter((session) =>
      ['standard', 'hard'].includes(variantDifficulty(session.variant)),
    );

  // ★ 每人每天的开考闸门 ★ 判定窗口横跨两天，所以要按天存一份，
  // 光看「这一行那天」不够——左边三格属于前一个业务日。
  const gateOf = new Map<string, DayGate>();
  for (const user of users) {
    for (const day of mapDays) {
      // 请假那天没有开考要求，不该被算成「未解锁」
      if (calendars.leaveOn(user.id, day)) continue;
      const training = stageOn(user, day) === 'TRAINING';
      const required = training ? ADMISSION_CONFIG.dailyDrillMin : 0;
      const done = countedDrills(user.id, day).length;
      // ★ 走 unlockState，不在这儿另写一遍判定 ★（2026-08-23）
      // 「局数够 + 至少 1 局标准或困难」这条规则只该有一处实现。
      const unlocked = unlockState(
        done,
        training ? 'TRAINING' : 'ACTIVE',
        countedNonSimple(user.id, day).length,
      ).unlocked;
      gateOf.set(`${user.id}|${day}`, { done, required, unlocked });
    }
  }

  const rows: DailyTaskRow[] = [];
  for (const day of dayList) {
    for (const user of users) {
      const evaluation = evaluations.find((item) => item.userId === user.id && item.day === day);
      const stage = stageOn(user, day);
      const counted = countedDrills(user.id, day);
      const attempt = attempts.find((item) => item.userId === user.id && item.businessDay === day);
      // ★ 数当天已出分的考试局，不读 attempt.verdict ★ 理由见 admission-v11.examStateOf。
      // loadWindowSessions 只捞有 score 的局，所以这个数就是「已出分的局」，
      // 和右边那三个格子填的是同一批东西——两列证据同源，才不会自己打自己脸。
      const scoredToday = (examSessions.get(user.id) ?? []).filter(
        (session) => session.businessDay === day,
      ).length;
      // ★ 已经过完的日子传 dayOver ★（2026-08-22）不传的话，一个三周前开了考、
      // 一局没打完的日子，今天翻台账还写着「进行中 · 考试差 3 局」，像是还能回去接着打。
      const examState = examStateOf(scoredToday, Boolean(attempt), day !== liveDay);
      /**
       * 这一天还没过完，他今天还能去考。
       *
       * ★ 抽成变量是因为它有两个用处，而这两处曾经不一致 ★（2026-08-24 修）
       * 一处是判定（下面 judgeWindow 的 dayInProgress）：今天的空格算「还没考到」不算缺考；
       * 另一处是 `lockedDays`：今天演习才 1/3 局，他下午再练两局照样能考，
       * 现在就说他「今天未解锁」是提前定性——格子那边一直是这么画的（画「·」不画「锁」），
       * 但 lockedDays 原来没排除今天，于是同一行里格子说「今天还没考到」、
       * 「差在哪」说「今天考试没解锁」，两句话对着干。
       */
      const dayInProgress = dayInProgressOf(day, liveDay, examState);
      // ★ 这一天的判定窗口 = 这一天 + 前一个业务日，各 3 格 ★
      // judgeWindow 是纯函数（不查库），每一行现算一遍，口径与当晚结算完全一致。
      const verdict = judgeWindow(examSessions.get(user.id) ?? [], day, {
        // ★ 用他自己的日历 ★ 公司放假 + 他的请假，两样都要从窗口里跳过
        calendar: calendars.forUser(user.id),
        dayInProgress,
      });
      const startDay = startDayOfUser.get(user.id) ?? '';
      const gateFor = (d: string) => gateOf.get(`${user.id}|${d}`);
      const windowScores: WindowCell[] = verdict.slots.map((slot) =>
        cellOf(slot, gateFor(slot.day), startDay),
      );
      // ★ 今天还能补练，就不算今天未解锁 ★ 与格子那边同一条规则（见上面 dayInProgress）
      const lockedDays = lockedDaysOf(windowScores, gateFor, dayInProgress);
      // 今天没有结算留档（结算只跑已经过去的业务日），就用现算的这份
      const live = evaluation ? null : verdict;
      // 连续不达标天数：今天这一行还没结算，沿用最近一次结算的数
      const carried = evaluations
        .filter((item) => item.userId === user.id && item.day < day)
        .sort((a, b) => (a.day < b.day ? 1 : -1))[0];
      const required = stage === 'TRAINING' ? ADMISSION_CONFIG.dailyDrillMin : 0;
      const task = {
        training: stage === 'TRAINING',
        required,
        done: counted.length,
        examState,
        scoredToday,
      };
      const detail = readDetail(evaluation?.detail);

      rows.push({
        day,
        userId: user.id,
        name: user.name,
        code: user.code,
        stage,
        drillDone: counted.length,
        drillRequired: required,
        examState,
        onLeave: calendars.leaveOn(user.id, day),
        isToday: day === liveDay,
        windowScores,
        // ★ 已结算的日子以结算记录为准 ★ 右边「判定」列那几个勾叉是当晚结算算出来的，
        // 中位数若改用现算的，万一分数被重放改过，就会出现「中位 67」配「局分✗」这种自相矛盾的一行。
        // ★ 前提：改了判定口径必须重新结算 ★ 否则留档是老规则算的，
        // 而左边那 6 个格子是新规则摆的，两边对不上账。2026-08-21 改窗口口径时已整体重算过。
        windowMedian: evaluation?.medianScore ?? verdict.medianScore,
        windowCount: evaluation?.sampleCount ?? verdict.sampleCount,
        windowPrecise: evaluation?.preciseCount ?? verdict.preciseCount,
        baseTaskDone: baseTaskDoneOf(task),
        baseTaskText: baseTaskTextOf(task),
        stageOverride: evaluation?.overrideActive ?? user.stageOverride,
        recommendedStage: (evaluation?.recommendedStage ?? carried?.recommendedStage ?? null) as Stage | null,
        gates: detail.gates ?? live?.gates ?? [],
        passed: evaluation?.passed ?? live?.passed ?? null,
        sampleText: detail.sampleText ?? live?.sampleText ?? '',
        lockedDays,
        consecutiveFails: evaluation?.consecutiveFails ?? carried?.consecutiveFails ?? 0,
      });
    }
  }
  return rows;
}

/** 一局一行的流水。时间到秒——出问题要能对着时间线复盘 */
export interface FlowRow {
  sessionId: string;
  drillId: string;
  userName: string;
  userCode: string;
  /** 只分两类：自由询盘（不计入准入）／考试（计入准入） */
  kind: '自由询盘' | '考试';
  slot: string;
  personaName: string;
  variantId: string;
  startedAt: string;
  endedAt: string;
  /** 同一天多条时日期是噪音，只给时分秒 */
  startClock: string;
  endClock: string;
  day: string;
  turn: number;
  messageCount: number;
  rawScore: number | null;
  precise: boolean;
  tier: string | null;
  answerQuality: number | null;
  redlines: string[];
  statusText: string;
}

/** 局流水那一列的槽位名。吃的是**解析后**的档位，不是骨架的 */
function slotLabel(item: { sessionType: string; difficulty: string }): string {
  if (item.sessionType === 'FOLLOWUP') return '跟进';
  if (item.difficulty === 'hard') return '探需·困难';
  if (item.difficulty === 'standard') return '探需·标准';
  return '探需·简单';
}

export async function loadSessionFlow(limit = 80, userId?: string): Promise<FlowRow[]> {
  const sessions = await prisma.session.findMany({
    where: {
      ...(userId ? { userId } : {}),
      // 正式员工的校准局不属于这套方案，别混进实习业务员的流水里
      mode: { in: ['DRILL', 'ADMISSION_EXAM'] },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      user: { select: { name: true, code: true } },
      score: true,
      variant: { include: { persona: true } },
      _count: { select: { messages: true } },
    },
  });

  return sessions.map((session) => {
    const facts = session.facts as unknown as { redlines?: string[] };
    return {
      sessionId: session.id,
      drillId: session.drillId,
      userName: session.user.name,
      userCode: session.user.code,
      kind: session.mode === 'ADMISSION_EXAM' ? '考试' : '自由询盘',
      slot: slotLabel({ sessionType: session.variant.persona.sessionType, difficulty: variantDifficulty(session.variant) }),
      personaName: session.variant.persona.name,
      variantId: session.variant.variantId,
      startedAt: stamp(session.createdAt),
      endedAt: stamp(session.endedAt),
      startClock: clockOnly(session.createdAt),
      endClock: clockOnly(session.endedAt),
      day: businessDay(session.createdAt),
      turn: (session.state as { turn?: number } | null)?.turn ?? 0,
      messageCount: session._count.messages,
      rawScore: session.score?.rawScore ?? null,
      precise: session.score?.precise ?? false,
      tier: session.score?.tier ?? null,
      answerQuality: session.score?.answerQuality ?? null,
      redlines: facts.redlines ?? [],
      statusText: session.score
        ? session.score.precise
          ? '已评分'
          : '证据不足'
        : session.status === 'ENDED'
          ? '已结束·未评分'
          : '进行中',
    } satisfies FlowRow;
  });
}

/* ────────────────── 考试池健康度 ────────────────── */

export interface SlotHealth {
  slot: ExamSlot;
  label: string;
  /** 这个槽位有几份变体。硬门槛 14，不够开不了考 */
  variants: number;
  /** 这个槽位有几个**考点**。★ 真正决定会不会重复考点的是这个数 ★ */
  personas: number;
  /** 占比最大的那个考点。14 份题全来自 4 个考点时，它会是 40% 往上 */
  topPersona: { code: string; count: number; share: number } | null;
  /** 三条都达标（份数够、考点够、没有一个考点独大） */
  ok: boolean;
}

export interface ExamPoolHealth {
  slots: SlotHealth[];
  /**
   * 全员里**最快撞上重题**的那个人，还剩几个考试日。
   *
   * ★ 为什么按人算而不按池子算 ★ 池子是全员共用的，但"见过没见过"是一人一份。
   * 池子再大，对一个已经把某个槽刷完 12/14 的人来说，两天后照样开始重题。
   * 待办条要提醒的正是这件事——而它在漏洞台账 N-8 里挂了很久没人做。
   */
  tightest: { name: string; code: string; slot: ExamSlot; label: string; days: number } | null;
}

/**
 * 考试池健康度：三个槽位各自的份数/考点数/最大占比，加上全员最紧的那个「不重题天数」。
 *
 * ★ 门槛为什么挂在「考点数」上 ★（2026-08-28，见《题库管理方案》第六节）
 * 上线硬门槛一直只有「每槽 ≥14 份」，而 42 份题可以全部来自 4 个考点——
 * 换了国家品类人名，要问的东西一个字没变。防背题防的是考点，不是变体。
 */
export async function loadExamPoolHealth(): Promise<ExamPoolHealth> {
  const [variants, users] = await Promise.all([
    prisma.personaVariant.findMany({
      where: { poolType: 'ADMISSION_EXAM', active: true },
      select: {
        id: true,
        difficulty: true,
        persona: { select: { code: true, sessionType: true, difficulty: true } },
      },
    }),
    prisma.user.findMany({
      // ★ 两条轨都要算 ★ 正式业务员的周考抽的是同一个池，重题风险一模一样
      where: {
        disabledAt: null,
        OR: [
          { employeeType: 'INTERN', participationMode: 'ADMISSION' },
          { employeeType: 'REGULAR', participationMode: 'WEEKLY_EXAM' },
        ],
      },
      select: { id: true, name: true, code: true },
    }),
  ]);

  const slotOfVariant = new Map<string, ExamSlot>();
  for (const variant of variants) {
    // ★ 先解析档位再分槽 ★ 难度可能挂在变体上；直接传 persona 会漏掉覆盖，
    // 而漏掉的表现是"这份题被算进了错误的槽位"，不会报错。
    const slot = examSlotOf({ sessionType: variant.persona.sessionType, difficulty: variantDifficulty(variant) });
    if (slot) slotOfVariant.set(variant.id, slot);
  }

  const slots: SlotHealth[] = EXAM_SLOTS.map((slot) => {
    const items = variants.filter((variant) => slotOfVariant.get(variant.id) === slot);
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.persona.code, (counts.get(item.persona.code) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topPersona = top ? { code: top[0], count: top[1], share: top[1] / items.length } : null;
    return {
      slot,
      label: EXAM_SLOT_LABEL[slot],
      variants: items.length,
      personas: counts.size,
      topPersona,
      ok:
        items.length >= EXAM_POOL_HEALTH.minVariantsPerSlot &&
        counts.size >= EXAM_POOL_HEALTH.targetPersonasPerSlot &&
        (topPersona?.share ?? 0) <= EXAM_POOL_HEALTH.maxPersonaShare,
    };
  });

  let tightest: ExamPoolHealth['tightest'] = null;
  if (users.length > 0) {
    const seen = await prisma.session.findMany({
      where: { userId: { in: users.map((user) => user.id) }, mode: 'ADMISSION_EXAM' },
      select: { userId: true, variantId: true },
    });
    // 一人一套「见过哪些变体」。同一份题打过两次只算见过一次
    const seenBy = new Map<string, Set<string>>();
    for (const row of seen) {
      let set = seenBy.get(row.userId);
      if (!set) seenBy.set(row.userId, (set = new Set()));
      set.add(row.variantId);
    }
    for (const user of users) {
      const mine = seenBy.get(user.id) ?? new Set<string>();
      for (const health of slots) {
        const unseen = variants.filter(
          (variant) => slotOfVariant.get(variant.id) === health.slot && !mine.has(variant.id),
        ).length;
        if (!tightest || unseen < tightest.days) {
          tightest = { name: user.name, code: user.code, slot: health.slot, label: health.label, days: unseen };
        }
      }
    }
  }

  return { slots, tightest };
}

/** 顶部待办条：只放要立刻处理的两件事 */
export interface TodoBar {
  /**
   * 待办条说的「今日」= **最近一个业务日**，不一定是自然的今天。
   * ★ 必须和台账用同一个 ★ 周六打开教练台时，表格那边的第一行是周五；
   * 待办条若按周六去查考试记录，会一条都查不到、把全员列进「今日未考」。
   */
  today: string;
  /** 真实的今天不上班（周末或公司放假），上面那个 today 是往前找到的最近业务日 */
  restDay: boolean;
  notExamined: Array<{ name: string; code: string; stage: Stage; drillDone: number; drillRequired: number }>;
  stageChangedToday: Array<{ name: string; banner: string; stage: Stage }>;
  pendingCalibration: number;
  /**
   * 工作日历还够用几天。
   * ★ 摆在待办条上，是因为这类功能最常见的死法是没人维护 ★
   * `calendarMaintainedUntil()` 从 2026-08-21 写好起一直没人调用（死代码），
   * 而它自己的注释就写着「快到头了就在教练台待办条上报警」。现在真接上了：
   * 主管每天都会看这一条，日历见底会在这里先喊出来，而不是等国庆当天才发现。
   */
  calendar: CalendarHealth;
  /**
   * 考试池健康度。★ 摆在待办条上的理由和工作日历一模一样 ★
   * 池子见底不会报错，只会静静地开始重复考点——漏洞台账 N-8 挂了很久没人处理，
   * 正是因为没有任何地方会主动说一句。
   */
  pool: ExamPoolHealth;
}

export async function loadTodoBar(): Promise<TodoBar> {
  const users = await prisma.user.findMany({
    where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
    orderBy: { createdAt: 'asc' },
  });
  const calendars = await loadCalendars(users.map((user) => user.id));
  const realToday = businessDay();
  const today = recentBusinessDays(1, realToday, calendars.company)[0]!;
  const restDay = today !== realToday;
  const attempts = await prisma.examAttempt.findMany({
    where: { userId: { in: users.map((user) => user.id) }, attemptType: 'DAILY', businessDay: today },
  });
  // 今天已出分的考试局，一次查完按人分组——不要为每个人各查一次
  const from = new Date(`${today}T00:00:00+08:00`);
  const scoredToday = await prisma.session.findMany({
    where: {
      userId: { in: users.map((user) => user.id) },
      mode: 'ADMISSION_EXAM',
      score: { isNot: null },
      OR: [
        { endedAt: { gte: from, lt: new Date(from.getTime() + 86_400_000) } },
        { endedAt: null, createdAt: { gte: from, lt: new Date(from.getTime() + 86_400_000) } },
      ],
    },
    select: { userId: true },
  });
  const changed = await prisma.dailyEvaluation.findMany({
    where: { userId: { in: users.map((user) => user.id) }, effectiveDay: today, banner: { in: ['GRANTED', 'SUSPENDED'] } },
    include: { user: { select: { name: true } } },
  });

  const notExamined = [] as TodoBar['notExamined'];
  for (const user of users) {
    // 请假的人不该被催考试
    if (calendars.leaveOn(user.id, today)) continue;
    const attempt = attempts.find((item) => item.userId === user.id);
    const done = scoredToday.filter((session) => session.userId === user.id).length;
    // ★ 同一口径 ★ 原来是 `attempt.verdict !== null` 才算考完——三局都打完出了分、
    // 只是自动交卷失败的人，会被记进「今日未考」催去考一场他已经考完的试。
    if (examStateOf(done, Boolean(attempt)) === '已考') continue;
    const stage = user.stage as Stage;
    const drills = await countDrillsToday(user.id, today);
    notExamined.push({
      name: user.name,
      code: user.code,
      stage,
      drillDone: drills.done,
      drillRequired: stage === 'TRAINING' ? ADMISSION_CONFIG.dailyDrillMin : 0,
    });
  }

  return {
    today,
    restDay,
    notExamined,
    stageChangedToday: changed.map((item) => ({
      name: item.user.name,
      banner: item.banner ?? '',
      stage: item.appliedStage as Stage,
    })),
    pendingCalibration: await prisma.session.count({ where: { score: { isNot: null }, calibration: { is: null } } }),
    pool: await loadExamPoolHealth(),
    // ★ 按真实的今天算，不按 today（那是最近一个业务日）★ 「日历还剩几天」问的是自然日
    calendar: await calendarHealth(realToday),
  };
}

/** 表三：登录流水 */
export interface LoginRow {
  id: string;
  at: string;
  userName: string;
  userCode: string;
  kindText: string;
}

export async function loadLoginFlow(limit = 60, userId?: string): Promise<LoginRow[]> {
  const events = await prisma.loginEvent.findMany({
    where: userId ? { userId } : undefined,
    orderBy: { at: 'desc' },
    take: limit,
    include: { user: { select: { name: true, code: true } } },
  });
  return events.map((event) => ({
    id: event.id,
    at: stamp(event.at),
    userName: event.user.name,
    userCode: event.user.code,
    kindText: event.kind === 'FIRST_PASSWORD' ? '首次登录并设置口令' : '登录',
  }));
}

/** 账号管理那一列：每个人最后一次登录 */
export async function loadLastSeen(): Promise<Map<string, Date>> {
  const events = await prisma.loginEvent.findMany({
    orderBy: { at: 'desc' },
    select: { userId: true, at: true },
    take: 500,
  });
  // ★ 返回 Date，不返回格式化好的字符串 ★（2026-08-22）
  // 用它的地方要的是「今天 14:33」这种给人看的说法，字符串在这里就定死了，
  // 页面再想换个说法只能拿字符串去切。
  const map = new Map<string, Date>();
  for (const event of events) {
    if (!map.has(event.userId)) map.set(event.userId, event.at);
  }
  return map;
}
