import { NextResponse } from 'next/server';
import { submitQuoteTurn, StaleTurnError, SessionEndedError } from '@/lib/session-service';
import { guardAct } from '@/lib/session-guard';
import type { QuoteForm } from '../../../../../../engine/facts';

/** 报价是表单，不是聊天——这是它能达到 L1 100% 可靠性的唯一原因（需求 8.1） */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json()) as QuoteForm & { clientMsgId?: string; expectedTurn?: number };

  /**
   * ★ 逐行校验（2026-08-19 反馈 #6）★
   * 一份报价可以有 N 个产品，但每一行都得是真数——放一行 0 进去，
   * 总额和档位就都算错了，而档位错了格式合规判定跟着错。
   */
  /**
   * ★ 数字一律自己转一遍，不信前端传来的类型 ★（2026-08-24 补）
   * JSON 里的 `"12"` 和 `12` 在 `> 0` 这个判断上表现一样，都能过校验；
   * 但字符串会一路飘到 `quantity === realQuantity` 那个全等比较上——**永远不相等**，
   * 于是一份填得完全正确的报价被判成数量失真。转成数字是最省事、也最彻底的堵法。
   */
  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  const lines = rawLines.map((l) => ({
    product: String(l?.product ?? ''),
    unitPrice: Number(l?.unitPrice),
    quantity: Number(l?.quantity),
  }));
  if (lines.length === 0) {
    return NextResponse.json({ error: '至少要填一个产品的报价' }, { status: 400 });
  }
  if (lines.some((l) => !Number.isFinite(l.unitPrice) || l.unitPrice <= 0 || !Number.isFinite(l.quantity) || l.quantity <= 0)) {
    return NextResponse.json({ error: '每一行的单价与数量都必须大于 0' }, { status: 400 });
  }
  /**
   * ★ 运费不许是负数 ★ 它直接加进总额，而总额决定档位。
   * 填一个 −500 进去，一张 600 美元的 C 档单子就掉回 A 档「可纯文字」——
   * 格式合规判定跟着一起放行。界面上填不出负数，但接口是能收到的。
   */
  const freight = Number(body.freight ?? 0);
  if (!Number.isFinite(freight) || freight < 0) {
    return NextResponse.json({ error: '运费不能是负数' }, { status: 400 });
  }
  const leadTimeDays = Number(body.leadTimeDays ?? 0);
  if (!Number.isFinite(leadTimeDays) || leadTimeDays < 0) {
    return NextResponse.json({ error: '交期天数不能是负数' }, { status: 400 });
  }
  // 多产品时产品名是必填：两个价报过去分不清哪个对应哪个货，客户和复盘都读不懂
  if (lines.length > 1 && lines.some((l) => !l.product.trim())) {
    return NextResponse.json({ error: '报多个产品时，每一行都要写清产品名或型号' }, { status: 400 });
  }

  const g = await guardAct(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  // ★ 往下走的是清洗过的表单，不是原始 body ★ 否则上面这几行校验白做
  const form: QuoteForm = {
    lines,
    freight,
    ...(body.tradeTerms ? { tradeTerms: String(body.tradeTerms) } : {}),
    ...(leadTimeDays > 0 ? { leadTimeDays } : {}),
    hasQuoteSheet: Boolean(body.hasQuoteSheet),
    hasScreenshot: Boolean(body.hasScreenshot),
  };

  try {
    return NextResponse.json(await submitQuoteTurn(id, form, body.clientMsgId, body.expectedTurn));
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
