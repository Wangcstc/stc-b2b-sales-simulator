import { NextResponse } from 'next/server';
import { requireWorkshop } from '@/lib/workshop/guard';
import { batchRows, pendingCount } from '@/lib/workshop/service';

export const dynamic = 'force-dynamic';

/** 加工页轮询：每一批走到哪了、有几张卡等确认 */
export async function GET() {
  const { denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  return NextResponse.json({ batches: batchRows(), pending: pendingCount() });
}
