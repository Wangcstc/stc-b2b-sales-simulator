import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { batchItems, continueRun, decideRetry, decideStart, releaseRest, type RetryOption, type StartOption } from '@/lib/workshop/service';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return fail(new Error('缺批次号'));
  try {
    return NextResponse.json({ items: batchItems(id) });
  } catch (e) {
    return fail(e, 404);
  }
}

/** 一批的几个动作：开工（选择题）、重做出错的（选择题）、继续加工、放开剩下的 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  try {
    const body = (await req.json()) as { action: string; batchId: string; option?: string; text?: string };
    if (body.action === 'start') return NextResponse.json({ say: await decideStart(user, body.batchId, body.option as StartOption, body.text) });
    if (body.action === 'retry') return NextResponse.json({ retried: await decideRetry(user, body.batchId, body.option as RetryOption, body.text) });
    if (body.action === 'continue') return NextResponse.json({ run: await continueRun(user, body.batchId) });
    if (body.action === 'release') {
      await releaseRest(user, body.batchId);
      return NextResponse.json({ ok: true });
    }
    return fail(new Error(`不认识的动作：${body.action}`));
  } catch (e) {
    return fail(e);
  }
}
