import { loadDayRows } from '@/lib/board';
import { ADMISSION_CONFIG, fmt } from '@/lib/admission-v11';
import { TASK_COLUMNS } from '@/lib/task-columns';
import PagedTable from './PagedTable';
import EmptyState from './EmptyState';

/**
 * 按日期倒序的判定明细（方案第三节的「展开一个人」）。
 *
 * ★ 判定条件要逐条显示，不能只给一个总的「不达标」★
 * 否则人只知道没过，不知道卡在哪一条——那就没法指导他改。
 * （2026-08-21 起判定只剩局分一条，这一列就只画一个勾叉；
 *   算法没删，`ADMISSION_CONFIG.activeGates` 加回来它会自己变回几条。）
 *
 * 管理员展开某个人、业务员看自己，用的是同一张表。
 * 区别只在数据源：业务员只拿得到自己的 userId。
 */
export default async function EvaluationTable({ userId, take = 10 }: { userId: string; take?: number }) {
  const rows = await loadDayRows(userId, take);
  if (rows.length === 0) {
    return (
      <EmptyState
        style={{ marginTop: 14 }}
        title="还没有判定记录。"
        hint="每晚结算跑过之后，当天考过试的人会在这里多一行；没考的那天也占一行，写明缺考。"
      />
    );
  }

  const cell = (value: number | null) =>
    typeof value === 'number' ? <span className="num">{value}</span> : <span className="faint">证据不足</span>;

  /* ★ 判定窗口是最近 6 局，不是这张表的全部 ★
     标出「在窗口内」的那两场，主管才知道今天的结论是由哪几局算出来的。 */
  return (
    <PagedTable
      className="team-table"
      wrapStyle={{ marginTop: 14 }}
      head={
        <tr>
          <th>日期</th>
          <th className="num-col">局 1</th>
          <th className="num-col">局 2</th>
          <th className="num-col">局 3</th>
          {/* ★ 都要带「考试」两个字 ★（2026-08-23 王老师定）演习局一局都不进这张表，
              写「3 局」「6 局」会让人以为模拟询盘那些也算进来了。 */}
          <th className="num-col">当日 {ADMISSION_CONFIG.sessionsPerExam} 局考试中位数</th>
          <th className="num-col">窗口 {ADMISSION_CONFIG.windowSessions} 局考试中位数</th>
          <th>判定窗口</th>
          <th>{TASK_COLUMNS.gates}</th>
        </tr>
      }
    >
      {rows.map((row) => (
        <tr key={row.day}>
          <td className="mono small">{row.day}</td>
          <td className="num-col small">{cell(row.scores[0] ?? null)}</td>
          <td className="num-col small">{cell(row.scores[1] ?? null)}</td>
          <td className="num-col small">{cell(row.scores[2] ?? null)}</td>
          <td className="num-col small">{row.dayMedian === null ? <span className="faint">—</span> : <span className="num">{fmt(row.dayMedian)}</span>}</td>
          <td className="num-col small">
            {row.rollingMedian === null ? (
              <span className="faint">—</span>
            ) : (
              <b className="num" style={{ color: row.passed ? 'var(--ok)' : 'var(--text)' }}>{fmt(row.rollingMedian)}</b>
            )}
          </td>
          <td className="small">
            {row.inWindow ? (
              <b style={{ color: 'var(--accent-text)' }}>✓ 在窗口内</b>
            ) : (
              <span className="faint">历史</span>
            )}
          </td>
          <td className="small">
            {row.gates.length === 0 ? (
              <span className="faint">{row.sampleText || '当晚尚未结算'}</span>
            ) : row.passed === null ? (
              <span className="faint">{row.sampleText}</span>
            ) : (
              <span style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {row.gates.map((gate) => (
                  <span key={gate.key} style={{ color: gate.passed ? 'var(--ok)' : 'var(--bad)' }}>
                    {gate.label}
                    {gate.passed ? '✓' : '✗'}
                  </span>
                ))}
                {row.consecutiveFails > 0 && (
                  <span style={{ color: 'var(--warn)' }}>连续 {row.consecutiveFails} 天不达标</span>
                )}
              </span>
            )}
          </td>
        </tr>
      ))}
    </PagedTable>
  );
}
