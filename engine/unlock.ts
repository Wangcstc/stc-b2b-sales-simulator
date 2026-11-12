/**
 * 暗牌解锁判定 + 泄露检查（技术方案 5.2 第一、三道防线）
 *
 * 由 P0 的 `scripts/leak-guard.ts` 原型搬入。2026-08-05 实测记录：
 * - 靠 prompt 写「你绝不主动说」，改完当场有效，**20 轮实跑第 7 轮就破**；
 * - 模型甚至在状态板里自己写着「H4 仍未解锁」——**守得住标记，守不住嘴**；
 * - 换成代码侧判定后，回放同一批业务员台词，拦截 2/2，均一次重生成即干净。
 *
 * 所以：解锁判定与泄露检查都在这里，是纯函数，不进 prompt。
 */

import type { SessionFacts } from './types';

export interface HiddenCardConfig {
  value: string;
  unlock: string;
  /** 前置牌，未解锁则本牌一律不解锁 */
  requires?: string[];
  /** 任一命中即解锁 */
  unlock_patterns?: string[];
  /** 与 framing 成对使用：两组都命中才解锁——这是「裸问不解锁」的代码化 */
  unlock_patterns_topic?: string[];
  unlock_patterns_framing?: string[];
  leak_signals?: string[];
}

export type HiddenCards = Record<string, HiddenCardConfig>;

export interface UnlockState {
  unlocked: string[];
  unlockedAt: Record<string, number>;
}

export function emptyUnlockState(): UnlockState {
  return { unlocked: [], unlockedAt: {} };
}

const anyMatch = (patterns: string[] | undefined, text: string): boolean =>
  (patterns ?? []).some((p) => new RegExp(p, 'i').test(text));

/**
 * 按【新人这一轮说的话】判定本轮新解锁哪些牌。纯函数，返回新状态。
 *
 * 三类规则：
 *   1. `unlock_patterns`：任一命中即解锁
 *   2. `topic` + `framing`：两组都要命中（问用途还得带利他外壳，裸问不给）
 *   3. `requires`：前置牌未解锁则不解锁
 */
export function detectUnlocks(
  cards: HiddenCards,
  salespersonMsg: string,
  state: UnlockState,
  turn: number,
): { state: UnlockState; fresh: string[] } {
  const unlocked = new Set(state.unlocked);
  const unlockedAt = { ...state.unlockedAt };
  const fresh: string[] = [];

  for (const [key, card] of Object.entries(cards)) {
    if (unlocked.has(key)) continue;
    if ((card.requires ?? []).some((r) => !unlocked.has(r))) continue;

    const hit = card.unlock_patterns_topic
      ? anyMatch(card.unlock_patterns_topic, salespersonMsg) &&
        anyMatch(card.unlock_patterns_framing, salespersonMsg)
      : anyMatch(card.unlock_patterns, salespersonMsg);

    if (hit) {
      unlocked.add(key);
      unlockedAt[key] = turn;
      fresh.push(key);
    }
  }
  return { state: { unlocked: [...unlocked], unlockedAt }, fresh };
}

export interface LeakHit {
  card: string;
  signal: string;
}

/** 扫客户回复，找未解锁牌的泄露信号 */
export function checkLeak(cards: HiddenCards, reply: string, state: UnlockState): LeakHit[] {
  const text = reply.toLowerCase();
  const unlocked = new Set(state.unlocked);
  const hits: LeakHit[] = [];
  for (const [key, card] of Object.entries(cards)) {
    if (unlocked.has(key)) continue;
    for (const sig of card.leak_signals ?? []) {
      if (text.includes(sig.toLowerCase())) hits.push({ card: key, signal: sig });
    }
  }
  return hits;
}

/**
 * 泄露后追加给模型的纠正指令。
 * 必须写明「漏了哪个词、为什么不该说、这轮该怎么说」——
 * 只说"重说一遍"，模型会原样再来一次（08-05 实测）。
 */
export function buildLeakCorrection(hits: LeakHit[]): string {
  const cards = [...new Set(hits.map((h) => h.card))];
  return [
    '【你刚才那句话违规了，重说】',
    '你说出了现在【绝对不能说】的信息：',
    ...cards.map((k) => {
      const words = hits.filter((h) => h.card === k).map((h) => `"${h.signal}"`).join('、');
      return `- ${k}：出现了 ${words}。对方【还没有问到】这件事，你不可能主动提起。`;
    }),
    '',
    '重新说这一轮。要求：',
    '1. 完全不出现上面那些词，也不许用同义词、缩写、暗示绕过去；',
    '2. 【不许替对方把该问的问题问出来】，也不许纠正他的任何误解；',
    '3. 可以着急、可以催价格、可以不耐烦，但只能围绕对方【已经提到过】的内容说话。',
  ].join('\n');
}

/** 把解锁状态同步进事实表（解锁时间戳天然就是「新人第几轮问出来的」证据） */
export function syncUnlocksToFacts(facts: SessionFacts, state: UnlockState): SessionFacts {
  const existing = new Set(facts.unlockedCards.map((c) => c.key));
  const added = state.unlocked
    .filter((k) => !existing.has(k))
    .map((k) => ({ key: k, turn: state.unlockedAt[k] ?? 0 }));
  return added.length === 0 ? facts : { ...facts, unlockedCards: [...facts.unlockedCards, ...added] };
}
