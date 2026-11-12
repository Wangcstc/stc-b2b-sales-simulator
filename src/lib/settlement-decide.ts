/**
 * 每晚结算的**判定内核**——纯函数，不碰数据库、不碰时钟。
 *
 * ★ 为什么要把这一段单拎出来 ★（2026-08-25）
 * 它原来长在 `settlement.ts` 的 `evaluateUserDay()` 中间：那个函数一口气做了三件事——
 * 先查四次库、再判一遍、最后写三张表。判定这一段本身是纯的（输入进来、结论出去，
 * 不依赖任何外部状态），但因为夹在 await 中间，**没有任何办法给它写测试**：
 * 想测「连续两天不达标要停分配」，得先在库里造一个人、造六局、造前一天的结算行。
 * 于是这套系统里最要紧的一段逻辑——决定一个实习业务员停不停询盘分配——
 * 是全项目唯一一块既复杂又零测试的地方。
 *
 * 现在按 engine/ 那套办法办：判定归判定（这里，纯的，可穷举测试），
 * 取数与写库归外壳（settlement.ts）。engine/ 已经证明了这条路走得通——
 * 那 9 个文件 0 处 prisma、83 个测试；而与它同等要紧的结算层此前一个测试都没有。
 *
 * ★ 这里只准 import 纯模块 ★ business-day / admission-v11 都是 0 处 prisma 的纯模块。
 * 一旦这里出现 `import { prisma }`，就说明判定又和取数缠回去了，
 * 请把取数挪回外壳，而不是在这里开个口子。
 */

import { businessDay, nextBusinessDay, type WorkCalendar } from './business-day';
import {
  ADMISSION_CONFIG,
  judgementFingerprint,
  overrideStillActive,
  type Stage,
  type WindowVerdict,
} from './admission-v11';

export type Banner = 'GRANTED' | 'KEPT' | 'WARNED' | 'SUSPENDED';

/**
 * 判定内核的全部输入。
 *
 * ★ 全部是已经取好的值 ★ 调用方（外壳）负责查库并把结果填进来。
 * 这样做的好处是测试里可以直接摆出「前一天连续失败 1 次、主管昨天锁过期别」这种局面，
 * 不用造数据库。
 */
export interface DayDecisionInput {
  /** 正在结算的业务日 */
  day: string;
  /** 窗口判定结果，来自 judgeWindow()（本身已是纯函数，且有测试） */
  verdict: WindowVerdict;
  /** 结算前这个人的期别 */
  stageBefore: Stage;
  /** User.stageOverride：主管是否人工设定过期别 */
  stageOverride: boolean;
  /** User.stageSetAt：主管设定那一刻。没设定过传 null */
  stageSetAt: Date | null;
  /** 前一次结算留下的连续不达标次数。没有前一行就传 0 */
  previousConsecutiveFails: number;
  /** 公司工作日历，用来算结论的生效日 */
  companyCalendar: WorkCalendar;
}

/** 判定内核的产物：正好是 DailyEvaluation 那一行（不含 userId / day） */
export interface DayDecision {
  effectiveDay: string;
  sessionIds: string[];
  sampleCount: number;
  preciseCount: number;
  medianScore: number | null;
  insightMedian: number | null;
  answerMedian: number | null;
  scoreOk: boolean;
  insightOk: boolean;
  redlineOk: boolean;
  answerOk: boolean;
  passed: boolean | null;
  detail: {
    gates: WindowVerdict['gates'];
    sampleText: WindowVerdict['sampleText'];
    pendingRedlines: WindowVerdict['pendingRedlines'];
    effectiveRedlines: WindowVerdict['effectiveRedlines'];
    ruleFingerprint: string;
  };
  consecutiveFails: number;
  stageBefore: Stage;
  recommendedStage: Stage;
  appliedStage: Stage;
  overrideActive: boolean;
  banner: Banner | null;
}

/**
 * 横幅文案该不该发、发哪一条。
 *
 * ★ 人工锁定期间不发横幅 ★（方案 9.6）
 * 预警横幅写的是「再有一天不达标，明天起将暂停」——而他被主管锁着，明天不会暂停。
 * 说一件不会发生的事，比不说更糟。状态条上的分数和距离照常显示，那才是他能行动的部分。
 */
export function bannerOf(input: {
  stageBefore: Stage;
  applied: Stage;
  passed: boolean | null;
  consecutiveFails: number;
  overrideActive: boolean;
}): Banner | null {
  const { stageBefore, applied, passed, consecutiveFails } = input;
  if (input.overrideActive) return null;
  if (stageBefore === 'TRAINING' && applied === 'ACTIVE') return 'GRANTED';
  if (stageBefore === 'ACTIVE' && applied === 'TRAINING') return 'SUSPENDED';
  if (stageBefore === 'ACTIVE' && passed === true) return 'KEPT';
  if (stageBefore === 'ACTIVE' && passed === false && consecutiveFails >= 1) return 'WARNED';
  return null;
}

