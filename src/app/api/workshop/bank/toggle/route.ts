import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { toggleQuestion } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';

/** 停用 / 恢复当前版本里的一道题。停考试题会让槽位不够时先返回警告，主管确认后带 force 再来 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  try {
    const body = (await req.json()) as { variantId: string; enable: boolean; force?: boolean };
    return NextResponse.json(await toggleQuestion(user, body.variantId, body.enable, body.force));
  } catch (e) {
    return fail(e);
  }
}
