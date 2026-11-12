import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { loadSample } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';

/** 首次引导的「先装样品题库试玩」：8 道虚构的露营用品题 */
export async function POST() {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  try {
    return NextResponse.json(await loadSample(user));
  } catch (e) {
    return fail(e);
  }
}
