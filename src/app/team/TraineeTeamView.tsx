import { prisma } from '@/lib/db';
import WorkCalendarPanel from './WorkCalendarPanel';
import { loadAuditLog, AUDIT_LABEL, AFFECTS_JUDGEMENT } from '@/lib/admin-audit';
import { STAGE_LABEL } from '@/lib/admission-v11';
import type { CurrentUser } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';
import { previewWeek } from '@/lib/weekly-settlement';
import { WEEKLY_EXAM_CONFIG } from '@/lib/weekly-exam';
import PagedTable from '@/components/PagedTable';
import EmptyState from '@/components/EmptyState';
import ChangePassword from '@/components/ChangePassword';

/**
 * 账号管理 · 业务员视图（2026-08-22 王老师定）
 *
 * ★ 同一个 TAB，两套内容 ★ 主管看全员、能动人；业务员看自己、一个都动不了。
 * 给他这一页是因为有三件事他本来就该知道，过去只能靠问主管：
 *   ① 哪几天放假、他哪几天请了假 —— 那决定了哪几天不算他缺考
 *   ② 他自己的账号被设成了什么身份、什么期别
 *   ③ 主管动过他什么（改身份、改期别、停用、标请假）
 *
 * ★ 这一页一个 server action 都不 import ★ 不是靠「不显示按钮」来限权——
 * 按钮藏起来，接口还在；这里连改的入口都不存在，主管那套动作全在 page.tsx 里。
 * 数据也一律按「是我 / 对我」查，不是查全量再渲染时筛。
 */

function fmt(at: Date | undefined): string {
  if (!at) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
}

const EMPLOYEE_LABEL: Record<string, string> = {
  INTERN: '实习业务员',
  REGULAR: '正式业务员',
  OTHER: '待确认',
};
const MODE_LABEL: Record<string, string> = {
  ADMISSION: '走准入考试',
  // ★ 2026-08-24 由「走演习校准」改 ★ 校准任务同日整个删了；
  // 正式业务员现在的训练要求就是周考
  WEEKLY_EXAM: '走周考',
  NONE: '不走训练',
};

