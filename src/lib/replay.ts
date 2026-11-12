/**
 * 回放工具（技术方案 12.2 / 步骤 47）
 *
 * ★ 看起来像锦上添花，实际是调参的唯一可行手段 ★
 * 没有它，每调一个扣分数值都要真人聊一局——成本高到根本不会去调，
 * 状态机参数就永远停在第一次拍脑袋的值上。**不许砍。**
 *
 * 做法：拿已落库的 `messages.extraction` 序列，用【新规则表】重跑状态机，
 * 看结局有没有变。比真人试聊快三个数量级。
 *
 * 前提是引擎层必须是纯函数——这就是 `engine/` 不许 import 数据库的理由。
 */

import type {
  DrillState,
  Extraction,
  CustomerExtraction,
  SessionFacts,
  RuleTable,
  ExitReason,
  SessionType,
} from '../../engine/types';
import { updateState, checkExit, initialState, collectRedlines } from '../../engine/state-machine';
import { updateFacts, applyCustomerAnswers, emptyFacts, addRedline } from '../../engine/facts';

export interface ReplayInput {
  /** 按轮次排好的抽取序列（来自 messages.extraction，role=trainee） */
  extractions: { turn: number; extraction: Extraction }[];
  /**
   * 客户侧抽取序列（来自 messages.extraction，role=customer）。
   *
   * ★ 不传会让重放偏严 ★ 六要素三态化之后，「收集到」只能由客户那一条促成。
   * 缺了这一份，重放里所有要素都停在 `asked_no_answer`，红线①会比真实情况多触发。
   * 2026-08-23 之前的历史局客户消息上没有 extraction，属于这种情况——
   * 那批局的重放结果只能横向自比，不要拿去和新局对齐。
   */
  customerAnswers?: { turn: number; extraction: CustomerExtraction }[];
  sessionType: SessionType;
  initialInterest: number;
  rules: RuleTable;
  /** 报价发生在第几轮、什么档位——回放不重算报价，直接沿用历史事实 */
  quotes?: SessionFacts['quotes'];
  /** 跟进局前情里已定死的六要素（`PersonaVariant.presetElements`）。不传＝探需局 */
  preset?: readonly string[];
}

export interface ReplayResult {
  states: DrillState[];
  finalState: DrillState;
  facts: SessionFacts;
  exitAt: number | null;
  exitReason: ExitReason | null;
  redlines: string[];
}

export function replay(input: ReplayInput): ReplayResult {
  let state = initialState(input.initialInterest);
  let facts = emptyFacts(input.preset ?? []);
  if (input.quotes?.length) facts = { ...facts, quotes: input.quotes };

  const answersByTurn = new Map((input.customerAnswers ?? []).map((c) => [c.turn, c.extraction]));

  const states: DrillState[] = [];
  let exitAt: number | null = null;
  let exitReason: ExitReason | null = null;

  for (const { turn, extraction } of input.extractions) {
    const quote = input.quotes?.find((q) => q.turn === turn);
    facts = updateFacts(facts, extraction, turn, 'asked');

    const upd = updateState(state, extraction, facts, input.rules, { quote });
    state = upd.state;
    for (const r of collectRedlines(upd.hits, input.rules)) facts = addRedline(facts, r);
    states.push(state);

    const exit = checkExit(state, facts, input.sessionType, input.rules);
    if (exit) {
      exitAt = turn;
      exitReason = exit;
      break;
    }

    // ★ 客户答完才算收集到 ★ 顺序不能反：本轮的规则（尤其红线①"数量未确认即报价"）
    // 判的是【报价那一刻】业务员知道什么，客户这一轮的回答要到下一轮才作数。
    const answered = answersByTurn.get(turn);
    if (answered) facts = applyCustomerAnswers(facts, answered, turn);
  }

  return { states, finalState: state, facts, exitAt, exitReason, redlines: facts.redlines };
}

export interface ReplayDiff {
  drillId: string;
  before: { exitAt: number | null; exitReason: string | null; patience: number; redlines: string[] };
  after: { exitAt: number | null; exitReason: string | null; patience: number; redlines: string[] };
  changed: boolean;
}

/** 对比新旧规则表下同一局的结局差异——这是"改一个数值会影响多少局"的答案 */
export function diffRules(
  drillId: string,
  input: Omit<ReplayInput, 'rules'>,
  oldRules: RuleTable,
  newRules: RuleTable,
): ReplayDiff {
  const a = replay({ ...input, rules: oldRules });
  const b = replay({ ...input, rules: newRules });

  const before = {
    exitAt: a.exitAt,
    exitReason: a.exitReason,
    patience: a.finalState.patience,
    redlines: a.redlines,
  };
  const after = {
    exitAt: b.exitAt,
    exitReason: b.exitReason,
    patience: b.finalState.patience,
    redlines: b.redlines,
  };

  return {
    drillId,
    before,
    after,
    changed:
      before.exitAt !== after.exitAt ||
      before.exitReason !== after.exitReason ||
      before.patience !== after.patience ||
      before.redlines.join() !== after.redlines.join(),
  };
}
