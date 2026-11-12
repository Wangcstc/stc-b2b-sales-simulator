import { feedbackView } from '@/lib/workshop/feedback';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';
import FeedbackClient from './FeedbackClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkshopPage();
  const view = await feedbackView();
  return (
    <WorkshopShell current="/workshop/feedback">
      <FeedbackClient view={JSON.parse(JSON.stringify(view))} />
    </WorkshopShell>
  );
}
