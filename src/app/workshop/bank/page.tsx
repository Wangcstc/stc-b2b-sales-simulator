import { workshopMode } from '@/lib/workshop/mode';
import { currentQuestions, packPlan, versionRows } from '@/lib/workshop/bank';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';
import BankClient from './BankClient';

export const dynamic = 'force-dynamic';

export default async function Page() {
  await requireWorkshopPage();
  const full = workshopMode() === 'full';
  const [versions, plan, questions] = await Promise.all([versionRows(), full ? packPlan() : Promise.resolve(null), currentQuestions()]);
  return (
    <WorkshopShell current="/workshop/bank">
      <BankClient versions={JSON.parse(JSON.stringify(versions))} plan={plan ? JSON.parse(JSON.stringify(plan)) : null} questions={questions} />
    </WorkshopShell>
  );
}
