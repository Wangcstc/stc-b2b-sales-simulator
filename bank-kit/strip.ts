/**
 * 导出时「不带来源备注」：把所有下划线开头的字段（来源备注、设计说明）递归剥掉。
 * 题库包传给别人时，看不出题目改编自哪段素材。柜子运行时本来就不读这些字段，剥掉不影响使用。
 */
export function stripNotes<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripNotes(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripNotes(v)]),
    ) as T;
  }
  return value;
}

/**
 * 背调资料包的「剥壳」（题库格式的约定，柜子发背调材料、抽屉质检背调包都按这一份）——把答案从发给浏览器的数据里摘掉
 *
 * ★ 为什么必须有这一层（2026-08-08 发现）★
 * 背调包的 JSON 里同时装着两种东西：
 *   ① 给新人看的材料——官网快照、社媒动态、联系方式；
 *   ② 给设计者看的答案——`planted_error`（预埋错误的真相是什么）、
 *      `_cross_check_hint`（从哪一条能识破）、`_snapshot_note`（这一页要让新人自己发现什么）。
 * 而接口原来是 `aiReport: pkg.aiReport` 整块返回的，前端只是恰好没渲染第二种。
 * **没渲染不等于没发出去**——F12 打开 Network，`planted_error.truth` 就明明白白写在那里，
 * 整个背调考点当场作废，而且作废得悄无声息（界面上一切正常）。
 *
 * 规矩立在这里，两条，都很好记：
 *   1. 下划线开头的键 = 设计注释，永不出服务端；
 *   2. `planted_error` 整块永不出服务端。
 * 写新背调包时，凡是「写给出题人看的话」，一律用下划线开头命名。
 */

/**
 * 除下划线约定之外，还要显式摘掉的键。
 *
 * ★ 2026-08-28：从「一个精确的名字」改成「一组前缀」★
 * 原来这里只有 `planted_error` 一个字面量。而有两份背调包
 * 用的是**复数** `planted_errors`，外加 `scoring_hooks` / `card_hooks`——
 * 三个键全部躲过了剥壳，**从 2026-08-13 加进来那天起就一直发给浏览器**：
 * 哪两张牌是预埋错误、怎样算「识破」、识破与否各怎么算分，F12 一开全在。
 * 这正是 2026-08-08 那次事故的原样重演，只是换了个键名。
 *
 * ★ 教训写在这儿 ★ 一个靠**精确匹配一个名字**的安全阀，挡的只是当初那一次；
 * 下一个人换个写法（复数、加后缀、拆成两块）就绕过去了，而且不会有任何东西报错。
 * 所以改成前缀匹配，并把「像答案的字段」一并纳入。
 * 新的键名也一样——写给出题人看的话**一律下划线开头**，那才是主约定，
 * 这份名单只是兜底。`scripts/import/verify-bg.ts` 会在入库前把漏网的揪出来。
 */
const ALWAYS_STRIP_PREFIX = ['planted_error', 'scoring_hook', 'card_hook'];

function isAnswerKey(key: string): boolean {
  if (key.startsWith('_')) return true;
  return ALWAYS_STRIP_PREFIX.some((prefix) => key.startsWith(prefix));
}

/**
 * 递归剥掉答案字段。数组逐项处理，标量原样返回。
 * 返回新对象，不改原值——原值是 Prisma 查出来的 JSON，别人还要用。
 */
export function stripAnswers<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripAnswers(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isAnswerKey(k)) continue;
      out[k] = stripAnswers(v);
    }
    return out as unknown as T;
  }
  return value;
}
