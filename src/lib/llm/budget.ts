/**
 * 模型用量预算闸（漏洞台账 N-10，2026-08-28）
 *
 * ★ 它防的是什么 ★
 * `LlmCall` 逐次记录 token 与延迟，但**没有任何日/月上限、没有告警**。
 * 演习局不限次数，一局 20 轮 ≈ 40 次调用，评分还走 pro 模型。
 * 一个人（或一个跑飞的脚本）刷一晚上，账单没有任何东西会拦。
 *
 * ★ 为什么是「软闸」不是硬配额 ★
 * 这道闸要防的是**跑飞**，不是限制正常使用。所以：
 *   · 到 70% 打一条 warn 到服务端日志（主管看得到，业务员无感）；
 *   · 到 100% 才拒绝，且错误文案说清「这不是你的问题，去找管理员」。
 * 把正常用的人挡在外面，比超支更糟——他今天的考试就作废了。
 *
 * ★ 判定是纯函数，取数在外壳 ★ 与结算那边同一个分层：`decideBudget` 可穷举测试，
 * 查库与缓存留在 `client.ts`。
 */

/**
 * 每日 token 预算。
 *
 * ★ 5,000,000 这个数是算出来的，不是拍的 ★
 *   · 实测单次调用中位 1236 tokens、最大 8821（2026-08-28 查 257 条 LlmCall）；
 *   · 一局最多 20 轮 × 2 次调用（抽取 + 扮演）＋ 复盘出题 ＋ 评分 ≈ 45 次 ≈ 5.5 万 tokens；
 *   · 满负荷一天：7 个业务员 × 6 局（3 演习 + 3 考试）= 42 局 ≈ **230 万 tokens**。
 * 500 万留了一倍余量：正常用不会碰到，跑飞了（比如一个脚本连刷）当天就会撞上。
 *
 * 团队规模变了就改 `LLM_DAILY_TOKEN_BUDGET` 环境变量，不用改代码。
 */
export const LLM_BUDGET = {
  dailyTokenLimit: Number(process.env.LLM_DAILY_TOKEN_BUDGET ?? 5_000_000),
  /** 到这个比例先告警。0.7 = 用掉七成时在服务端日志喊一声 */
  warnRatio: 0.7,
} as const;

export interface BudgetDecision {
  /** true = 拒绝这次调用 */
  blocked: boolean;
  /** true = 该在服务端日志喊一声（不给业务员看） */
  warn: boolean;
  /** 已用掉的比例，0–1+ */
  ratio: number;
  /** 拒绝时给业务员看的话。不拒绝时为空串 */
  message: string;
}

/**
 * 今天还能不能调模型。
 *
 * @param usedTokens 今天已经用掉的 token（prompt + completion）
 * @param limit 每日上限。传 0 或负数 = 关掉这道闸（用于本地调试）
 */
export function decideBudget(usedTokens: number, limit: number = LLM_BUDGET.dailyTokenLimit): BudgetDecision {
  if (!Number.isFinite(limit) || limit <= 0) {
    // ★ 关掉闸门要显式 ★ 但也别让脏配置（NaN、负数）变成「无限额度」而不留痕
    return { blocked: false, warn: false, ratio: 0, message: '' };
  }
  const used = Number.isFinite(usedTokens) && usedTokens > 0 ? usedTokens : 0;
  const ratio = used / limit;

  if (ratio >= 1) {
    return {
      blocked: true,
      warn: true,
      ratio,
      message: [
        '今天的模型用量已经到上限，暂时开不了新的对话。',
        '**这不是你的问题**——是全系统今天的调用量到顶了，找管理员看一下就行。',
        '（已经打完的局与分数不受影响；明天零点自动恢复。）',
      ].join('\n'),
    };
  }
  return { blocked: false, warn: ratio >= LLM_BUDGET.warnRatio, ratio, message: '' };
}

/** 服务端日志那一行。只给主管看，业务员看不到 */
export function budgetWarnLine(decision: BudgetDecision, used: number, limit: number): string {
  return (
    `[llm-budget] 今日已用 ${used.toLocaleString()} / ${limit.toLocaleString()} tokens ` +
    `（${Math.round(decision.ratio * 100)}%）` +
    (decision.blocked ? ' —— 已到上限，新的调用一律拒绝' : ' —— 到告警线了，留意是不是有东西在跑飞')
  );
}
