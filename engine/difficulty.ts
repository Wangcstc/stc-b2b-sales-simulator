/**
 * 难度系数 α（王老师 2026-08-23 裁定）
 *
 * ★ 它只干一件事：调「跑一局拿到 65 分有多难」★
 *
 *   门槛永远是 65。不管系数怎么调，达标线都是最近 6 局局分中位数 ≥65。
 *   要改 65 本身，那是另一件事，得王老师单独说。
 *
 * 所以 α 作用在**局分**上，不作用在门槛上，也不作用在客户情绪的标尺上：
 *
 *     最终局分 = 100 × (原始局分 ÷ 100) ^ α
 *
 *   α = 1.0  完全不变（就是现在的标准）
 *   α > 1.0  同样的表现，分数更低 → 更难拿到 65
 *   α < 1.0  同样的表现，分数更高 → 更容易拿到 65
 *
 * ★ 为什么用这条曲线，不用「原始分 − 5」或「原始分 × 0.9」★
 *   1. 两端钉死：0 还是 0，100 还是 100。不会出现「满分只能拿 83」这种怪事；
 *   2. 严格单调：表现更好，分数一定更高，不会有并列或反转；
 *   3. 中间段最敏感——60~80 这一带正是要区分的区间，两头本来就不需要精细。
 *
 * ★ 一句话解释给业务员听 ★
 *   系数 1.2 的意思是「你要打出 70 分的水平，才拿得到 65 分」。
 *   `rawNeededFor()` 算的就是这个数，界面上直接摆出来。
 */

export const DIFFICULTY_BOUNDS = { min: 0.6, max: 1.5, step: 0.1, default: 1.0 } as const;

/**
 * 落库/读库前一律走这里。越界夹回区间；脏值一律退回 1.0。
 *
 * ★ 不许用 `Number(v)` 一把梭 ★ `Number(null)` 是 0、`Number('')` 也是 0，
 * 都是"有限数"，会被夹成下界 0.6——于是漏配一个字段，全队的分数就被悄悄抬高了，
 * 而界面上一切正常。单元测试是靠这一条抓出来的。
 */
export function normalizeFactor(v: unknown): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return DIFFICULTY_BOUNDS.default;
  if (Number.isNaN(n)) return DIFFICULTY_BOUNDS.default;
  const clamped = Math.min(DIFFICULTY_BOUNDS.max, Math.max(DIFFICULTY_BOUNDS.min, n));
  // 只保留一位小数——0.8333 这种值没法在界面上如实显示，也没法跟人解释
  return Math.round(clamped * 10) / 10;
}

/**
 * 把原始局分按难度系数折算成最终局分。
 *
 * 这是 α 的**唯一**作用点。除了这一个函数，全系统没有第二处读难度系数。
 */
export function applyDifficulty(rawScore: number, factor: number): number {
  const f = normalizeFactor(factor);
  // ★ 先夹再算 ★ 夹在早退之前——否则 α=1 这条捷径会把越界值原样放过去
  const clamped = Math.min(100, Math.max(0, rawScore));
  if (f === DIFFICULTY_BOUNDS.default) return clamped; // α=1 不经过浮点运算，逐位等于原分
  return Math.round(100 * Math.pow(clamped / 100, f));
}

/**
 * 反过来：在这个系数下，要拿到 `target` 分，原始水平得打到多少。
 *
 * ★ 这才是界面上该摆的数 ★「系数 1.2」对人没有意义，
 * 「你要打出 70 分的水平才拿得到 65 分」才有意义。
 */
export function rawNeededFor(target: number, factor: number): number {
  const f = normalizeFactor(factor);
  if (f === DIFFICULTY_BOUNDS.default) return target;
  const clamped = Math.min(100, Math.max(0, target));
  return Math.round(100 * Math.pow(clamped / 100, 1 / f));
}
