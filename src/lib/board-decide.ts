/**
 * 教练台每日任务行的**判定部分**（从 board.ts 抽出来，2026-08-28）
 *
 * ★ 为什么要抽 ★
 * `loadDailyTaskRows` 有 240 行，一条测试都没有——而它是主管每天早上唯一会看的那张表，
 * 也是「今天给谁分询盘」这个决定的全部依据。它历史上出过的每一个错都是同一类：
 * **把两种不同的空格画成了同一个红叉**。
 *   · 2026-08-22：入职前的日子画成缺考（新人第一天打开就看见三个红叉）
 *   · 2026-08-21：训练期没解锁的日子画成缺考（拿他做不到的事记他的账，且主管的动作相反）
 *   · 2026-08-24：今天上午的空格画成缺考 / lockedDays 又说今天未解锁，同一行两句话打架
 * 这些全部是纯逻辑，全部埋在一个 async 函数里面，**没法测**。抽出来之后每一条都能钉死。
 *
 * ★ 这里不许查库 ★ 输入全是已经捞好的普通对象。board.ts 负责取数，这里只负责判。
 * 有 DB 依赖的部分（有效演习局的口径）留在 board.ts，因为它的阈值住在 settlement。
 */

import { ADMISSION_CONFIG, type ExamState, type WindowSlot } from './admission-v11';

/** 某人某天的开考闸门状态。board.ts 先按「人|天」算好一张表 */
export interface DayGate {
  /** 那天有效演习局数 */
  done: number;
  /** 那天要求几局（训练期 3，在岗期 0） */
  required: number;
  /** 那天考试解锁了没有 */
  unlocked: boolean;
}

/** 判定窗口里的一格，摆在表格那一格里 */
export interface WindowCell {
  /** 分数。null 有两种：缺考（missing）或考了但证据不足 */
  score: number | null;
  day: string;
  /** 是不是这一行所属的那一天考的——亮的是当天，暗的是前一个业务日带过来的 */
  sameDay: boolean;
  /**
   * true = 这一格根本没有局。界面画红叉。
   * ★ 必须和「证据不足」分开 ★ 一个是没有这一局，一个是有局但系统没评出来，
   * 都画「—」的话，主管没法区分该找谁。
   */
  missing: boolean;
  /**
   * true = 这一格落在**他进来之前**。
   *
   * ★ 这既不是缺考也不是未解锁 ★（老漏洞 E 的另一半）结算侧早就用 startDayOf 挡住了
   * ——起判日之前不写留档；但**台账排格子时从来没看过入职日**，于是新人第一天打开教练台，
   * 左边三格是三个红叉，「差在哪」还写着「X 月 X 日 整天缺考」——那天他还不是员工。
   * 结论（不构成判定）是对的，理由是错的，而这是新人看到的第一屏。
   */
  beforeHire: boolean;
  /**
   * true = 这一格没有局，且**那天考试根本没解锁**（训练期当日演习没练够）。
   *
   * ★ 这不是缺考 ★（2026-08-21 王老师圈出来的第二个矛盾）
   * 训练期要当日 ≥3 局有效演习才开得了考试。演习 2/3 局的那天，
   * 系统压根不让他考——把这种日子写成「缺考」，是拿一件他做不到的事记他的账；
   * 而且主管要做的动作完全相反：缺考是催他去考，未解锁是催他去练。
   */
  locked: boolean;
}

/**
 * 这一天还没过完，他今天还能去考。
 *
 * ★ 抽成一个函数是因为它有两个用处，而这两处曾经不一致 ★（2026-08-24 修）
 * 一处是判定（judgeWindow 的 dayInProgress）：今天的空格算「还没考到」不算缺考；
 * 另一处是 `lockedDaysOf`：今天演习才 1/3 局，他下午再练两局照样能考，
 * 现在就说他「今天未解锁」是提前定性。两处必须读同一个值。
 *
 * @param liveDay 真的就是此刻这一天时传它，否则传 null。
 *   ★ 周六打开教练台时台账第一行是周五 ★ 而周五已经过完了——它的空格是真缺考。
 */
