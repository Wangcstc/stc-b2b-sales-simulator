import { NextResponse } from 'next/server';
import { requireWorkshop } from '@/lib/workshop/guard';
import { maskTerms } from '@/lib/workshop/service';

export const dynamic = 'force-dynamic';

/** 投料页在浏览器里脱敏要用的本批脱敏词表（本机 DRAWER_MASK_FILE）。只给主管 */
export async function GET() {
  const { denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  return NextResponse.json({ terms: maskTerms() });
}