/** 一格：标签在上、值在下。比表格更适合「只有一行」的数据 */
function Field({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="section-label" style={{ margin: 0 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 'var(--fs-base)', fontWeight: 600 }}>{value}</div>
      {sub && <div className="tiny faint" style={{ marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default async function TraineeTeamView({
  me,
  pwErr,
  pwOk,
}: {
  me: CurrentUser;
  /** 改口令的结果，由 page.tsx 从查询串透传下来 */
  pwErr?: string;
  pwOk?: string;
}) {
  const [row, drills, lastLogin, overrides, audit] = await Promise.all([
    prisma.user.findUnique({
      where: { id: me.id },
      include: { _count: { select: { sessions: true, examAttempts: true } } },
    }),
    // ★ 自由局单独数 ★（2026-08-27）上面那个 _count.sessions 把考试局也算在里面了，
    // 「练了多少」写成「自由 N 局 / 考试 N 场」之后，自由局得按 mode=DRILL 单独数。
    prisma.session.count({ where: { userId: me.id, mode: 'DRILL' } }),
    // ★ 只查自己那一条 ★ loadLastSeen() 拉的是全员最后登录时间——
    // 这一页只用得到一格，没有理由把全员的登录时间取进内存。
    prisma.loginEvent.findFirst({
      where: { userId: me.id },
      orderBy: { at: 'desc' },
      select: { at: true },
    }),
    // 主管手工改过我的期别：谁改的、改成什么、为什么、从哪天起算
    prisma.accessDecision.findMany({
      where: { manualOverride: true, subjectId: me.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { operator: { select: { name: true } } },
    }),
    // 管理动作流水，只要「对我做的」那些
    loadAuditLog(40, me.id),
  ]);

  const track = examTrackOf(me);
  const intern = track === 'ADMISSION';
  // 正式业务员这一格摆的是「本周考够没有」，不是期别——他没有期别
  const week = track === 'WEEKLY' ? await previewWeek(me.id) : null;

  return (
    <>
      {/* ── ① 工作日历：只读 ── */}
      <WorkCalendarPanel viewer={{ code: me.code, name: me.name }} />

      {/* ── ② 我的账号 ── */}
      <div className="section-title">我的账号</div>
      {/* ★ 2026-08-28 去掉外面那层 .card ★ 同 PagedTable 那次：一个 .section-title
          带一块内容，边界已经由标题的竖条 + 下划线 + 上面的模块间距给足了。
          这里的字段格本身就是一个 7 列的栅格，横平竖直，不需要再框一圈。 */}
      <div className="account-fields">
        <Field label="姓名" value={me.name} sub={<span className="mono">简码 {me.code}</span>} />
        <Field label="角色" value={me.role === 'TRAINEE' ? '业务员' : '主管'} />
        <Field
          label="身份"
          value={EMPLOYEE_LABEL[me.employeeType] ?? me.employeeType}
          sub={MODE_LABEL[me.participationMode] ?? me.participationMode}
        />
        {intern ? (
          <Field
            label="期别"
            value={
              <span style={{ color: me.stage === 'ACTIVE' ? 'var(--ok)' : 'var(--warn)' }}>
                {STAGE_LABEL[me.stage]}
              </span>
            }
            sub={
              me.stageOverride
                ? '当前由主管手工设定'
                : me.stage === 'ACTIVE'
                  ? '新询盘分配权正常'
                  : '还没有新询盘分配权'
            }
          />
        ) : week ? (
          /* ★ 2026-08-24：这一格原来直接把 inquiryAccessStatus 的枚举原文
             （NOT_APPLICABLE）渲染在页面上，而且写着「不参加实习准入」——
             对着一个每周要考两场的人说这句话，等于告诉他不用考。
             现在摆他真正的训练要求。 */
          <Field
            label="训练要求"
            value={
              <span style={{ color: week.met === true ? 'var(--ok)' : 'var(--warn)' }}>
                每周至少 {WEEKLY_EXAM_CONFIG.examsPerWeek} 场
              </span>
            }
            sub={
              <>
                本周已考 <span className="num">{week.examCount}</span>/
                {WEEKLY_EXAM_CONFIG.examsPerWeek} 场 · 不影响询盘分配
              </>
            }
          />
        ) : (
          <Field label="训练要求" value="不适用" sub="身份待确认，暂不参加训练" />
        )}
        {/* ★ 2026-08-26 改文案 ★ 原来这里写的是「忘了找主管重置」——
            可业务员本来就能自己改口令（验一遍旧口令即可），
            这句话在教人去麻烦主管，等于把功能藏起来了。
            现在按钮就长在这一格里，点开是弹窗；真忘了旧口令才需要找主管。 */}
        <Field
          label="口令"
          value={row?.passwordHash ? '已设置' : '还没设'}
          sub={
            row?.passwordHash ? (
              <ChangePassword error={pwErr} ok={pwOk} className="link-btn" />
            ) : (
              '第一次登录时你自己设'
            )
          }
        />
        <Field
          label="练了多少"
          value={
            <>
              自由 <span className="num">{drills}</span> 局
            </>
          }
          sub={
            <>
              考试 <span className="num">{row?._count.examAttempts ?? 0}</span> 场 · 成绩看
              <a href="/train">训练台</a>
            </>
          }
        />
        <Field label="最近登录" value={fmt(lastLogin?.at)} sub="登录流水在训练台" />
      </div>

      {/* ── ③ 主管改过我的期别 ── */}
      <div className="section-title">主管改过我的期别</div>
      {overrides.length === 0 ? (
        <EmptyState
          title="没有人手工改过你的期别。"
          hint="它一直是系统按你的考试成绩自动判的——每天结算一次。"
        />
      ) : (
        <PagedTable
          className="team-table"
          head={
            <tr>
              <th>什么时候</th>
              <th>改成什么</th>
              <th>谁改的</th>
              <th>为什么</th>
              <th>从哪天起算</th>
            </tr>
          }
        >
          {overrides.map((item) => (
            <tr key={item.id}>
              <td className="small">{fmt(item.createdAt)}</td>
              <td className="small">
                {item.appliedStatus === 'ACTIVE'
                  ? '在岗期'
                  : item.appliedStatus === 'PAUSED'
                    ? '训练期 · 暂停分新询盘'
                    : '训练期'}
              </td>
              <td className="small muted">{item.operator?.name ?? '系统'}</td>
              <td className="small">{item.reason ?? '—'}</td>
              <td className="small faint">{item.effectiveDay}</td>
            </tr>
          ))}
        </PagedTable>
      )}

      {/* ── ④ 主管动过我账号的什么 ── */}
      <div className="section-title">主管动过我账号的什么</div>
      {audit.length === 0 ? (
        <EmptyState
          title="还没有人动过你的账号。"
          hint="主管改你的角色、身份、期别，或者重置口令时，这里会留一行。"
          icon="users"
        />
      ) : (
        <PagedTable
          className="team-table"
          head={
            <tr>
              <th>什么时候</th>
              <th>谁</th>
              <th>干了什么</th>
              <th>改成什么</th>
            </tr>
          }
        >
          {audit.map((item) => (
            <tr key={item.id}>
              <td className="small">{fmt(item.at)}</td>
              <td className="small muted">{item.actorName}</td>
              <td className="small">
                <b>{AUDIT_LABEL[item.action] ?? item.action}</b>
                {AFFECTS_JUDGEMENT.has(item.action) && (
                  <div className="tiny" style={{ color: 'var(--warn)' }}>影响判定</div>
                )}
              </td>
              <td className="small" style={{ whiteSpace: 'normal' }}>
                {item.before && item.after ? (
                  <>
                    <span className="faint">{item.before}</span>
                    <span className="faint" style={{ margin: '0 6px' }}>→</span>
                    <b>{item.after}</b>
                  </>
                ) : (
                  <b>{item.after ?? item.before ?? '—'}</b>
                )}
                {item.note && <div className="tiny faint">{item.note}</div>}
              </td>
            </tr>
          ))}
        </PagedTable>
      )}
    </>
  );
}
