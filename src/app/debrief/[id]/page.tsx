import { notFound, redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { guardAct } from '@/lib/session-guard';
import DebriefClient from './DebriefClient';
import { isExamSession } from '@/lib/session-mode';

export const dynamic = 'force-dynamic';

export default async function DebriefPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // 复盘是要作答的，只有本人能进——主管代答出来的作答质量分是假的
  const g = await guardAct(id);
  if (!g.ok) {
    if (g.status === 401) redirect('/signin');
    notFound();
  }

  // ★ 把聊天记录一起取出来 ★ 复盘问的是「第 3 轮你为什么…」，
  // 看不到那一轮说过什么就只能凭印象编，编出来的答案没有复盘价值
  const s = await prisma.session.findUnique({
    where: { id },
    include: {
      coachQa: { orderBy: { idx: 'asc' } },
      score: true,
      messages: { orderBy: [{ turn: 'asc' }, { role: 'desc' }] },
      variant: { include: { persona: true } },
    },
  });
  if (!s) notFound();
  if (s.score) redirect(`/report/${id}`);
  if (s.coachQa.length === 0) redirect(`/drill/${id}`);

  const open = s.variant.openCard as Record<string, unknown>;

  return (
    <DebriefClient
      sessionId={id}
      inquiryText={String(open.inquiry_text ?? '')}
      followup={s.variant.persona.sessionType === 'FOLLOWUP'}
      messages={s.messages.map((m) => ({ turn: m.turn, role: m.role, content: m.content }))}
      initial={s.coachQa.map((q) => ({
        idx: q.idx,
        question: q.question,
        answer: q.answer,
        followUp: q.followUp,
        followUpAnswer: q.followUpAnswer,
        skipped: q.skipped,
      }))}
    />
  );
}
