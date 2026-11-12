import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { decidePack, packPlan, type PackOption } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET() {
  const { denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  return NextResponse.json(await packPlan());
}

/** 打包上架（选择题）：打包并切换 / 装入先不切换 / 先不打包 / 其他（指定版本号） */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  try {
    const body = (await req.json()) as { option: PackOption; text?: string };
    const r = await decidePack(user, body.option, body.text);
    return NextResponse.json(
      r
        ? { bankId: r.report.manifest.bank_id, bankVersion: r.report.manifest.bank_version, added: r.report.added, total: r.report.manifest.counts.total, activated: r.load.activated, drill: r.drill, exam: r.exam }
        : { skipped: true },
    );
  } catch (e) {
    return fail(e);
  }
}
