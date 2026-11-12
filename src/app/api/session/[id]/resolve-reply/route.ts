import { NextResponse } from 'next/server';
import { resolvePendingReply, StaleTurnError, SessionEndedError } from '@/lib/session-service';
import { guardAct } from '@/lib/session-guard';

/**
 * 「我说完了，让客户回复」——关掉补充说明窗口（2026-08-19 反馈 #7）。
 *
 * ★ 这条路不推进轮次、不写业务员消息 ★ 它只是把被按住的那句客户回复放出来。
 * 详见 `session-service.ts` 的 resolvePendingReply。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { expectedTurn?: number };

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  try {
    return NextResponse.json(await resolvePendingReply(id, body.expectedTurn));
  } catch (e) {
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
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
