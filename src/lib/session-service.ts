/**
 * 主循环编排（技术方案 3.2）
 *
 *   新人发消息
 *     → 调用①抽取
 *     → 引擎层：解锁判定 / 更新事实表 / 更新状态 / 行为指令 / 离场判定
 *     → 调用②扮演 + 泄露检查
 *     → 落库（含状态快照）
 *
 * ★ 编排在这里，判断在引擎里 ★
 * 这个文件只负责"按顺序把事情串起来"和 IO。任何 if 涉及到耐心怎么变、
 * 什么时候离场、哪张牌该解锁——都要在 engine/ 里，不许写在这。
 */

import { prisma } from './db';
import type {
  DrillState,
  SessionFacts,
  SessionType as EngineSessionType,
  Extraction,
  CustomerExtraction,
  DeliverableKind,
} from '../../engine/types';
import { DELIVERABLE_FILENAME, DELIVERABLE_LABEL } from '../../engine/types';
import { DEFAULT_RULES, SUPPLEMENT_TURNS } from '../../engine/rules';
// ★ 这一轮客户开不开口 ★ 判定在内核里（纯函数、有测试），见 turn-decide.ts 文件头
import { decideReplyWindow, shouldFireDistractor } from './turn-decide';
import { updateState, checkExit, decideDirective, collectRedlines } from '../../engine/state-machine';
import {
  updateFacts,
  applyCustomerAnswers,
  submitQuote,
  recordUnlock,
  addRedline,
  submitDeliverable,
  readRealQuantity,
  type QuoteForm,
} from '../../engine/facts';
import { detectUnlocks, syncUnlocksToFacts, type UnlockState, type HiddenCards } from '../../engine/unlock';
import { parseDistractors, pickDistractor } from '../../engine/distractor';
import { extract, extractCustomer } from './llm/extract';
import { roleplay, type PersonaConfig } from './llm/roleplay';
import { hasApiKey } from './llm/client';
import { isChineseReply } from '../../engine/language';

/**
 * 这一局已经在别处往前走了。
 *
 * ★ 为什么要有这个 ★
 * 同一个人在两个窗口（或两台电脑）开着同一局，两边都能发消息——不报错，
 * 但两段对话会交替插进同一条时间线，客户的回复前言不搭后语，这局就废了。
 * 而且新人不会意识到是自己干的，只会觉得"系统乱了"。
 *
 * 靠客户端带上"我看到的是第几轮"来判：对不上就说明另一个窗口先走了一步，
 * 这一发直接挡掉，让落后的那个窗口先同步。
 */
/**
 * 这一局已经结束了，还想往里发东西。
 *
 * ★ 为什么后端也要拦（2026-08-24 补）★
 * 界面早就按 `status === 'ENDED'` 锁了输入框，但接口从来没判过——
 * 一个已经出完分、报告都生成了的局，直接调 `/message` 还能继续往里写：
 * 轮次照涨、事实表照变，而**分数和报告是那一刻冻住的**，两边从此对不上账。
 * 事后谁也说不清这局到底是按哪份事实表判的。**藏 UI 不是权限**，这套系统别处都守着这条。
 */
export class SessionEndedError extends Error {
  constructor() {
    super('这一局已经结束了，不能再发消息。要复盘请去报告页。');
    this.name = 'SessionEndedError';
  }
}

export class StaleTurnError extends Error {
  constructor(readonly currentTurn: number, readonly expectedTurn: number) {
    super(`这局已经进行到第 ${currentTurn} 轮，你这个窗口停在第 ${expectedTurn} 轮`);
    this.name = 'StaleTurnError';
  }
}

export interface TurnResult {
  turn: number;
  customerReply: string;
  state: DrillState;
  facts: SessionFacts;
  freshUnlocks: string[];
  leakBlocked: number;
  exitReason: string | null;
  extraction: Extraction;
  violations: string[];
}

