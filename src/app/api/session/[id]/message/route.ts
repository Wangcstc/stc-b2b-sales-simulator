import { NextResponse } from 'next/server';
import { sendMessage, StaleTurnError, SessionEndedError } from '@/lib/session-service';
import { guardAct } from '@/lib/session-guard';
import { LlmBudgetError } from '@/lib/llm/client';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { content, clientMsgId, expectedTurn } = (await req.json()) as {
    content: string;
    clientMsgId?: string;
    expectedTurn?: number;
  };
  if (!content?.trim()) return NextResponse.json({ error: '消息不能为空' }, { status: 400 });

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  try {
    return NextResponse.json(await sendMessage(id, content.trim(), clientMsgId, expectedTurn));
  } catch (e) {
    // 409 而不是 500：这不是故障，是"另一个窗口先走了一步"，前端要能分辨并自动同步
    // 局已经结束（离场或已出分）：这也不是故障，是操作对象没了，前端该刷新而不是重试
    if (e instanceof SessionEndedError) {
      return NextResponse.json({ error: e.message, code: 'SESSION_ENDED' }, { status: 409 });
    }
    if (e instanceof StaleTurnError) {
      return NextResponse.json(
        { error: e.message, code: 'STALE_TURN', currentTurn: e.currentTurn },
        { status: 409 },
      );
    }
    // 503 而不是 500：撞了今日模型预算不是代码坏了，是额度用完了（漏洞台账 N-10）。
    // 分开是为了前端能说"今天到上限了，找管理员"，而不是"服务器错误，请重试"——
    // 后者会让业务员一直点重试，每点一次都被同一道闸挡回来
    if (e instanceof LlmBudgetError) {
      return NextResponse.json({ error: e.message, code: 'LLM_BUDGET' }, { status: 503 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
