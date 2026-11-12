import { redirect } from 'next/navigation';
import { workshopMode } from '@/lib/workshop/mode';
import { pendingCount } from '@/lib/workshop/service';
import { requireWorkshopPage } from './WorkshopShell';

export const dynamic = 'force-dynamic';

/** 进题库工坊：有卡等确认先去确认；托管平台上只有题库页；其余从投料开始 */
export default async function Page() {
  await requireWorkshopPage();
  if (workshopMode() !== 'full') redirect('/workshop/bank');
  let pending = 0;
  try {
    pending = pendingCount();
  } catch {
    pending = 0;
  }
  redirect(pending ? '/workshop/review' : '/workshop/ingest');
}
