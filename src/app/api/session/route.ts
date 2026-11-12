import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/current-user';
import { createDrillSession } from '@/lib/create-session';

/** 开一局。演习 ID 前缀强制 D-（需求 12.2） */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { variantId?: string };

  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: '请先在选人页选择你是谁' }, { status: 401 });

  const session = await createDrillSession(user, body.variantId);
  return NextResponse.json({ id: session.id, drillId: session.drillId });
}