function personaFrom(variant: {
  openCard: unknown;
  product: unknown;
  hiddenCard: unknown;
  languageStyle: string;
}): PersonaConfig {
  return {
    openCard: variant.openCard as PersonaConfig['openCard'],
    product: variant.product as Record<string, unknown>,
    hiddenCard: variant.hiddenCard as HiddenCards,
    languageStyle: variant.languageStyle,
  };
}

/**
 * 跟进局要先把「三天前已报价、客户至今未读」这段前情落成第 0 轮消息。
 *
 * ★ 不这么做，抽取判不出空催 ★
 * 抽取靠上下文判 followup_level 与 is_empty_chase（08-04 实测：孤立一条消息时
 * followup_level 只有 86.7%，错的全是"不知道这是第几次跟进"）。
 * 跟进局的第 1 条消息本来就是"第 1 次跟进"，可如果库里一条历史都没有，
 * 模型只会当成普通开场白。
 */
async function seedFollowupBackstory(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  sessionId: string,
  inquiryText: string,
) {
  await tx.message.create({
    data: {
      sessionId,
      turn: 0,
      role: 'system',
      content: inquiryText,
    },
  });
}

/** 幂等：同一个 clientMsgId 重复提交直接返回已有结果（技术方案 11.3） */
async function findExisting(sessionId: string, clientMsgId?: string) {
  if (!clientMsgId) return null;
  return prisma.message.findFirst({
    where: { sessionId, clientMsgId },
    orderBy: { turn: 'asc' },
  });
}

export async function sendMessage(
  sessionId: string,
  content: string,
  clientMsgId?: string,
  expectedTurn?: number,
): Promise<TurnResult> {
  const dup = await findExisting(sessionId, clientMsgId);
  if (dup) {
    const session = await loadSession(sessionId);
    const reply = await prisma.message.findFirst({
      where: { sessionId, turn: dup.turn, role: 'customer' },
    });
    return {
      turn: dup.turn,
      customerReply: reply?.content ?? '',
      state: session.state,
      facts: session.facts,
      freshUnlocks: [],
      leakBlocked: 0,
      exitReason: session.exitReason,
      extraction: (dup.extraction as unknown as Extraction) ?? { asked_elements: [], asked_question: false },
      violations: [],
    };
  }
  return runTurn(sessionId, { traineeMessage: content, clientMsgId, expectedTurn });
}

export async function submitQuoteTurn(
  sessionId: string,
  form: QuoteForm,
  clientMsgId?: string,
  expectedTurn?: number,
): Promise<TurnResult> {
  return runTurn(sessionId, { quoteForm: form, clientMsgId, expectedTurn });
}

/**
 * 投递一份资料给客户（本轮只有「发产品目录」）。
 *
 * ★ 为什么它得是一个动作而不是一句话 ★ 见 `engine/types.ts` 的 DELIVERABLE_KINDS 注释：
 * 业务员在聊天框里说 "I'll send you the catalog"，对系统而言与"承诺稍后发"无异，
 * 客户于是一轮轮继续要，点评还判他拖着不给。走这条路，动作才真的发生。
 *
 * 与报价同构：占一个完整回合、消息由代码生成、不跑抽取、不判红线④。
 */
export async function submitDeliverableTurn(
  sessionId: string,
  kind: DeliverableKind,
  clientMsgId?: string,
  expectedTurn?: number,
): Promise<TurnResult> {
  return runTurn(sessionId, { deliverable: kind, clientMsgId, expectedTurn });
}

/**
 * 「我说完了，让客户回复」——主动关掉补充说明窗口（2026-08-19 反馈 #7）。
 *
 * ★ 为什么必须有这条出口 ★ 窗口是"客户先不说话"，不是"客户永远不说话"。
 * 业务员报完价觉得没什么要补的，得有办法让局面走下去，不能逼他为了推进而硬凑一句废话——
 * 那正好训练出反效果。
 *
 * ★ 它不是一轮 ★ 不写业务员消息、不推进轮次、不跑抽取、不动状态值。
 * 客户的回复挂在动作那一轮上，于是这一轮回到"业务员一条 + 客户一条"的正常形态。
 * 状态值不动是有意的：他什么都没做，凭什么扣他每轮衰减。
 *
 * ★ 单独写一个函数，不往 runTurn 里加第三种模式 ★ runTurn 的形状是
 * 「业务员说了一句 → 引擎算 → 客户回」，这条路一句都没说，硬塞进去会让那三段
 * 到处都是 if。这里只借用它的后半段（扮演 + 客户侧抽取 + 落库）。
 */
