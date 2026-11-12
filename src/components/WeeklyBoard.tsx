import { loadLoginFlow, loadSessionFlow } from '@/lib/board';
import { businessDay } from '@/lib/business-day';
import { catchUpWeeks, previewWeek } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG, weekRangeText } from '@/lib/weekly-exam';
import SessionFlow from './SessionFlow';
import LoginFlow from './LoginFlow';
import WeeklyExamTable from './WeeklyExamTable';
import Help from './Help';

/**
 * 正式业务员的训练台。**CoachBoard 的周考版。**
 *
 * ★ 为什么不复用 CoachBoard ★ 试过，不行：它那两张主表
 * （今日判定 / 历史台账）从取数到列头全是准入口径——「窗口 6 格」「当日基本任务」
 * 「差多少分」——`board.ts` 的三个 where 也都写死 INTERN+ADMISSION。
 * 正式业务员套进去只会得到一张空表，或者更糟：一张摆着他不适用的门槛的表。
 *
 * ★ 下面两张表是真复用 ★ 局流水和登录流水跟身份无关，
 * `loadSessionFlow(limit, userId)` / `loadLoginFlow(limit, userId)` 本来就支持按人收窄。
 *
 * ★ 待办条不给 ★ 和 CoachBoard 同一条规矩：那是「今天谁没考」，是主管的活，
 * 而且天生是全员的——给业务员看等于把同事的进度摊开。
 */
export default async function WeeklyBoard({ userId }: { userId: string }) {
  const today = businessDay();
  // 打开这一页先把漏掉的周结算补齐——他看的是自己这周考够没有，不能是昨天的数
  await catchUpWeeks(userId, today);

  const [week, flow, logins] = await Promise.all([
    previewWeek(userId, today),
    loadSessionFlow(80, userId),
    loadLoginFlow(60, userId),
  ]);

  const { examsPerWeek, sessionsPerWeek } = WEEKLY_EXAM_CONFIG;
  const done = week.met === true;

  return (
    <>
      {/* ── 表一：本周进度 ── */}
      <div
        className="card"
        style={{ borderColor: done ? 'var(--ok)' : 'var(--line)' }}
      >
        <div className="small" style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            <span className="section-label" style={{ margin: 0, marginRight: 6 }}>
              本周
            </span>
            <span className="mono faint">{weekRangeText(week.weekStart)}</span>
          </span>
          <span>
            考试场次{' '}
            <b className="num" style={{ color: done ? 'var(--ok)' : 'var(--text)' }}>
              {week.examCount}
            </b>
            <span className="faint"> / {examsPerWeek}</span>
          </span>
          <span>
            出分局数{' '}
            <b className="num">{week.preciseCount}</b>
            <span className="faint"> / {sessionsPerWeek}</span>
          </span>
          <span>
            本周考试中位数{' '}
            {week.medianScore === null ? (
              <span className="faint">—</span>
            ) : (
              <b className="num" style={{ color: week.scoreOk ? 'var(--ok)' : 'var(--text)' }}>
                {week.medianScore}
              </b>
            )}
          </span>
        </div>
        <div className="small muted" style={{ marginTop: 8, lineHeight: 1.8 }}>
          {week.detail}
        </div>
      </div>

      {/* ── 表二：周考台账 ── */}
      <div className="section-block">
        <div className="section-title">
          周考台账
          <Help topic="train-week-board" />
        </div>
        <WeeklyExamTable userId={userId} />
      </div>

      {/* ── 表三：历史记录（局流水）── */}
      <div className="section-block">
        <div className="section-title">
          历史记录
          <Help topic="flow-sessions" />
        </div>
        <SessionFlow rows={flow} />
      </div>

      {/* ── 表四：登录流水 ── */}
      <div className="section-block">
        <div className="section-title">
          登录流水
          <Help topic="flow-logins" />
        </div>
        <LoginFlow rows={logins} />
      </div>
    </>
  );
}
