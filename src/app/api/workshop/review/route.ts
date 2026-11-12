import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { answerAll, answerCard, pendingCards } from '@/lib/workshop/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  return NextResponse.json({ cards: pendingCards(new URL(req.url).searchParams.get('batch') ?? undefined) });
}

/** 答一张卡；或者 all=true：这一批的演习题卡全部按推荐处理（考试题必须逐道确认） */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  try {
    const body = (await req.json()) as { batchId: string; cardId?: string; option?: string; text?: string; all?: boolean };
    if (body.all) return NextResponse.json({ answered: await answerAll(user, body.batchId) });
    const card = await answerCard(user, body.batchId, body.cardId!, body.option!, body.text);
    return NextResponse.json({ card });
  } catch (e) {
    return fail(e);
  }
}
