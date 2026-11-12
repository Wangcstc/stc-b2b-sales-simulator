/**
 * 一轮对话里「客户这一轮开不开口」的**判定内核**——纯函数。
 *
 * ★ 为什么单拎这一小段 ★（2026-08-25）
 * `session-service.runTurn()` 不能像结算那样整段拆成纯函数——它中间夹着三次 LLM 调用
 * （抽取、扮演、客户侧抽取），那是真正的 I/O，拆不掉也不该假装拆得掉。
 * 但它里面**有一小段纯状态判定**，而且是全局最容易写错的一段：
 *
 *   业务员点了「报价」或「发目录」之后，客户**先不回话**，留一轮给他补充说明。
 *   （王铖原话：「客户先不要回复，等业务员再讲一句话后再回复，也就是给我们一些
 *   再解释清楚、说得更清楚的空间。」）
 *
 * 这段逻辑有三个互斥分支、两个布尔量互相牵制，错一个的后果都很难看：
 *   · 该开窗没开 —— 报完价客户立刻回，补充说明的机会没了，等于这个机制没上线；
 *   · 该关窗没关 —— 客户从此再也不开口，这一局卡死；
 *   · 离场了还开窗 —— 人都要走了还按住他等你补充，那不是训练是荒诞。
 * 三种都不会抛异常，只会让某一局悄悄变得不对劲。所以它值得被单独测。
 *
 * 这个文件受 `check-engine-purity` 看管，出现 prisma / LLM import 会让 verify 失败。
 */

import type { DeliverableKind, DrillState, ExitReason } from '../../engine/types';

/** 等待态：客户被什么动作按住了、按在第几轮、已经用掉几次补充机会 */
export type AwaitingReply = NonNullable<DrillState['awaitingReply']>;

export interface ReplyWindowInput {
  /** 这一轮是不是动作类（报价 / 发目录）。★ 判据是"是不是动作"，不是"是不是报价" ★
      文档 3.3 要求所有动作类按钮之后都留窗口 */
  isFormAction: boolean;
  /** 这一轮算出来的离场原因。非 null ＝ 这一局到此为止 */
  exitReason: ExitReason | null;
  /** 进这一轮时的等待态（来自 state.awaitingReply）。老局没有这个字段，读作 undefined */
  pending: AwaitingReply | undefined;
  /** 当前轮次 */
  turn: number;
  /** 这一轮的动作是什么。isFormAction 为 true 时必须给 */
  action?: 'quote' | DeliverableKind;
  /** 允许补充几轮。取 engine/rules 的 SUPPLEMENT_TURNS；0 ＝ 关掉这个机制 */
  supplementTurns: number;
}

export interface ReplyWindowDecision {
  /** 这一轮到底出不出客户回复。true ＝ 客户闭嘴，把话头留给业务员 */
  deferReply: boolean;
  /** 这一轮结束后 state.awaitingReply 该变成什么。undefined ＝ 不在等待态 */
  nextAwaiting: AwaitingReply | undefined;
  /** 分支名，只用于日志与测试断言，不参与任何判断 */
  branch: 'opening' | 'stillWaiting' | 'closing' | 'none';
}

/**
 * 客户这一轮开不开口。
 *
 * 三个互斥分支，顺序不能换：
 *  ① opening      —— 动作类那一轮开窗，客户闭嘴，used 从 0 起算
 *  ② stillWaiting —— 补充机会还没用完，客户继续闭嘴，used +1
 *  ③ closing      —— 用满了（或已离场），窗口关掉，客户这就开口
 *
 * ★ 已经走到离场就一律不留窗口 ★ 无论开窗还是续窗，exitReason 一出现就直接关。
 */
export function decideReplyWindow(input: ReplyWindowInput): ReplyWindowDecision {
  const { isFormAction, exitReason, pending, turn, supplementTurns } = input;

  const openingWindow = isFormAction && !exitReason && supplementTurns > 0;
  if (openingWindow) {
    return {
      deferReply: true,
      nextAwaiting: { turn, action: input.action ?? 'quote', used: 0 },
      branch: 'opening',
    };
  }

  const supplementUsed = pending ? pending.used + 1 : 0;
  const stillWaiting = Boolean(pending) && !exitReason && supplementUsed < supplementTurns;
  if (stillWaiting) {
    return {
      deferReply: true,
      nextAwaiting: { ...pending!, used: supplementUsed },
      branch: 'stillWaiting',
    };
  }

  // 客户这就要开口了，窗口关掉（本来就没开的话保持没开）
  return { deferReply: false, nextAwaiting: undefined, branch: pending ? 'closing' : 'none' };
}

