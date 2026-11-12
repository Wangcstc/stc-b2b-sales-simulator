import { redirect } from 'next/navigation';
import { workshopMode } from '@/lib/workshop/mode';
import { pendingCards } from '@/lib/workshop/service';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';
import ReviewClient from './ReviewClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkshopPage();
  if (workshopMode() !== 'full') redirect('/workshop/bank');
  return (
    <WorkshopShell current="/workshop/review">
      <ReviewClient cards={JSON.parse(JSON.stringify(pendingCards()))} />
    </WorkshopShell>
  );
}
