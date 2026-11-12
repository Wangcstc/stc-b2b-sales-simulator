import Link from 'next/link';
import AppShell from '@/components/AppShell';
import InquiryLibrary from '@/components/InquiryLibrary';
import PageHelp from '@/components/PageHelp';
import { requireUser } from '@/lib/current-user';
import { loadDrillCards, loadMyHistory } from '@/lib/inquiry-data';
import { groupByPersona, personaCoverage, type PlayRecord } from '@/lib/inquiry-pool';

export const dynamic = 'force-dynamic';

/**
 * 询盘题库（2026-08-23 新增）
 *
 * 首页只派三封，这里是全池。两页的分工：
 *   首页  = 今天该练什么，系统说了算，零选择成本；
 *   这一页 = 我想专门练什么，我说了算，给筛选器。
 *
 * ★ 不进顶部 TAB ★ 它是首页的下钻，不是第五个功能区。
 * current 传 "/" 让「模拟询盘」那个 TAB 保持高亮——
 * /account 早就是这么干的，NavTabs 匹配不到只是不高亮，不报错。
 *
 * ★ 只查 DRILL 池 ★ 考试专用的 42 封一封都不能出现在业务员看得到的地方。
 * 那条 where 在 loadDrillPool 里，别绕过它自己写查询。
 */
export default async function InquiriesPage({
  searchParams,
}: {
  // Next 15：searchParams 是 Promise
  searchParams: Promise<{ persona?: string; diff?: string; type?: string; status?: string }>;
}) {
  const user = await requireUser();
  const [pool, mine, params] = await Promise.all([loadDrillCards(), loadMyHistory(user.id), searchParams]);

  const groups = groupByPersona(pool, mine.history);
  const cover = personaCoverage(pool, mine.history);

  // Map 不往 client 组件传，换成普通对象——序列化的事少一个变数
  const records: Record<string, PlayRecord> = Object.fromEntries(mine.history);

  return (
    <AppShell current="/">
      <div className="page-head">
        <h1>询盘题库</h1>
        {/* ★ 只写「怎么用」，不解释「为什么这么设计」★ 那些话在代码注释里，不该占人的屏幕 */}
        <PageHelp page="inquiries" />
        <span className="page-head-right">
          <Link href="/">
            <button className="ghost">← 回今日待接待</button>
          </Link>
        </span>
      </div>

      {/* ★ 2026-08-28 删掉了页头下的那段说明 ★
          原文是「104 封 · 32 个考点 · 你碰过 0 个。这里的局不限次数、不计入准入——
          挑没碰过的考点练，比把同一个考点练三遍划算。」
          两句话两个毛病：前半句的数字下面的筛选器里逐项都有（难度「全部（104 封）」、
          考点「全部（32 个考点）」、「练过没有」），后半句是**为什么这么设计**，
          按这一页页头那条注释的规矩本来就不该占屏幕——它在 PageHelp（「这页怎么用」）里。 */}

      <div className="section-block">
        {pool.length === 0 ? (
          <div className="muted small">
            还没有人设。先跑 <code className="mono">npm run seed</code>。
          </div>
        ) : (
          <InquiryLibrary
            groups={groups}
            records={records}
            initial={{
              persona: params.persona,
              diff: params.diff,
              type: params.type,
              status: params.status,
            }}
          />
        )}
      </div>
    </AppShell>
  );
}