export function dayInProgressOf(day: string, liveDay: string | null, examState: ExamState): boolean {
  return day === liveDay && examState !== '已考';
}

/**
 * 把 judgeWindow 排好的一格翻译成界面上的一格。
 *
 * @param startDay 他的起判日。**起判日当天及之前的格子不算他的**
 * @param gate 那一天的开考闸门。**拿不到就传 undefined**——见下面 locked 的理由
 */
export function cellOf(slot: WindowSlot, gate: DayGate | undefined, startDay: string): WindowCell {
  const missing = slot.session === null;
  return {
    score: slot.session?.precise ? slot.session.rawScore : null,
    day: slot.day,
    sameDay: slot.sameDay,
    missing,
    // ★ 入职前的空格不是缺考 ★ 结算侧早就用同一个 startDayOf 挡住了（那几天不写留档），
    // 这里补上显示侧：那天他还不是员工，画红叉是拿一件他不可能做的事记他的账。
    beforeHire: missing && slot.day <= startDay,
    // ★ 拿不到那天的演习数据就不敢说「未解锁」★ 宁可按缺考显示，
    // 也不要凭没有的证据替人开脱——那会把真缺考的人也洗白
    locked: missing && gate !== undefined && !gate.unlocked,
  };
}

/**
 * 判定窗口里那些「考试没解锁」的日子，以及当天演习差多少。
 * 给「差在哪」那一格换一句准确的话用——引擎算出来的 sampleText 只会说
 *「整天缺考」，它看不见演习。
 *
 * 排序：新的在前。空数组 ＝ 窗口里没有这种日子。
 */
export function lockedDaysOf(
  cells: WindowCell[],
  gateOf: (day: string) => DayGate | undefined,
  dayInProgress: boolean,
): Array<{ day: string; done: number; required: number }> {
  const days = [
    ...new Set(
      cells
        // ★ 今天还能补练，就不算今天未解锁 ★ 与格子那边同一条规则（见 dayInProgressOf）
        .filter((cell) => cell.locked && !cell.beforeHire && !(cell.sameDay && dayInProgress))
        .map((cell) => cell.day),
    ),
  ].sort((a, b) => (a < b ? 1 : -1));

  const out: Array<{ day: string; done: number; required: number }> = [];
  for (const day of days) {
    const gate = gateOf(day);
    // cell.locked 为真就意味着 gate 存在（见 cellOf）；真拿不到就跳过，不编一个 0/0 出来
    if (gate) out.push({ day, done: gate.done, required: gate.required });
  }
  return out;
}

export interface BaseTaskInput {
  /** 训练期才有演习要求 */
  training: boolean;
  /** 那天要求几局 */
  required: number;
  /** 那天实际有效几局 */
  done: number;
  examState: ExamState;
  /** 那天已经出分的考试局数 */
  scoredToday: number;
}

/** 基本任务完成没有。演习和考试都要过 */
export function baseTaskDoneOf(input: BaseTaskInput): boolean {
  return input.done >= input.required && input.examState === '已考';
}

/**
 * 「基本任务」那一格写什么。
 *
 * ★ 顺序是有意的：先说演习，再说考试 ★ 训练期演习不够时考试根本开不了，
 * 这时候写「未考」是在催一件他做不到的事。
 */
export function baseTaskTextOf(input: BaseTaskInput): string {
  if (baseTaskDoneOf(input)) return '完成';
  if (input.training && input.done < input.required) return `演习差 ${input.required - input.done} 局`;
  if (input.examState === '进行中') {
    return `考试差 ${Math.max(1, ADMISSION_CONFIG.sessionsPerExam - input.scoredToday)} 局`;
  }
  // ★ 过去那天开了考没打完 ★ 不能写「考试差 N 局」——那是催他去打完，
  // 而那一天已经过完了，那几局永远补不上。
  if (input.examState === '已作废') return `那天只打了 ${input.scoredToday} 局就没了`;
  return '未考';
}
