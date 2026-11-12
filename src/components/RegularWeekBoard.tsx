import { businessDay } from '@/lib/business-day';
import { catchUpWeeks, loadRegularWeekRows } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG, weekRangeText, weekStatusLine } from '@/lib/weekly-exam';
import Help from './Help';
import PagedTable from './PagedTable';

/**
 * 教练台上的「正式业务员 · 本周考试」。**主管专属，一人一行。**
 *
 * ★ 2026-08-24 加 ★ 在这之前正式业务员在教练台上**完全隐身**：
 * `board.ts` 的三个取数（loadRoster / loadDailyTaskRows / loadTodoBar）
 * where 全是 INTERN+ADMISSION。主管想知道「他这周考了没有」，
 * 只能一个个点进他的报告页数——那等于没有。
 *
 * ★ 不并进上面那张今日判定表 ★ 那张表的每一列都是准入口径
 * （窗口 6 格、期别、差多少分、连续不达标几天），正式业务员一列都对不上；
 * 硬塞进去只会让主管以为他也在被那套门槛判。
 *
 * ★ 「未考满」不染红 ★ 周考不接任何后果（王老师 2026-08-24 定：只记录、不处罚）。
 * 红色在这一页是「要立刻处理」的意思，用在这里会把主管的注意力引偏。
 */
export default async function RegularWeekBoard() {
  const today = businessDay();
  const rows = await loadRegularWeekRows(today);
  if (rows.length === 0) return null;

  // 打开这一页顺手把周账补齐，和上面那张表调 catchUpSettlement 是同一个道理
  for (const row of rows) await catchUpWeeks(row.userId, today);

  const { examsPerWeek, sessionsPerWeek } = WEEKLY_EXAM_CONFIG;
  const behind = rows.filter((row) => row.verdict.met !== true);

  return (
    <div className="section-block">
      <div className="section-title">
        正式业务员 · 本周考试
        <span className="sub">
          {weekRangeText(rows[0]!.verdict.weekStart)} ·{' '}
          <span className="num">{rows.length - behind.length}</span>/{rows.length} 人已考满
        </span>
        <Help topic="coach-regular-week" />
      </div>

      <PagedTable
        className="team-table"
        head={
          <tr>
            <th>业务员</th>
            <th className="num-col">本周场次</th>
            <th className="num-col">出分局数</th>
            <th className="num-col">本周考试中位数</th>
            <th>本周状态</th>
          </tr>
        }
      >
        {rows.map((row) => (
          <tr key={row.userId}>
            <td>
              <b>{row.name}</b> <span className="faint mono tiny">{row.code}</span>
            </td>
            <td className="num-col small">
              <b
                className="num"
                style={{ color: row.verdict.met === true ? 'var(--ok)' : undefined }}
              >
                {row.verdict.examCount}
              </b>
              <span className="faint"> / {examsPerWeek}</span>
            </td>
            <td className="num-col small">
              <span className="num">{row.verdict.preciseCount}</span>
              <span className="faint"> / {sessionsPerWeek}</span>
            </td>
            <td className="num-col small">
              {row.verdict.medianScore === null ? (
                <span className="faint">—</span>
              ) : (
                <b
                  className="num"
                  style={{ color: row.verdict.scoreOk ? 'var(--ok)' : 'var(--text)' }}
                >
                  {row.verdict.medianScore}
                </b>
              )}
            </td>
            <td className="small">
              {row.verdict.met === true ? (
                <b style={{ color: 'var(--ok)' }}>✓ 已考满</b>
              ) : (
                <span className="muted">{weekStatusLine(row.verdict)}</span>
              )}
            </td>
          </tr>
        ))}
      </PagedTable>
    </div>
  );
}
