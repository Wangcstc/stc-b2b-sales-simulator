import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { guardView } from '@/lib/session-guard';
import { isExamSession } from '@/lib/session-mode';
import { SUPPLEMENT_TURNS } from '../../../../../engine/rules';
import { turnActivity } from '../../../../../engine/facts';
import { decideTurnNudge } from '@/lib/turn-decide';
import type { DrillState, SessionFacts } from '../../../../../engine/types';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardView(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const s = await prisma.session.findUnique({
    where: { id },
    include: { variant: { include: { bgPackage: true } }, messages: { orderBy: [{ turn: 'asc' }, { role: 'desc' }] } },
  });
  if (!s) return NextResponse.json({ error: '找不到这一局' }, { status: 404 });

  /**
   * 轮内提示（2026-08-28，D9 选项 A）。
   *
   * ★ 从快照现算，不落库 ★ 它是 (事实表, 轮次) 的纯函数，刷新、换窗口、隔天回来
   * 都会得到同一句话。落一张表反而会出现"提示和事实表对不上"这种只能靠对账发现的脏数据。
   * ★ 判定在 `decideTurnNudge` 里，这里只负责把料备齐 ★ 考试局的过滤也在那个函数里，
   * 别在这儿再拦一次——两处各判一次，迟早出现"接口给了、界面不显示"或者反过来。
   */
  const examMode = isExamSession(s.mode);
  const state = s.state as unknown as DrillState;
  const activity = turnActivity(s.facts as unknown as SessionFacts, state.turn ?? 0);
  // ★ 上一轮也没进展才提示 ★ 实测 52% 的轮次「没问出新东西」，每轮都弹就是噪音
  const prev = turnActivity(s.facts as unknown as SessionFacts, (state.turn ?? 0) - 1);
  const prevQuiet =
    (state.turn ?? 0) > 1 && !prev.formAction && prev.unlocked === 0 && prev.asked === 0 && prev.collected === 0;
  const nudge = decideTurnNudge({
    examMode,
    turn: state.turn ?? 0,
    ended: s.status !== 'ACTIVE' || Boolean(s.exitReason),
    unlockedThisTurn: activity.unlocked,
    askedThisTurn: activity.asked,
    collectedThisTurn: activity.collected,
    formActionThisTurn: activity.formAction,
    previousTurnQuiet: prevQuiet,
  });

  return NextResponse.json({
    id: s.id,
    drillId: s.drillId,
    status: s.status,
    exitReason: s.exitReason,
    state: s.state,
    facts: s.facts,
    unlockState: s.unlockState,
    hasBgPackage: Boolean(s.variant.bgPackage),
    /**
     * 动作之后还能再说几句客户才回（2026-08-19 反馈 #7）。
     *
     * ★ 从接口下发，不许前端抄一份 ★ 前端不能 import 引擎（那会把整个引擎打进客户端包），
     * 而"还能再说 N 句"这句话必须跟 `SUPPLEMENT_TURNS` 一致。抄一份的话，
     * 改了配置界面就开始说假话——而且不会有任何东西报错。
     */
    supplementTurns: SUPPLEMENT_TURNS,
    sessionType: s.type,
    examMode,
    /** 上一轮有没有推进。null ＝ 没什么要说的（也包括考试局：那里永远是 null） */
    nudge,
    variant: {
      variantId: s.variant.variantId,
      openCard: s.variant.openCard,
      product: s.variant.product,
    },
    messages: s.messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content })),
  });
}