export async function resolvePendingReply(sessionId: string, expectedTurn?: number): Promise<TurnResult> {
  const s = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { variant: true, messages: { orderBy: { turn: 'asc' } } },
  });

  if (s.status === 'ENDED') throw new SessionEndedError();

  const state = s.state as unknown as DrillState;
  let facts = s.facts as unknown as SessionFacts;
  const unlock = s.unlockState as unknown as UnlockState;
  const persona = personaFrom(s.variant);
  const pending = state.awaitingReply;

  if (expectedTurn !== undefined && expectedTurn !== state.turn) {
    throw new StaleTurnError(state.turn, expectedTurn);
  }
  if (!pending) throw new Error('这一局现在没有在等你补充说明，客户随时会回你');

  const turn = state.turn;
  const nextState: DrillState = { ...state, awaitingReply: undefined };

  // 客户这就要开口了，干扰项照常可以搭在这句话里
  const fired = facts.distractorsFired ?? [];
  const distractor = pickDistractor(parseDistractors(s.variant.distractors), turn, fired);
  if (distractor) facts = { ...facts, distractorsFired: [...fired, distractor.code] };

  const history = s.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: (m.role === 'trainee' ? 'trainee' : 'customer') as 'trainee' | 'customer', content: m.content }));

  let customerReply: string;
  let leakBlocked = 0;
  if (!hasApiKey()) {
    customerReply = '（未配置 DEEPSEEK_API_KEY，客户无法回复。请在 .env 里填好后重启。）';
  } else {
    const rp = await roleplay({
      persona,
      unlock,
      directive: decideDirective(nextState),
      history,
      sessionId,
      ...(distractor ? { distractor: distractor.content } : {}),
      delivered: (facts.deliverables ?? []).map((d) => d.kind),
    });
    customerReply = rp.reply;
    leakBlocked = rp.leakBlocked.length;
  }

  let customerExtraction: CustomerExtraction = { answered_elements: [], vague_elements: [] };
  if (hasApiKey()) {
    customerExtraction = await extractCustomer({
      reply: customerReply,
      // ★ 上下文给的是动作那一轮说的话 ★ 客户回的就是它
      askedContext: history.filter((h) => h.role === 'trainee').at(-1)?.content ?? '',
      sessionId,
    });
    facts = applyCustomerAnswers(facts, customerExtraction, turn);
  }

  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
      const fresh = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { state: true } });
      const cur = fresh.state as unknown as DrillState;
      // ★ 窗口已经被别的窗口关掉了就整发作废 ★ 否则同一轮会写出两条客户回复
      if (cur.turn !== turn || !cur.awaitingReply) throw new StaleTurnError(cur.turn, turn);

      await tx.message.create({
        data: {
          sessionId,
          turn,
          role: 'customer',
          content: customerReply,
          extraction: customerExtraction as unknown as object,
          stateSnapshot: nextState as unknown as object,
          leakBlocked: leakBlocked > 0 ? ({ count: leakBlocked } as object) : undefined,
        },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { state: nextState as unknown as object, facts: facts as unknown as object },
      });
    },
    { timeout: 15_000 },
  );

  return {
    turn,
    customerReply,
    state: nextState,
    facts,
    freshUnlocks: [],
    leakBlocked,
    exitReason: s.exitReason,
    extraction: { asked_elements: [], asked_question: false },
    violations: [],
  };
}

async function loadSession(sessionId: string) {
  const s = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { variant: true, messages: { orderBy: { turn: 'asc' } } },
  });
  return {
    row: s,
    state: s.state as unknown as DrillState,
    facts: s.facts as unknown as SessionFacts,
    unlock: s.unlockState as unknown as UnlockState,
    exitReason: s.exitReason,
  };
}

