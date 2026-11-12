import { redirect } from 'next/navigation';
import { workshopMode } from '@/lib/workshop/mode';
import { latestProducts, maskTerms } from '@/lib/workshop/service';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';
import IngestClient from './IngestClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkshopPage();
  if (workshopMode() !== 'full') redirect('/workshop/bank');
  return (
    <WorkshopShell current="/workshop/ingest">
      <IngestClient maskCount={maskTerms().length} previous={latestProducts()} />
    </WorkshopShell>
  );
}
