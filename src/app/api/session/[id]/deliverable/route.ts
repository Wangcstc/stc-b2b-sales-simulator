import { NextResponse } from 'next/server';
import { submitDeliverableTurn, StaleTurnError, SessionEndedError } from '@/lib/session-service';
import { guardAct } from '@/lib/session-guard';
import { DELIVERABLE_KINDS, type DeliverableKind } from '../../../../../../engine/types';

/**
 * 动作类交付（2026-08-19 反馈 #4：发产品目录）。
 *
 * ★ 和报价同一条路 ★ 它之所以是一个接口而不是一句聊天，理由与报价一样：
 * 只有走动作，系统才知道「这件事真的发生了」，客户才不会一轮轮继续索要，
 * 点评引擎也才不会再判「拖着不给资料」。
 *
 * ★ kind 必须来自白名单 ★ 前端传什么就投什么的话，将来加了别的资料种类，
 * 一个手改的请求就能投递一份规则上还没定义的东西。
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as {
    kind?: string;
    clientMsgId?: string;
    expectedTurn?: number;
  };

  if (!DELIVERABLE_KINDS.includes(body.kind as DeliverableKind)) {
    return NextResponse.json(
      { error: `不支持的交付类型：${body.kind ?? '(空)'}` },
      { status: 400 },
    );
  }

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  try {
    return NextResponse.json(
      await submitDeliverableTurn(id, body.kind as DeliverableKind, body.clientMsgId, body.expectedTurn),
    );
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
