import {
  loadDailyTaskRows,
  loadLoginFlow,
  loadSessionFlow,
  loadTodoBar,
  STAGE_LABEL,
  type DailyTaskRow,
} from '@/lib/board';
import { EXAM_POOL_HEALTH } from '@/lib/exam';
import { catchUpSettlement } from '@/lib/settlement';
import { businessDay } from '@/lib/business-day';
import { prisma } from '@/lib/db';
import Help from './Help';
import TaskLedger from './TaskLedger';
import SessionFlow from './SessionFlow';
import LoginFlow from './LoginFlow';
import RegularWeekBoard from './RegularWeekBoard';
import { TaskCells } from './TaskCells';
import { TASK_COLUMNS, TD as CELL_TD, TH as CELL_TH } from '@/lib/task-columns';
import PagedTable from './PagedTable';
import EmptyState from './EmptyState';

/** 历史台账往回摆多少个业务日。7 天太短——主管要看的是「这两周他怎么走的」 */
const LEDGER_DAYS = 30;

/**
 * 教练台的看板部分（2026-08-20 重做）
 *
 * ★ 排在最前的必须是「今天要干什么」★
 * 原来教练台一打开是「标尺校准」——一个季度用一次的东西占着首屏，
 * 而主管每天真正要回答的是：今天谁能接询盘、谁没完成任务、谁在等我裁。
 *
 * ★ 只呈现库里真有的东西 ★ 三张表全部来自已经在写的数据，
 * 没有任何推算出来的"指标"。
 */

const TH = CELL_TH;
const TD = { ...CELL_TD, whiteSpace: 'normal' as const };
const TODAY_COLUMNS = ['145px', '144px', '74px', '25%', '116px', '104px', 'auto'];

/** 今日那张表的一行。列的口径与历史台账共用 TaskCells，不再各写一遍 */
function TaskRow({ row }: { row: DailyTaskRow }) {
  return (
    <tr>
      <td style={TD}>
        <b>{row.name}</b> <span className="faint mono tiny">{row.code}</span>
      </td>
      <TaskCells row={row} td={TD} compact />
    </tr>
  );
}

/**
 * @param scopeUserId 只看这一个人的数据。★ 业务员的训练台用它 ★（2026-08-22 王老师定）
 *   业务员没有教练台，但「今日判定 / 历史台账 / 历史记录 / 登录流水」这四张表他该有自己那份——
 *   同一套表、同一套口径，只是数据收窄到他一个人。
 *   ★ 待办条只在主管模式出现 ★ 那是「今天谁没考、谁在等我裁」，是主管的活，
 *   而且它天然是全员的——给业务员看等于泄露同事的进度。
 */
