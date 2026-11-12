import { redirect } from 'next/navigation';
import { workshopMode } from '@/lib/workshop/mode';
import { batchRows } from '@/lib/workshop/service';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';
import JobsClient from './JobsClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkshopPage();
  if (workshopMode() !== 'full') redirect('/workshop/bank');
  return (
    <WorkshopShell current="/workshop/jobs">
      <JobsClient initial={JSON.parse(JSON.stringify(batchRows()))} />
    </WorkshopShell>
  );
}