/**
 * 这一轮该不该抛干扰项。
 *
 * 两种情况一律不抛，且**不消耗**（留着下一轮再抛）：
 * ① 客户这一轮不开口（deferReply）——干扰项是"客户主动说的话"，他都不说话哪来的干扰项；
 * ② 业务员这一轮说的是中文（红线④）——客户刚说完「我看不懂中文」，
 *    紧接着又主动抛一个新问题，两句话是打架的；而且红线④的教育意义
 *    **恰恰是这一轮白费了**，抛了干扰项这一轮就没白费。
 */
export function shouldFireDistractor(input: { deferReply: boolean; repliedInChinese: boolean }): boolean {
  return !input.deferReply && !input.repliedInChinese;
}

/* ═══════════════════ 轮内提示（2026-08-28 王老师裁 D9 选项 A） ═══════════════════ */

export interface TurnNudgeInput {
  /** 这一局是不是考试局。**考试局一律不给提示**，没有例外 */
  examMode: boolean;
  /** 已经打完的最后一轮。0 ＝ 还没开始聊 */
  turn: number;
  /** 这一局有没有结束（离场或已收尾）。结束了就别再提示了 */
  ended: boolean;
  /** 第 `turn` 轮解开了几张暗牌 */
  unlockedThisTurn: number;
  /** 第 `turn` 轮**新开口问**的六要素项数（含"问了客户没给"） */
  askedThisTurn: number;
  /** 第 `turn` 轮**新拿到**的六要素项数 */
  collectedThisTurn: number;
  /** 第 `turn` 轮是不是动作类（报价 / 发目录）。那一轮本来就不是用来问问题的 */
  formActionThisTurn: boolean;
  /**
   * **上一轮**是不是也没问出东西。
   *
   * ★ 为什么要看两轮，不是一轮 ★（2026-08-28 当天按真实数据改的）
   * 第一版是「这一轮没进展就提示」。`scripts/observe-run.ts` 拿真人已经打完的
   * 119 轮演习一量：**52% 的轮次都符合「没问出新东西」**——也就是说提示会在
   * 一半以上的轮次弹出来。那不是提醒，那是背景噪音，而背景噪音会被整个忽略，
   * 连带把真正该看见的那次也一起忽略掉。
   *
   * 一轮没进展很正常：寒暄、确认对方说的话、客户答得含糊要再确认一次，
   * 都不该被念一句。**连着两轮才是真的卡住了。**
   *
   * 第 1 轮没有上一轮，传 false（那一轮永远不提示——开场本来就在寒暄）。
   */
  previousTurnQuiet: boolean;
}

/**
 * 「这一轮你没拿到任何新信息」。**只在演习局出现，只说状态，不给问法。**
 *
 * ★ 为什么要有它 ★（《题库管理方案》第三节「反馈延迟在错误的位置」）
 * 一局要打完 6–20 轮才拿得到点评，而新人最该被纠正的恰恰是第 2、3 轮的问法——
 * 有没有利他外壳、有没有裸问用途。他要到局末才知道，那时候这一局已经废了。
 * 真实的教练是当场打断的。
 *
 * ★ 为什么只说状态，不给建议问法 ★（王老师裁定 D9 选项 A）
 * 给一句"你该这么问"学得更快，但演习和考试用的是**同一批考点**——
 * 练的时候看惯了提示，考试时反而更慌，而且那等于把答案发在半路上。
 * 所以这里只回答"刚才那一轮有没有推进"，怎么改是他自己的事，报告里才展开。
 *
 * ★ 判据全是现成的 ★ 不需要任何模型调用：暗牌解锁记在 `facts.unlockedCards[].turn`，
 * 六要素开口记在 `elements[].askedTurn`，拿到记在 `.turn`。所以这个提示零成本、
 * 也不会因为模型抖动而时有时无。
 *
 * ★ 报价/发目录那一轮不提示 ★ 那一轮他在交付，不是在问问题；
 * 而且系统本来就会按住客户留一轮给他补充说明（见 `decideReplyWindow`），
 * 这时候弹一句"你没问出东西"是在骂他做对的事。
 */
export function decideTurnNudge(input: TurnNudgeInput): string | null {
  if (input.examMode) return null;
  if (input.ended) return null;
  if (input.turn <= 0) return null;
  if (input.formActionThisTurn) return null;
  if (input.unlockedThisTurn > 0) return null;
  if (input.askedThisTurn > 0) return null;
  if (input.collectedThisTurn > 0) return null;
  // ★ 连着两轮才提示 ★ 一轮没进展很正常；实测 52% 的轮次都符合「没进展」，
  // 每轮都弹就是噪音。理由与那个数字见 `previousTurnQuiet` 的注释。
  if (!input.previousTurnQuiet) return null;
  return `连着两轮没问出新东西了（第 ${input.turn - 1}、${input.turn} 轮）——既没问到六要素，也没撬开客户的底牌。`;
}