/**
 * 连续不达标次数怎么滚。
 *
 * ★ 样本不足的日子既不加也不清零 ★ 「没考够」不是「没考好」，
 * 拿它去打断或延长连续计数，两个方向都是冤枉人。
 */
export function rollConsecutiveFails(passed: boolean | null, previous: number): number {
  if (passed === false) return previous + 1;
  if (passed === true) return 0;
  return previous;
}

/**
 * 系统推荐的期别（还没考虑人工锁定）。
 *
 * 达标就给在岗；连续不达标到线才退回训练期；其余一律维持原状——
 * 「今天没考够」不该把人往下推。
 */
export function recommendStage(input: {
  passed: boolean | null;
  consecutiveFails: number;
  stageBefore: Stage;
}): Stage {
  if (input.passed === true) return 'ACTIVE';
  if (input.passed === false && input.consecutiveFails >= ADMISSION_CONFIG.consecutiveFailsToSuspend) {
    return 'TRAINING';
  }
  return input.stageBefore;
}

/**
 * 判定内核。给定一天的窗口结论与这个人的当前状态，算出那一行留档该长什么样。
 *
 * ★ 纯函数 ★ 同样的输入永远给同样的输出；不查库、不写库、不读当前时间。
 */
export function decideDay(input: DayDecisionInput): DayDecision {
  const { day, verdict, stageBefore, companyCalendar } = input;

  const consecutiveFails = rollConsecutiveFails(verdict.passed, input.previousConsecutiveFails);

  /**
   * ★ 人工设定只管当天 ★（2026-08-22 王老师定，改了方案 v1.1 第二节的原规则）
   * 原来是「一旦人工设定，自动判定永远不再改这个人」——主管不可能每天盯着，
   * 结果就是有人被锁在在岗期，系统算出来该退训练期也不会动，而没人记得去解锁。
   * 现在：主管在 D 日设定 → D 日当天由他说了算；D 日的成绩一结算（次日凌晨），
   * 人工设定同时失效、标记清掉，系统从此接管。
   *
   * ★ 为什么用 stageSetAt 而不是 overrideUntil 来判 ★
   * overrideUntil 是 v3.0 遗留路径（redline-review）在读的「有效到某个时刻」，
   * 语义是时间戳不是业务日；这里要比的是业务日，直接读 stageSetAt 更准也不打架。
   */
  const overrideActive = overrideStillActive({
    stageOverride: input.stageOverride,
    setOnDay: input.stageOverride && input.stageSetAt ? businessDay(input.stageSetAt) : null,
    settlingDay: day,
  });

  const recommended = recommendStage({ passed: verdict.passed, consecutiveFails, stageBefore });
  const applied: Stage = overrideActive ? stageBefore : recommended;
  const banner = bannerOf({
    stageBefore,
    applied,
    passed: verdict.passed,
    consecutiveFails,
    overrideActive,
  });

  // 四条照常全算全存（allGates），只是不再都参与「过没过」。
  // ★ 按 key 取，不按下标 ★ 启用的条目一变，下标就错位——
  // 那会把「洞察力过没过」写进「局分过没过」那一列，且不报错。
  const gateOf = (key: 'score' | 'insight' | 'redline' | 'answer') =>
    verdict.allGates.find((gate) => gate.key === key)?.passed ?? false;

  return {
    // ★ 生效日走公司日历 ★ 用他个人的会更晚——他请假不代表这条结论要跟着推迟，
    // 停不停他的询盘分配，是公司这边的事
    effectiveDay: nextBusinessDay(day, companyCalendar),
    // ★ 存窗口那几格里真有的局 ★ 原来存的是 sessions.slice(0, 6)＝「最近 6 局」，
    // 缺考时会把上周的局记成本次判定的依据，事后复盘完全对不上账
    sessionIds: verdict.slots
      .map((slot) => slot.session?.sessionId)
      .filter((id): id is string => Boolean(id)),
    sampleCount: verdict.sampleCount,
    preciseCount: verdict.preciseCount,
    medianScore: verdict.medianScore,
    insightMedian: verdict.insightMedian,
    answerMedian: verdict.answerMedian,
    scoreOk: gateOf('score'),
    insightOk: gateOf('insight'),
    redlineOk: gateOf('redline'),
    answerOk: gateOf('answer'),
    passed: verdict.passed,
    detail: {
      gates: verdict.gates,
      sampleText: verdict.sampleText,
      pendingRedlines: verdict.pendingRedlines,
      effectiveRedlines: verdict.effectiveRedlines,
      // ★ 这一行是按哪套口径算出来的 ★（2026-08-22）
      // 改了阈值/窗口而没重算，留档就会带着老指纹留在库里，`ledger-audit` 认得出来。
      ruleFingerprint: judgementFingerprint(),
    },
    consecutiveFails,
    stageBefore,
    recommendedStage: recommended,
    appliedStage: applied,
    overrideActive,
    banner,
  };
}
