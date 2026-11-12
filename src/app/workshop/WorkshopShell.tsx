import Link from 'next/link';
import { notFound } from 'next/navigation';
import AppShell from '@/components/AppShell';
import { canSeeEveryone, requireUser, type CurrentUser } from '@/lib/current-user';
import { BANK_ONLY_NOTICE, workshopMode } from '@/lib/workshop/mode';
import { pendingCount } from '@/lib/workshop/service';

/** 题库工坊的五个页面（需求文档 5.2），加上阶段 6 的回流页 */
const PAGES = [
  { href: '/workshop/ingest', label: '投料', full: true },
  { href: '/workshop/jobs', label: '加工', full: true },
  { href: '/workshop/review', label: '确认', full: true },
  { href: '/workshop/bank', label: '题库', full: false },
  { href: '/workshop/coverage', label: '覆盖', full: false },
  { href: '/workshop/feedback', label: '回流', full: false },
] as const;

/** 只有主管和管理员进得来；业务员直接 404（看见了会去点，点了没权限，不如不存在） */
export async function requireWorkshopPage(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!canSeeEveryone(user)) notFound();
  return user;
}

export default function WorkshopShell({ current, sub, children }: { current: string; sub?: React.ReactNode; children: React.ReactNode }) {
  const full = workshopMode() === 'full';
  let pending = 0;
  try {
    pending = full ? pendingCount() : 0;
  } catch {
    pending = 0;
  }
  return (
    <AppShell current="/workshop">
      <div className="page-head">
        <h1>题库工坊</h1>
      </div>
      <div className="page-sub small muted">用你们公司自己的聊天记录做题：投料 → 加工 → 确认 → 上架。凡是要你拍板的事都是选择题，推荐项排第一。</div>
      <nav className="ws-tabs">
        {PAGES.filter((p) => full || !p.full).map((p) => (
          <Link key={p.href} href={p.href} className={current === p.href ? 'on' : ''}>
            {p.label}
            {p.href === '/workshop/review' && pending > 0 && <span className="badge">{pending}</span>}
          </Link>
        ))}
      </nav>
      {!full && <div className="card ws-notice small">{BANK_ONLY_NOTICE}</div>}
      {sub}
      {children}
    </AppShell>
  );
}
