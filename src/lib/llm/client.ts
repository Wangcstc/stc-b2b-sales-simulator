/**
 * LLM 客户端封装（技术方案 2.3 约束①）
 *
 * baseURL / apiKey / 各用途模型名**全部走环境变量**——P0 横向对比模型时，
 * 换回来的成本必须是零。
 *
 * ★ 思考模式默认关闭 ★（2026-08-04 实测，三条硬理由）
 * ① 强制 tool_choice 会被拒：400 Thinking mode does not support this tool_choice
 * ② 输出 token 被思考吃掉：同一条消息 197 completion / 其中 109 是 reasoning，关掉只要 75
 * ③ **temperature 静默失效**——扮演客户设 0.8 会被忽略，客户变得死板
 * 要开思考是**单独的取舍**（比如评分链路），必须显式传 thinking:'enabled'，
 * 不许图省事全局打开。
 */

import OpenAI from 'openai';
import { prisma } from '../db';
import { LLM_BUDGET, decideBudget, budgetWarnLine } from './budget';

const apiKey = process.env.DEEPSEEK_API_KEY;

export const llm = new OpenAI({
  apiKey: apiKey ?? 'missing-key',
  baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com',
});

export const MODELS = {
  extract: process.env.MODEL_EXTRACT ?? 'deepseek-v4-flash',
  roleplay: process.env.MODEL_ROLEPLAY ?? 'deepseek-v4-flash',
  coachQa: process.env.MODEL_COACH_QA ?? 'deepseek-v4-pro',
  score: process.env.MODEL_SCORE ?? 'deepseek-v4-pro',
  // 中译英：新人打字时同步等着，延迟比文采重要，走 flash
  translate: process.env.MODEL_TRANSLATE ?? 'deepseek-v4-flash',
} as const;

export type Purpose = keyof typeof MODELS;

export function hasApiKey(): boolean {
  return Boolean(apiKey);
}

export interface CallOptions {
  purpose: Purpose;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  tools?: OpenAI.Chat.ChatCompletionTool[];
  toolChoice?: OpenAI.Chat.ChatCompletionToolChoiceOption;
  temperature?: number;
  /** 默认 'disabled'。要开是单独的取舍，见文件头 */
  thinking?: 'disabled' | 'enabled';
  jsonMode?: boolean;
  sessionId?: string;
}

export interface CallResult {
  content: string;
  toolArgs?: string;
  usage: { prompt: number; completion: number; cacheHit: number; reasoning: number };
  latencyMs: number;
}

/**
 * 统一出口。**所有 LLM 调用都必须走这里**——否则 token 与缓存命中就没法观测，
 * 也就无法验证前缀缓存是不是真的命中（技术方案 14 章）。
 */
/**
 * 今日用量缓存（预算闸的取数外壳，判定逻辑在 budget.ts）。
 *
 * ★ 为什么不是每次都查库 ★ 一局 40 次调用，每次多一条 aggregate 就是 40 次多余的
 * 往返，全压在业务员等回复的那几秒里。60 秒缓存足够——预算闸防的是「跑一晚上」，
 * 不是「精确到第 5000001 个 token」。
 *
 * ★ 但缓存内要自己累加 ★ 只靠 60 秒刷新会漏掉窗口内的爆发：一个死循环脚本
 * 60 秒能打几百次调用，如果那一整窗都读着同一个旧数，闸门等于不存在。
 * 所以每次调用结束把本次用量加回缓存，窗口内也能撞线。
 */
const usageCache = { day: '', tokens: 0, fetchedAt: 0 };
const USAGE_TTL_MS = 60_000;

/** 本地时区的今天零点。用 UTC 会让「明天恢复」在中国下午 8 点发生 */
function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

async function todayUsedTokens(): Promise<number> {
  const today = startOfToday();
  const dayKey = today.toISOString().slice(0, 10);
  const fresh = usageCache.day === dayKey && Date.now() - usageCache.fetchedAt < USAGE_TTL_MS;
  if (fresh) return usageCache.tokens;

  try {
    const agg = await prisma.llmCall.aggregate({
      _sum: { promptTokens: true, completionTokens: true },
      where: { createdAt: { gte: today } },
    });
    usageCache.day = dayKey;
    usageCache.tokens = (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0);
    usageCache.fetchedAt = Date.now();
  } catch (err) {
    // ★ 查不到用量就放行 ★ 数据库抖一下不该让所有人的对话停摆。
    // 但要留痕——否则「闸门其实一直没工作」会静默成立。
    console.warn('[llm-budget] 读今日用量失败，本次放行：', err);
    return usageCache.day === dayKey ? usageCache.tokens : 0;
  }
  return usageCache.tokens;
}

