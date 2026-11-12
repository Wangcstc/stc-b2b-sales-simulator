/**
 * 干扰项选择（需求 5.4 / 人设 JSON 的 distractors 字段）
 *
 * ★ 这个文件是 2026-08-06 补的，因为 distractors 从来没被读过 ★
 * 人设 JSON 里写了、schema 里存了、seed 也导进库了，可 `grep -rn distractor src/`
 * 只能搜到两个难度标签字符串——引擎一次都没读过它。后果是 P1 的难度写着
 * 「简单 + 干扰项」，实跑却一个干扰项都不会出现，标称难度比真实难度高一档。
 *
 * ★ 干扰项不违反「客户被动」铁律 ★
 * 第一铁律管的是「不许替新人把该问的问题问出来」。干扰项是另一回事：
 * 真实客户确实会主动比价、主动要认证、主动索要素材——那是压力测试，是这局要考的东西。
 * 但它仍然受一条约束：干扰项内容里不许含未解锁暗牌的泄露信号
 * （`npm run verify:persona` 会替你检查这一条）。
 */

export interface Distractor {
  code: string;
  /** [起, 止] 闭区间，按轮次判定 */
  turn_range: [number, number];
  content: string;
  tests?: string;
  unlocks?: string | null;
  scoring?: string;
}

/** 从人设的 distractors 原始 JSON 里解析出结构，脏数据直接丢掉不抛错 */
export function parseDistractors(raw: unknown): Distractor[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is Distractor => {
    const o = d as Partial<Distractor>;
    return (
      typeof o?.code === 'string' &&
      typeof o?.content === 'string' &&
      Array.isArray(o?.turn_range) &&
      o.turn_range.length === 2 &&
      typeof o.turn_range[0] === 'number' &&
      typeof o.turn_range[1] === 'number'
    );
  });
}

/**
 * 挑出本轮该抛的干扰项。纯函数。
 *
 * 规则：
 *   1. 没抛过的才算
 *   2. 当前轮次落在 [起, 止] 内
 *   3. 一轮最多抛一个——两个压力同时来，考的就变成阅读理解了
 *   4. 同时有多个候选时，取窗口右边界最早的那个（快过期的先抛）
 *
 * ★ 过了窗口就不抛了 ★ 干扰项的价值在于「在特定阶段打断你」，
 * 补抛一个早就该出现的问题，只会让对话前言不搭后语。
 */
export function pickDistractor(
  all: Distractor[],
  turn: number,
  fired: string[],
): Distractor | null {
  const firedSet = new Set(fired);
  const candidates = all.filter(
    (d) => !firedSet.has(d.code) && turn >= d.turn_range[0] && turn <= d.turn_range[1],
  );
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.turn_range[1] - b.turn_range[1])[0]!;
}