/**
 * 跑一轮。**读 → 算 → 写，三段。两次 LLM 调用在事务外面。**
 *
 * ★ 为什么要拆 ★（2026-08-22）
 * 原来整轮都包在一个 `$transaction(..., { timeout: 120_000 })` 里，于是一条 Postgres 连接
 * 会被**两次模型往返**整整占住——顺利时 3–15 秒，模型抖一下更久。云数据库的免费档
 * 连接数有限：十来个人同时聊天就可能把 pooled 连接吃满，**表现是别的页面开始超时**，
 * 而日志里根本看不出是谁占着。更糟的是那 120 秒一到，整轮回滚——
 * 业务员看到的是「发了但没反应」，而模型的钱已经花掉了。
 *
 * 现在只有第三段进事务，事务里没有任何网络调用，通常几毫秒。
 *
 * ★ 并发怎么防 ★ 第一段读的时候记下 `startTurn`；第三段拿到行锁之后**再核一次**：
 * 轮次变了，说明另一个窗口（或另一台机器）已经先走了一步，这一发整个作废。
 * 代价是那两次模型调用白花了——**但绝不会写出一条前言不搭后语的时间线**。
 * 用钱换正确，这个方向不能反。
 *
 * ★ 串行锁仍然走数据库，不用内存锁 ★——多实例下内存锁完全失效（技术方案 15.1）。
 */