/** 撞线时抛这个。API 层认它，给业务员看 message 而不是一串堆栈 */
export class LlmBudgetError extends Error {
  readonly kind = 'llm-budget';
  constructor(message: string) {
    super(message);
    this.name = 'LlmBudgetError';
  }
}

export async function call(opts: CallOptions): Promise<CallResult> {
  const model = MODELS[opts.purpose];
  const started = Date.now();

  // 预算闸（N-10）：在花钱之前判，不是花完了再报警
  const limit = LLM_BUDGET.dailyTokenLimit;
  const used = await todayUsedTokens();
  const budget = decideBudget(used, limit);
  if (budget.warn) console.warn(budgetWarnLine(budget, used, limit));
  if (budget.blocked) throw new LlmBudgetError(budget.message);

  const res = await llm.chat.completions.create({
    model,
    messages: opts.messages,
    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    thinking: { type: opts.thinking ?? 'disabled' },
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const latencyMs = Date.now() - started;
  const raw = (res.usage ?? {}) as unknown as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const promptDetails = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const completionDetails = (raw.completion_tokens_details ?? {}) as Record<string, unknown>;

  const usage = {
    prompt: num(raw.prompt_tokens),
    completion: num(raw.completion_tokens),
    cacheHit: num(raw.prompt_cache_hit_tokens) || num(promptDetails.cached_tokens),
    reasoning: num(completionDetails.reasoning_tokens),
  };

  // 窗口内自己累加，见 usageCache 注释
  if (usageCache.day) usageCache.tokens += usage.prompt + usage.completion;

  // 落盘可追溯（技术方案 15.2）。失败不影响主流程——日志不能拖垮对话
  void prisma.llmCall
    .create({
      data: {
        sessionId: opts.sessionId ?? null,
        purpose: opts.purpose,
        model,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        cacheHitTokens: usage.cacheHit,
        reasoningTokens: usage.reasoning,
        latencyMs,
      },
    })
    .catch(() => {});

  const choice = res.choices[0]?.message;
  return {
    content: choice?.content ?? '',
    toolArgs: choice?.tool_calls?.[0]?.type === 'function' ? choice.tool_calls[0].function.arguments : undefined,
    usage,
    latencyMs,
  };
}

/**
 * 解析工具调用返回的 arguments。
 *
 * ★ 为什么不能直接 JSON.parse(res.toolArgs) ★
 * 2026-08-14 实测：评分链路（schema 最大的那条）DeepSeek 返回过
 * 「一段完整合法的 JSON + 后面还跟着东西」，JSON.parse 直接抛
 * `Unexpected non-whitespace character after JSON at position 5405`，
 * 整个 /api/session/[id]/score 500，前端只看到「JSON输入意外结束」——
 * 一句和病因毫无关系的话。schema 越大越容易碰上。
 *
 * 这里只做一件事：**把第一个完整的 JSON 对象切出来**，尾巴丢掉。
 * 字段级的修补是 schema-guard 的活，两者不能混在一起——
 * 混了以后就分不清「模型少给了一个字段」和「我把它切掉了」。
 *
 * ★ 切不出来就抛，绝不返回 {} ★
 * 返回空对象等于交出一份"七力全空"的评分，而它看上去和"这个人确实什么都没做到"
 * 一模一样。宁可报错让人重跑，也不能拿解析失败冒充评分结果。
 */
export function parseToolArgs(raw: string | undefined, purpose = ''): unknown {
  if (!raw || !raw.trim()) throw new Error(`模型没有返回工具参数${purpose ? `（${purpose}）` : ''}`);

  const s = stripCodeFence(raw).trim();
  try {
    return JSON.parse(s);
  } catch {
    // 落到下面切第一个对象
  }

  const cut = firstJsonObject(s);
  if (cut === null) {
    throw new Error(`工具参数里找不到完整的 JSON 对象${purpose ? `（${purpose}）` : ''}，长度 ${s.length}`);
  }
  const parsed = JSON.parse(cut); // 这里再抛就是真的坏了，交给调用方重试
  console.warn(
    `[llm] ${purpose || 'toolArgs'} 的工具参数带了尾巴：JSON 本体 ${cut.length} 字符，` +
      `后面多出 ${s.length - cut.length} 字符已丢弃。多出来的开头：${JSON.stringify(s.slice(cut.length, cut.length + 120))}`,
  );
  return parsed;
}

/** 有些模型会把工具参数包在 ```json 围栏里 */
function stripCodeFence(s: string): string {
  const m = s.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  return m?.[1] ?? s;
}

/**
 * 从字符串里切出第一个花括号配平的 JSON 对象。
 * 必须识别字符串字面量与转义——否则人设里一句 `他说"{"` 就能把计数带偏。
 */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s.charAt(i); // 不用 s[i]：tsconfig 开了 noUncheckedIndexedAccess，那样拿到的是 string|undefined
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null; // 花括号没配平——JSON 被截断了，不是多了尾巴
}
