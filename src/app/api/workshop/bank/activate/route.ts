import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { decideActivate } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';

/** 切换为当前版本 / 回滚（选择题）。正在打的局不受影响，切换后新开的局用新版本 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  try {
    const body = (await req.json()) as { versionId: string; option: 'switch' | 'keep' | 'other'; text?: string };
    return NextResponse.json({ switched: await decideActivate(user, body.versionId, body.option, body.text) });
  } catch (e) {
    return fail(e);
  }
}