export default async function CoachBoard({ scopeUserId }: { scopeUserId?: string } = {}) {
  const solo = Boolean(scopeUserId);

  // 打开这一页先把漏掉的结算补齐——主管正要照着这些数字决定今天给谁分询盘；
  // 业务员看的是自己达标没有，同样不能是昨天的数。
  const interns = await prisma.user.findMany({
    where: {
      employeeType: 'INTERN',
      participationMode: 'ADMISSION',
      disabledAt: null,
      ...(scopeUserId ? { id: scopeUserId } : {}),
    },
    select: { id: true },
  });
  for (const intern of interns) await catchUpSettlement(intern.id);

  const [todo, rows, flow, logins] = await Promise.all([
    solo ? Promise.resolve(null) : loadTodoBar(),
    loadDailyTaskRows(LEDGER_DAYS, scopeUserId),
    loadSessionFlow(80, scopeUserId),
    loadLoginFlow(60, scopeUserId),
  ]);

  // 主管模式的「今天」由待办条给（它认得休息日）；单人模式退回台账最新那一天
  const today = todo?.today ?? rows[0]?.day ?? businessDay();
  const todayRows = rows.filter((row) => row.day === today);
  // 今天那一行摆在上面那张表里，台账只收已经过去的业务日
  const historyRows = rows.filter((row) => row.day !== today);
  const historyDays = [...new Set(historyRows.map((row) => row.day))];

  return (
    <>
      {/* ── 待办条：只放要立刻处理的事 ──
          ★ 主管专属 ★ 它列的是全员今天谁没考、谁在等裁定，业务员模式下整块不渲染。 */}
      {/* 待办条只为「今天还没考的人」变色。红线自 2026-08-21 起不卡资格，不再算待办 */}
      {todo && (
      <div
        className="card"
        style={{
          // ★ 日历见底比「今天谁没考」更急 ★ 没考是一个人一天的事；
          // 日历没标是**全员整段**被判缺考，而且要等到假期当天才发作。
          borderColor:
            todo.calendar.level === 'urgent' || todo.calendar.level === 'never'
              ? 'var(--bad)'
              : todo.notExamined.length > 0 || todo.calendar.level === 'warn'
                ? 'var(--warn)'
                : 'var(--line)',
        }}
      >
        <div className="small" style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>
            <span className="section-label" style={{ margin: 0, marginRight: 6 }}>
              {todo.restDay ? '最近业务日' : '今日'}
            </span>
            <span className="mono faint">{today}</span>
            {/* ★ 休息日要说出来 ★ 不说的话，周六打开教练台看到的是周五的日期，
                会以为系统卡住了；而下面那份「未考」名单确实是周五的 */}
            {todo.restDay && <span className="tiny faint" style={{ marginLeft: 6 }}>（今天休息）</span>}
          </span>
          <span>
            今日未考{' '}
            <b className="num" style={{ color: todo.notExamined.length > 0 ? 'var(--bad)' : 'var(--ok)' }}>
              {todo.notExamined.length}
            </b>{' '}
            人
            {todo.notExamined.length > 0 && (
              <span className="muted">
                （
                {todo.notExamined
                  .map((item) =>
                    item.drillRequired > 0
                      ? `${item.name} ${item.drillDone}/${item.drillRequired} 局`
                      : item.name,
                  )
                  .join('、')}
                ）
              </span>
            )}
          </span>
          {todo.stageChangedToday.length > 0 && (
            <span>
              今日状态变化{' '}
              <b className="num" style={{ color: 'var(--accent-text)' }}>{todo.stageChangedToday.length}</b> 人
              <span className="muted">
                （{todo.stageChangedToday.map((item) => `${item.name} → ${STAGE_LABEL[item.stage]}`).join('、')}）
              </span>
            </span>
          )}
          <span className="faint">待校准 {todo.pendingCalibration} 局</span>
          {/* ★ 考试池见底要在这儿喊 ★（2026-08-28）
              和工作日历同一个道理：池子空不会报错，只会静静地开始重复考点。
              「还剩几天不重题」按人算——池子是全员共用的，见过没见过却是一人一份。 */}
          {todo.pool.tightest && todo.pool.tightest.days <= EXAM_POOL_HEALTH.freshDaysWarn && (
            <span style={{ color: todo.pool.tightest.days <= 2 ? 'var(--bad)' : 'var(--warn)' }}>
              <b>
                考试池：{todo.pool.tightest.name} 的「{todo.pool.tightest.label}」还剩{' '}
                {todo.pool.tightest.days} 天不重题
              </b>
              <span className="muted">（去下面「考试题库」看哪个槽位要补）</span>
            </span>
          )}
          {todo.pool.slots.some((slot) => !slot.ok) && (
            <span style={{ color: 'var(--warn)' }}>
              <b>
                考点偏少：
                {todo.pool.slots
                  .filter((slot) => !slot.ok)
                  .map((slot) => `${slot.label} ${slot.personas} 个考点`)
                  .join('、')}
              </b>
            </span>
          )}
          {/* ★ 工作日历见底要在这儿喊 ★（2026-08-22）这类功能最常见的死法不是写错，
              是没人维护——春节前谁都不会主动想起它。主管每天都看这一条，
              所以警报摆在这里，不摆在折叠起来的日历面板里。 */}
          {todo.calendar.level !== 'ok' && (
            <span
              style={{
                color: todo.calendar.level === 'warn' ? 'var(--warn)' : 'var(--bad)',
              }}
            >
              <b>{todo.calendar.text}</b>
              <span className="muted">（去账号管理 → 工作日历排下一段）</span>
            </span>
          )}
        </div>
      </div>
      )}

      {/* ── 表一：今日判定 ── */}
      <div className="section-block">
        <div className="section-title">
          今日判定
          <Help topic="coach-verdict" />
        </div>
        {todayRows.length === 0 ? (
          <EmptyState
            title={solo ? `今天（${today}）还没有你的判定行。` : '还没有实习业务员账号。'}
            hint={
              solo
                ? '判定要等当天有考试局、或者当晚结算跑过才出得来。'
                : '去「账号管理」把员工身份设成「实习业务员」，第二天这里就会有他的判定行。'
            }
            icon={solo ? 'target' : 'users'}
          />
        ) : (
          <PagedTable
            className="daily-verdict-table small"
            cols={TODAY_COLUMNS}
            tableStyle={{ width: '100%', borderSpacing: 0 }}
            head={
              <tr className="faint">
                <th style={TH}>业务员</th>
                <th style={TH}>{TASK_COLUMNS.stage}</th>
                <th style={TH}>{TASK_COLUMNS.drill}</th>
                <th style={TH}>{TASK_COLUMNS.window}</th>
                <th style={TH}>{TASK_COLUMNS.baseTask}</th>
                <th style={TH}>{TASK_COLUMNS.gates}</th>
                <th style={TH}>{TASK_COLUMNS.gap}</th>
              </tr>
            }
          >
            {todayRows.map((row) => (
              <TaskRow key={`${row.day}-${row.userId}`} row={row} />
            ))}
          </PagedTable>
        )}

        {/* ── 历史台账 ──
            原来是「一天一张小卡片」，七个业务日七张卡、七个日期标题，没有表头。
            现在是一张连续的表，日期是第一列，上面挂人员 / 期别 / 日期筛选。 */}
        {historyRows.length > 0 && (
          <details className="card section-fold" style={{ marginTop: 12, padding: '12px 16px' }}>
            <summary>
              历史台账
              <span className="sub">
                {historyDays.length} 个业务日 · <span className="num">{historyRows.length}</span> 行 · 周末不计
              </span>
            </summary>
            <div style={{ marginTop: 14 }}>
              <TaskLedger rows={historyRows} />
            </div>
          </details>
        )}
      </div>

      {/* ── 「准入判定」那块已于 2026-08-21 并进上面那张表 ──
          它原来是一排折叠行，不点开只有「样本不足 —」，等于没信息；而它真正独有的
          两样东西——差多少、今天考完之后此刻过没过——现在直接摆在
          「今日判定」表的「判定」和「差在哪」两列里。
          其余内容别处本来就有：人工设定与系统判定在账号管理页，
          某个人的历次考试在「历史台账」里筛他的名字。 */}

      {/* ── 正式业务员 · 本周考试 ──
          ★ 主管专属，单人模式不出现 ★ 业务员的训练台传 scopeUserId，
          那一页只该有他自己的数据；这一块天生是全员的。
          正式业务员自己的周考在 WeeklyBoard 里，不在这儿。 */}
      {!solo && <RegularWeekBoard />}

      {/* ── 表二：历史记录（局流水）── */}
      <div className="section-block">
        <div className="section-title">
          历史记录
          <Help topic="flow-sessions" />
        </div>
        <SessionFlow rows={flow} />
      </div>

      {/* ── 表三：登录流水 ── */}
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
