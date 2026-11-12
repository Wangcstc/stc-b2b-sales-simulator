/**
 * 语言判定（红线④：用中文向 AI 客户作答）
 *
 * ★ 为什么放在引擎层 ★
 * 状态机要用它（`matchRules` 里判红线④），而引擎是无菌区——不许 import `llm/`。
 * 原来这个正则住在 `llm/translate.ts` 里，只用来决定"要翻译还是要润色"。
 * 现在它成了判定依据，就得搬到判定该在的地方。`translate.ts` 反过来 import 这里。
 *
 * ★ 为什么是纯代码，不交给模型 ★
 * "这句话里有没有汉字"是 L1 级判定：正则一跑，100% 可靠、零解释空间。
 * 交给 LLM 只会引入一个本来不存在的错误来源。
 */

/**
 * CJK 统一汉字（含扩展 A）。
 *
 * ★ 只认汉字，不认中文标点 ★ 一句纯英文里出现一个「，」是输入法没切干净，
 * 不是"用中文作答"。按标点判会把大量正常英文消息误判成碰红线——
 * 而红线是要扣分、要写进报告的，误判一次就是一次冤枉。
 */
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;

export function hasChinese(s: string): boolean {
  return CJK.test(s);
}

/**
 * 这一条业务员消息算不算"用中文作答"。
 *
 * 判据故意定得比 `hasChinese` 松一档：**只要出现汉字就算**。
 * 不设"汉字占比超过 X%"这种阈值，两个理由：
 *   1. 讲不清楚——业务员问「为什么这条算、那条不算」时，占比阈值没法当面解释；
 *   2. 中英混着发同样读不懂。海外买家看到 "Our MOQ is 500，最少五百个" 一样懵。
 *
 * 报价表单那种由系统拼出来的消息不走这条路径（见 `session-service` 的调用点）。
 */
export function isChineseReply(message: string): boolean {
  return hasChinese(message);
}