async function runTurn(
  sessionId: string,
  input: {
    traineeMessage?: string;
    quoteForm?: QuoteForm;
    /** 动作类交付（本轮只有「发产品目录」）。与 quoteForm 互斥，见 submitDeliverableTurn */
    deliverable?: DeliverableKind;
    clientMsgId?: string;
    expectedTurn?: number;
  },
): Promise<TurnResult> {
  // ───────────────── 一、读快照（不开事务，不占着连接算） ─────────────────
  const s = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: { variant: true, messages: { orderBy: { turn: 'asc' } } },
  });

  // ★ 已经结束的局一律挡在门外 ★ 见 SessionEndedError：出完分之后还能往里写，
  // 事实表就会跟已经冻住的报告对不上账。
  if (s.status === 'ENDED') throw new SessionEndedError();

  let state = s.state as unknown as DrillState;
  /** 这一发是基于第几轮算出来的。第三段写之前要拿它跟库里再核一次 */
  const startTurn = state.turn;

  if (input.expectedTurn !== undefined && input.expectedTurn !== startTurn) {
    throw new StaleTurnError(startTurn, input.expectedTurn);
  }

  let facts = s.facts as unknown as SessionFacts;
  let unlock = s.unlockState as unknown as UnlockState;
  const persona = personaFrom(s.variant);
  const turn = startTurn + 1;

  /**
   * ★ 标尺不跟难度系数走 ★（2026-08-23 王老师裁定）
   *
   * 曾经让 α 同时缩放这张表，被否了——那是两套机制干一件事，而且客户情绪
   * 只能间接影响局分，调起来看不出因果。现在 α 只作用在最终局分上
   * （见 `engine/difficulty.ts`），这张表是固定的。
   */
  const rules = DEFAULT_RULES;

  /**
   * 跟进局第一次进来要补前情（三天前已报价、客户至今未读），否则抽取判不出这是第几次跟进。
   *
   * ★ 先只在内存里补，写库留到第三段 ★ 让「前情」和本轮两条消息在**同一个事务**里落地。
   * 分开写的话，一旦这一轮失败（模型超时、并发作废），库里会留下一局只有前情、
   * 没有任何对话的残局——而它看起来和一局正常的跟进局一模一样。
   */
  const seedBackstory = s.type === 'FOLLOWUP' && s.messages.length === 0;
  const prior: { turn: number; role: string; content: string }[] = s.messages.map((m) => ({
    turn: m.turn,
    role: m.role,
    content: m.content,
  }));
  if (seedBackstory) prior.unshift({ turn: 0, role: 'system', content: persona.openCard.inquiry_text });

  // ───────────────── 二、算（LLM + 引擎，全程不占事务） ─────────────────

  /**
   * ★ 动作类按钮走的是同一条路 ★（2026-08-19 反馈 #4）
   * 报价、发目录都不是"业务员打的字"，是系统按模板拼出来的一条动作记录。
   * 凡是这类消息，下面三件事一律照同一口径处理：不判红线④、不跑抽取、消息内容由代码生成。
   */
  const isFormAction = input.quoteForm !== undefined || input.deliverable !== undefined;

  // ── 新人这一轮说了什么 ──
  const traineeText = input.quoteForm !== undefined
    ? formatQuoteMessage(input.quoteForm)
    : input.deliverable !== undefined
      ? formatDeliverableMessage(input.deliverable)
      : (input.traineeMessage ?? '');

  /**
   * ── 红线④：用中文作答（王老师 2026-08-23）──
   *
   * ★ 纯代码判，不问模型 ★ CJK 正则 100% 可靠，没有解释空间。
   * ★ 只判业务员自己打的字 ★ 报价表单/发目录那条消息是系统按模板拼出来的中文，
   *   拼的人是我们不是他，判它碰红线纯属冤枉。
   */
  const repliedInChinese = !isFormAction && isChineseReply(traineeText);

  // ── 调用①抽取（带上下文） ──
  let extraction: Extraction = { asked_elements: [], asked_question: false };
  let violations: string[] = [];
  if (hasApiKey() && !isFormAction) {
    const r = await extract({ message: traineeText, context: prior, sessionId });
    extraction = r.extraction;
    violations = r.violations;
  }

  /**
   * ★ 发目录这一轮的抽取由代码写死，不问模型 ★
   *
   * `sent_catalog` 原本靠模型从聊天里读"他是不是声称发了目录"。现在动作真实发生了，
   * 这件事是确定的，没有判断余地——照报价那条路的规矩，能纯代码判的就不交给模型。
   *
   * ★ 置上它是为了让 `catalogBeforeNeeds` 照常触发 ★ 需求还没问清就先甩目录，
   * 该扣的 interest 一分不少（见 state-machine）。做了按钮不等于给这个动作免罪，
   * 只等于让它**真的发生**。
   */
  if (input.deliverable === 'catalog') {
    extraction = { ...extraction, sent_catalog: true };
  }

  if (repliedInChinese) {
    /**
     * ★ 中文轮不给六要素功劳 ★
     * 客户根本没读到这句话，谈不上"他问过了"。留着 asked_elements 的话，
     * 要素会被推到「问了没答」，界面上显示成"你问过了，等客户给"——
     * 而客户永远不会给，因为他压根不知道你问了什么。
     *
     * ★ 写进 extraction 而不是只放在内存里 ★ 回放工具读的是 `Message.extraction`。
     */
    extraction = { ...extraction, asked_elements: [], asked_element_evidence: [], replied_in_chinese: true };
    violations = [...violations, '这一轮用中文作答（红线④）：客户读不懂，六要素不计入'];
  }

  // ── 引擎层：解锁 → 事实 → 状态 → 指令 → 离场 ──
  const un = detectUnlocks(persona.hiddenCard, traineeText, unlock, turn);
  unlock = un.state;
  for (const key of un.fresh) facts = recordUnlock(facts, key, turn);
  facts = syncUnlocksToFacts(facts, unlock);
  facts = updateFacts(facts, extraction, turn, 'asked');

  // ★ 交付动作落事实表 ★ 必须在 updateState 之前——`catalogBeforeNeeds` 判的是
  // 「发目录那一刻产品属性收集了没有」，落表顺序错了就会用发完之后的状态去判发之前的事。
  if (input.deliverable) facts = submitDeliverable(facts, input.deliverable, turn);

  let quoteRecord;
  if (input.quoteForm) {
    const realQty = readRealQuantity(persona.hiddenCard);
    const q = submitQuote(facts, input.quoteForm, turn, realQty);
    facts = q.facts;
    quoteRecord = q.quote;
  }

  // 背调识破判定：发起过背调、查过交叉验证项、且本轮用矛盾点提问 → 判为识破预埋错误
  // （需求 6.4 洞察力 5 分的新增达成路径）
  if (facts.bgInitiated && extraction.contradiction_probe && !facts.bgErrorDetected) {
    const crossChecked = (facts.bgItemsViewed ?? []).some((v) => v !== 'ai_report');
    if (crossChecked) facts = { ...facts, bgErrorDetected: true };
  }

  const upd = updateState(state, extraction, facts, rules, { quote: quoteRecord });
  state = upd.state;

  // ★ 红线落表 ★ 之前只有报价路径记了 R1，R2/R3 从未落表——那样报告里红线永远是空的
  for (const r of collectRedlines(upd.hits, rules)) facts = addRedline(facts, r);

  const exitReason = checkExit(state, facts, s.type === 'FOLLOWUP' ? 'followup' : 'inquiry', rules);

  /**
   * ── 补充说明窗口（2026-08-19 反馈 #7）──
   *
   * 王铖原话：「客户先不要回复，等业务员再讲一句话后再回复，也就是给我们一些
   * 再解释清楚、说得更清楚的空间。」文档第 3.3 条还要求这个机制**不止用于报价**，
   * 所有动作类按钮之后都留窗口——所以判据是 `isFormAction`，不是"是不是报价"。
   *
   * ★ 已经走到离场就不留窗口 ★ 人都要走了还按住他等你补充，那不是训练是荒诞。
   * 离场分支照常立刻出结果。
   *
   * ★ 窗口只在动作那一轮开 ★ 开完之后进入 awaitingReply，后续的普通消息由
   * 下面的 `resolvesWindow` 决定是"再补一句"还是"说完了，让客户回"。
   */
  // ★ 三个分支的判定在 turn-decide.ts ★ 纯函数、有测试；这里只负责把结论贴回 state
  const window = decideReplyWindow({
    isFormAction,
    exitReason,
    pending: state.awaitingReply,
    turn,
    action: input.quoteForm ? 'quote' : input.deliverable,
    supplementTurns: SUPPLEMENT_TURNS,
  });
  const deferReply = window.deferReply;
  // ★ 'none' 分支不碰 state ★ 本来就没有 awaitingReply 这个键时，
  // 写一个 `awaitingReply: undefined` 进去虽然序列化后一样，但会在内存里凭空多一个键；
  // 与其依赖"JSON.stringify 会丢掉 undefined"这个假设，不如原样不动。
  if (window.branch !== 'none') {
    state = { ...state, awaitingReply: window.nextAwaiting };
  }

  const directive = decideDirective(state, { chineseReceived: repliedInChinese });

  // 本轮该不该抛干扰项。挑选逻辑在 engine/distractor.ts，这里只负责串起来
  const fired = facts.distractorsFired ?? [];
  /**
   * ★ 中文轮不抛干扰项 ★（2026-08-23 冒烟跑出来的）
   *
   * 客户刚说完「我看不懂中文」，紧接着又主动抛一个新问题，两句话是打架的：
   * 指令里明写着「不要提供任何新信息」，干扰项却硬塞了一条进去。
   * 更实际的问题是，那样这一轮就没白费——而红线④的教育意义**恰恰是这一轮白费了**。
   *
   * 干扰项不消耗、留着下一轮再抛（`fired` 不记，`pickDistractor` 下轮照样能选中它）。
   */
  // ★ 客户这一轮不开口就不抛干扰项 ★ 干扰项是"客户主动说的话"，他都不说话哪来的干扰项。
  //   不消耗、留着他真开口那一轮再抛（`fired` 不记，pickDistractor 下轮照样能选中它）。
  const distractor = shouldFireDistractor({ deferReply, repliedInChinese })
    ? pickDistractor(parseDistractors(s.variant.distractors), turn, fired)
    : null;
  if (distractor) facts = { ...facts, distractorsFired: [...fired, distractor.code] };

  // ── 调用②扮演 + 泄露检查 ──
  let customerReply: string;
  let leakBlocked = 0;
  if (deferReply) {
    // 客户这一轮不说话——这不是没回复，是他还没轮到（补充说明窗口开着）
    customerReply = '';
  } else if (exitReason === 'patienceZero' || exitReason === 'stagnant') {
    customerReply = '[客户已离开对话]';
  } else if (exitReason === 'maxTurns') {
    customerReply = readExitLine(s.variant.exitLines, 'maxTurns');
  } else if (!hasApiKey()) {
    customerReply = '（未配置 DEEPSEEK_API_KEY，客户无法回复。请在 .env 里填好后重启。）';
  } else {
    const rp = await roleplay({
      persona,
      unlock,
      directive,
      history: [
        ...prior.map((m) => ({
          role: (m.role === 'trainee' ? 'trainee' : 'customer') as 'trainee' | 'customer',
          content: m.content,
        })),
        { role: 'trainee' as const, content: traineeText },
      ],
      sessionId,
      ...(distractor ? { distractor: distractor.content } : {}),
      // ★ 已投递的资料 ★ 客户据此不再重复索要（2026-08-19 反馈 #4）
      delivered: (facts.deliverables ?? []).map((d) => d.kind),
    });
    customerReply = rp.reply;
    leakBlocked = rp.leakBlocked.length;
  }

  // ── 调用④：客户这一条里，六要素真的给了哪几项 ──
  //
  // ★ 这一步 2026-08-23 之前根本不存在 ★ 系统只读业务员说了什么，从不读客户答了什么。
  // 所以「问了客户没给也打勾」和「客户给了却抓不到」是同一个洞的两面。
  //
  // ★ 必须在这里、必须在写库之前 ★ 客户答的是这一轮的问题，要跟本轮消息同事务落地；
  // 分开写会留下「问了但没有答案」的残局。
  let customerExtraction: CustomerExtraction = { answered_elements: [], vague_elements: [] };
  // 客户没开口就没什么可抽的——抽一条空字符串只会白花一次调用，还可能抽出幻觉来
  if (hasApiKey() && !exitReason && !deferReply) {
    customerExtraction = await extractCustomer({
      reply: customerReply,
      askedContext: traineeText,
      sessionId,
    });
    facts = applyCustomerAnswers(facts, customerExtraction, turn);
  }

  // ───────────────── 三、写（短事务，里面没有任何网络调用） ─────────────────
  await prisma.$transaction(
    async (tx) => {
      // SELECT ... FOR UPDATE：抢到这一行才能往下走
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;

      // ★ 拿到锁之后再核一次轮次 ★ 上面那两次模型调用期间我们手里没有锁，
      // 中间完全可能有另一个窗口先写进去了。轮次对不上就整发作废，绝不覆盖。
      const fresh = await tx.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { state: true },
      });
      const currentTurn = (fresh.state as unknown as DrillState).turn;
      if (currentTurn !== startTurn) throw new StaleTurnError(currentTurn, startTurn);

      if (seedBackstory) await seedFollowupBackstory(tx, sessionId, persona.openCard.inquiry_text);

      // ── ★每轮必存状态快照★ ──
      await tx.message.create({
        data: {
          sessionId,
          turn,
          role: 'trainee',
          content: traineeText,
          extraction: extraction as unknown as object,
          stateSnapshot: state as unknown as object,
          clientMsgId: input.clientMsgId ?? null,
        },
      });
      /**
       * ★ 补充说明窗口开着时不写客户消息 ★（2026-08-19 反馈 #7）
       *
       * 不是写一条空的，是**一条都不写**。写空串会在对话流、报告、回放里各留一个
       * 空气泡，看着像客户回了句什么但没显示出来——那比不写难查得多。
       * 一轮只有业务员说话，是这个机制的正常形态，Message 表也没有"一轮必须两条"的约束。
       */
      if (!deferReply) {
        await tx.message.create({
          data: {
            sessionId,
            turn,
            role: 'customer',
            content: customerReply,
            // ★ 客户侧抽取也要落库 ★ 回放工具读的就是 `Message.extraction`；
            // 不存在这里，历史局重放时六要素永远收集不到。
            extraction: customerExtraction as unknown as object,
            stateSnapshot: state as unknown as object,
            leakBlocked: leakBlocked > 0 ? ({ count: leakBlocked } as object) : undefined,
          },
        });
      }

      await tx.session.update({
        where: { id: sessionId },
        data: {
          state: state as unknown as object,
          facts: facts as unknown as object,
          unlockState: unlock as unknown as object,
          exitReason: exitReason ?? undefined,
          status: exitReason ? 'ENDED' : 'ACTIVE',
          endedAt: exitReason ? new Date() : undefined,
        },
      });
    },
    // 三条写，没有网络调用。给足余量，但远不是原来那个 120 秒——
    // 一个纯写事务要是真跑了 15 秒，那是数据库出事了，该让它失败而不是继续等。
    { timeout: 15_000 },
  );

  return {
    turn,
    customerReply,
    state,
    facts,
    freshUnlocks: un.fresh,
    leakBlocked,
    exitReason,
    extraction,
    violations,
  };
}

