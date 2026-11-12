import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { decideFeedback, feedbackView, type Decision, type SuggestionKind } from '@/lib/workshop/feedback';

export const dynamic = 'force-dynamic';

/** 回流：每道题的实战统计与回炉建议 */
export async function GET() {
  const { denied } = await requireWorkshop();
  if (denied) return denied;
  return NextResponse.json(await feedbackView());
}

/** 对一条回炉建议拍板（选择题）：回炉 / 降为演习 / 下架 / 保留 / 其他 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  try {
    const body = (await req.json()) as { variantId: string; kind: SuggestionKind; option: Decision; text?: string };
    return NextResponse.json({ say: await decideFeedback(user, body) });
  } catch (e) {
    return fail(e);
  }
}
