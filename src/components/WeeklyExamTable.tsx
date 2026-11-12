import { loadWeekRecords } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG, weekRangeText } from '@/lib/weekly-exam';
import PagedTable from './PagedTable';
import EmptyState from './EmptyState';

/**
 * 正式业务员的周考台账。**对应实习业务员那边的 EvaluationTable。**
 *
 * ★ 一周一行，没考的那周照样占一行 ★ 只列有记录的周，等于让「整周没考」
 * 长得像「还没到那一周」——周结算每晚都 upsert 最近 8 周，所以空周本来就有行。
 *
 * ★ 「未考满」不标红 ★（2026-08-24 王老师定：只记录、不处罚）
 * 准入那张表里 ✗ 是红的，因为它后面接着停询盘；这里接不上任何后果，
 * 染成红色只会让人以为出事了。
 */
export default async function WeeklyExamTable({
  userId,
  take = WEEKLY_EXAM_CONFIG.ledgerWeeks,
}: {
  userId: string;
  take?: number;
}) {
  const rows = await loadWeekRecords(userId, take);
  if (rows.length === 0) {
    return (
      <EmptyState
        style={{ marginTop: 14 }}
        title="还没有周考记录。"
        hint="去「考试闸门」考一场，这里就会有本周这一行。一周一行，没考满的那周照样占一行。"
      />
    );
  }

  const { examsPerWeek, sessionsPerWeek, medianScoreMin } = WEEKLY_EXAM_CONFIG;

  return (
    <PagedTable
      className="team-table"
      wrapStyle={{ marginTop: 14 }}
      head={
        <tr>
          <th>周次</th>
          {/* ★ 都要带「考试」两个字 ★ 练习局一局都不进这张表，
              写「6 局」会让人以为模拟询盘那些也算进来了。 */}
          <th className="num-col">考试场次</th>
          <th className="num-col">出分局数</th>
          <th className="num-col">本周考试中位数</th>
          <th>本周要求</th>
        </tr>
      }
    >
      {rows.map((row) => {
        const detail = (row.detail ?? {}) as { text?: string };
        return (
          <tr key={row.weekStart}>
            <td className="small">
              {weekRangeText(row.weekStart)}
              <div className="mono tiny faint">{row.weekStart}</div>
            </td>
            <td className="num-col small">
              <span className="num">{row.examCount}</span>
              <span className="faint"> / {examsPerWeek}</span>
            </td>
            <td className="num-col small">
              <span className="num">{row.preciseCount}</span>
              <span className="faint"> / {sessionsPerWeek}</span>
            </td>
            <td className="num-col small">
              {row.medianScore === null ? (
                <span className="faint">—</span>
              ) : (
                <b
                  className="num"
                  style={{ color: row.medianScore >= medianScoreMin ? 'var(--ok)' : 'var(--text)' }}
                >
                  {row.medianScore}
                </b>
              )}
            </td>
            <td className="small">
              {/* ★ 三态，不是两态 ★ null = 这一周还没过完，
                  现在说他「没考满」是拿没到期的账催人 */}
              {row.met === true ? (
                <b style={{ color: 'var(--ok)' }}>✓ 已完成</b>
              ) : row.met === false ? (
                <span className="muted">未考满</span>
              ) : (
                <span className="faint">进行中</span>
              )}
              {detail.text && (
                <div className="tiny faint" style={{ marginTop: 3 }}>
                  {detail.text}
                </div>
              )}
            </td>
          </tr>
        );
      })}
    </PagedTable>
  );
}
