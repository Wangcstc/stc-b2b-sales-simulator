/**
 * 抽屉用的模型调用。走 OpenAI 兼容协议，默认 DeepSeek；各工序的模型名分开配置。
 *
 * ★ 抽屉不借用柜子的模型客户端 ★ 抽屉不许依赖柜子（`check:boundaries`），而且抽屉的计费口径
 * 是「这一批花了多少」，柜子是「今天全站花了多少」，本来就不是一回事。
 *
 * 测试用 `FakeLlm`（见 drawer.test.ts）：按工序返回预先录好的结果，不花钱、完全确定。
 */
import OpenAI from 'openai';

export type Purpose = 'triage' | 'draft' | 'variant' | 'revise' | 'bg';

export interface LlmRequest {
  purpose: Purpose;
  system: string;
  user: string;
  /** 要求模型只输出一个 JSON 对象 */
  json: true;
  /** 给测试与录制用的标签（素材编号等） */
  tag?: string;
}

export interface LlmResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface Llm {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

const MODEL_ENV: Record<Purpose, [string, string]> = {
  triage: ['DRAWER_MODEL_TRIAGE', 'deepseek-v4-flash'],
  draft: ['DRAWER_MODEL_DRAFT', 'deepseek-v4-pro'],
  variant: ['DRAWER_MODEL_VARIANT', 'deepseek-v4-pro'],
  revise: ['DRAWER_MODEL_DRAFT', 'deepseek-v4-pro'],
  bg: ['DRAWER_MODEL_DRAFT', 'deepseek-v4-pro'],
};

export function modelFor(purpose: Purpose): string {
  const [env, fallback] = MODEL_ENV[purpose];
  return process.env[env] || fallback;
}

export class OpenAiLlm implements Llm {
  private client: OpenAI;
  constructor() {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) throw new Error('没有配置 DEEPSEEK_API_KEY，抽屉调不了模型');
    this.client = new OpenAI({ apiKey, baseURL: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com' });
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = modelFor(req.purpose);
    const r = await this.client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      response_format: { type: 'json_object' },
      temperature: req.purpose === 'triage' ? 0.2 : 0.7,
    });
    return {
      text: r.choices[0]?.message?.content ?? '',
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
      model,
    };
  }
}
