import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { guardView } from '@/lib/session-guard';
import DrillClient from './DrillClient';
import { isExamSession } from '@/lib/session-mode';
import { SUPPLEMENT_TURNS } from '../../../../engine/rules';
import { turnActivity } from '../../../../engine/facts';
import { decideTurnNudge } from '@/lib/turn-decide';
import type { DrillState, SessionFacts } from '../../../../engine/types';

export const dynamic = 'force-dynamic';

export default async function DrillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 别人的局连页面都不给开——只挡接口的话，对话框还是会渲染出来，误导人
  const g = await guardView(id);
  if (!g.ok) {
    if (g.status === 401) redirect('/signin');
    notFound();
  }

  const s = await prisma.session.findUnique({
    where: { id },
    include: { variant: { include: { bgPackage: true } }, messages: { orderBy: [{ turn: 'asc' }, { role: 'desc' }] } },
  });
  if (!s) notFound();

  // 主管能看别人的局，但不能替人聊——只读模式，输入框锁死
  const readOnly = s.userId !== g.user.id;

  // ★ 首帧就要带上轮内提示 ★ 与 supplementTurns 同一个理由：
  // 只在 /api/session 那边算的话，刷新后到第一次 refresh 之间提示会闪一下才出现。
  // 口径与那边共用同两个函数，不是抄一份。
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

  return (
    <DrillClient
      readOnly={readOnly}
      initial={{
        id: s.id,
        drillId: s.drillId,
        status: s.status,
        exitReason: s.exitReason,
        state: s.state as never,
        facts: s.facts as never,
        hasBgPackage: Boolean(s.variant.bgPackage),
        // ★ 首帧也要带上 ★ 只在 /api/session 那边给的话，刷新后到第一次 refresh 之间
        // 「还能再说 N 句」会短暂地按兜底值显示（2026-08-19 反馈 #7）
        supplementTurns: SUPPLEMENT_TURNS,
        sessionType: s.type,
        examMode,
        nudge,
        variant: {
          variantId: s.variant.variantId,
          openCard: s.variant.openCard as never,
          product: s.variant.product as never,
        },
        messages: s.messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content })),
      }}
    />
  );
}