/**
 * 报价在对话流里长什么样。
 *
 * ★ 逐行列出，别只给一个总额 ★（2026-08-19 反馈 #6）
 * 这条消息会原样进客户的对话历史。业务员反馈的正是「我报了两个产品，
 * 他那边因为系统里面没有记录，就不知道」——客户能不能分清哪个价对应哪个货，
 * 全看这里写没写清楚。
 *
 * ★ 正文英文 ★ 与附件消息同一条理由：客户是海外买家，读不懂中文。
 * 只有方括号里给业务员看的那行标注用中文。
 */
function formatQuoteMessage(f: QuoteForm): string {
  const freight = f.freight ?? 0;
  const goods = f.lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0);
  const total = goods + freight;
  const fmt = f.hasQuoteSheet && f.hasScreenshot ? '报价表+截图' : f.hasScreenshot ? '仅截图' : '纯文字';

  const rows = f.lines.map((l) => {
    const name = l.product.trim();
    const sub = (l.unitPrice * l.quantity).toFixed(2);
    return `- ${name ? `${name}: ` : ''}USD ${l.unitPrice} x ${l.quantity} pcs = USD ${sub}`;
  });

  return [
    'Quotation:',
    ...rows,
    ...(freight ? [`- Freight: USD ${freight.toFixed(2)}`] : []),
    `Total: USD ${total.toFixed(2)}`,
    ...(f.tradeTerms?.trim() ? [`Trade terms: ${f.tradeTerms.trim()}`] : []),
    ...(f.leadTimeDays ? [`Lead time: ${f.leadTimeDays} days`] : []),
    `[报价形式：${fmt}${f.lines.length > 1 ? ` ｜ ${f.lines.length} 个产品` : ''}]`,
  ].join('\n');
}

/**
 * 交付动作在对话流里长什么样。
 *
 * ★ 必须带英文附件名 ★ 这条消息会原样进客户的对话历史（段 3）。客户是海外买家，
 * 给他看一行中文，他要么看不懂、要么按红线④的设定回一句"读不懂"——那就荒唐了。
 * 所以正文是英文，只有方括号里那句给业务员看的标注是中文。
 */
function formatDeliverableMessage(kind: DeliverableKind): string {
  return [
    `[Attachment] ${DELIVERABLE_FILENAME[kind]}`,
    `Please find our ${DELIVERABLE_LABEL_EN[kind]} attached.`,
    `［系统动作：已向客户投递${DELIVERABLE_LABEL[kind]}］`,
  ].join('\n');
}

/** 附件在英文正文里的说法。中文标签给业务员看，这个给客户看 */
const DELIVERABLE_LABEL_EN: Record<DeliverableKind, string> = {
  catalog: 'product catalog',
};

function readExitLine(exitLines: unknown, key: string): string {
  const o = (exitLines ?? {}) as Record<string, string | null>;
  return o[key] ?? '[客户已离开对话]';
}
