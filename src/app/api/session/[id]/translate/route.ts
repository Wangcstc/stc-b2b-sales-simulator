import { NextResponse } from 'next/server';
import { toBusinessEnglish } from '@/lib/llm/translate';
import { hasApiKey } from '@/lib/llm/client';
import { guardAct } from '@/lib/session-guard';

/**
 * 中译英。挂在 session 下是为了记账（LlmCall 带 sessionId）与归属校验。
 *
 * ★ 不校验局是否已结束 ★ guardAct 只判「这局是不是你的」。
 * 翻译没有副作用，不推轮次、不写消息、不动状态——局结束后想把话译出来看看也随意。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { text } = (await req.json()) as { text?: string };
  const input = (text ?? '').trim();
  if (!input) return NextResponse.json({ error: '没有要翻译的内容' }, { status: 400 });
  if (input.length > 2000) return NextResponse.json({ error: '太长了，一次最多 2000 字' }, { status: 400 });
  if (!hasApiKey()) return NextResponse.json({ error: '未配置 DEEPSEEK_API_KEY，翻译不可用' }, { status: 503 });

  try {
    return NextResponse.json(await toBusinessEnglish(input, id));
  } catch (e) {
    // 翻译失败不能吞掉原文——前端要把中文原样留在输入框里
    return NextResponse.json({ error: `翻译失败：${(e as Error).message}` }, { status: 502 });
  }
}
