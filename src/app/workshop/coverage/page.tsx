import Link from 'next/link';
import { examCoverage } from '@/lib/workshop/bank';
import { workshopMode } from '@/lib/workshop/mode';
import WorkshopShell, { requireWorkshopPage } from '../WorkshopShell';

export const dynamic = 'force-dynamic';

/**
 * 覆盖页（需求文档 5.2）：55 型各有几道题、缺哪些、建议补什么样的聊天。
 * 数的是当前在用的题（停用的不算），与派题、开考看到的是同一批。
 * ★ 只提示，不设门槛 ★ 演习有题就能练；考试按槽位看还差什么（2026-11-06 王老师定）。
 */
export default async function Page() {
  await requireWorkshopPage();
  const c = await examCoverage();
  const full = workshopMode() === 'full';
  const gaps = c.slots.filter((s) => !s.ready);
  return (
    <WorkshopShell current="/workshop/coverage">
      <div className="ws-grid">
        <div className="card ws-grid">
          <b>
            {c.version ? (
              <>
                当前题库 <span className="mono">{c.version.bankId} v{c.version.bankVersion}</span>：在用 {c.total} 道（演习 {c.drill}、考试 {c.exam}）
              </>
            ) : (
              '还没有题库'
            )}
          </b>
          <div className="small">{c.drill > 0 ? '演习：有题就能练。题越多，业务员越不容易撞题。' : '演习：还没有演习题。'}</div>
          <div className="table-wrap">
            <table className="team-table">
              <thead>
                <tr>
                  <th>考试槽位</th>
                  <th className="num-col">题数</th>
                  <th className="num-col">题型数</th>
                  <th>状态</th>
                  <th>还没有的题型</th>
                </tr>
              </thead>
              <tbody>
                {c.slots.map((s) => (
                  <tr key={s.slot}>
                    <td>{s.label}</td>
                    <td className="num-col">
                      {s.questions} / {s.needQuestions}
                    </td>
                    <td className="num-col">
                      {s.types} / {s.needTypes}
                    </td>
                    <td>{s.ready ? <span className="chip ok">够了</span> : <span className="chip warn">还差</span>}</td>
                    <td className="small">
                      {s.missingTypes.slice(0, 8).map((t) => t.name).join('、')}
                      {s.missingTypes.length > 8 ? ` 等 ${s.missingTypes.length} 种` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {gaps.length > 0 && (
            <div className="small muted">
              考试要三个槽位都凑齐才开得了（凑齐前演习不受影响）。每道母题会衍生几道考试题，一个槽位大约 5 份对路的聊天就够；
              真实聊天里「探需 · 困难」这一槽最难攒，碰到这类买家的聊天优先投{full ? <>（<Link href="/workshop/ingest">去投料</Link>）</> : null}。
            </div>
          )}
        </div>

        {c.stages.map((st) => (
          <div key={st.code} className="card ws-grid">
            <b>
              {st.code} · {st.name}
            </b>
            <div className="table-wrap">
              <table className="team-table">
                <thead>
                  <tr>
                    <th>题型</th>
                    <th className="num-col">演习</th>
                    <th className="num-col">考试</th>
                    <th>没有题时，找什么样的聊天</th>
                  </tr>
                </thead>
                <tbody>
                  {st.types.map((t) => (
                    <tr key={t.code}>
                      <td>
                        <span className="mono small">{t.code}</span> {t.name}
                        {!t.examEligible && <span className="tiny faint"> · 只进演习</span>}
                      </td>
                      <td className="num-col">{t.drill || '—'}</td>
                      <td className="num-col">{t.examEligible ? t.exam || '—' : ''}</td>
                      <td className="small muted">{t.drill + t.exam === 0 ? t.signals : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </WorkshopShell>
  );
}
