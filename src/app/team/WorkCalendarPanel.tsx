import { prisma } from '@/lib/db';
import { businessDay } from '@/lib/business-day';
import { loadLedgerAudit } from '@/lib/ledger-audit';
import Help from '@/components/Help';
import CalendarBoard from './CalendarBoard';

/**
 * 工作日历 + 个人请假（2026-08-21，王老师定）
 *
 * ★ 2026-08-22 挪到账号管理页最上面 ★ 王老师定。它是判定的前提——
 * 假期没标，那几天全员被判「整天缺考」，底下那张账号表里的期别就全是错的。
 * 所以它该在人之前被看见；折叠着不占地方，展开才是一屏日历。
 *
 * ★ 解决的是什么 ★ 判定窗口是「判定日 + 前一个业务日」，而业务日此前只跳周六周日。
 * 国庆、春节在代码眼里都是工作日，于是假期里每人每天判「整天缺考」，
 * 假期结束还要再连累两天判不出结论。
 *
 * 这一层只管取数，交互全在 CalendarBoard（客户端）。
 * ★ 两张表都很小 ★ 一年的法定假期加调休不过二三十行，请假也是零星几天，
 * 所以整表捞出来交给前端翻月，不必按月往返查库。
 */
/**
 * @param viewer 业务员自己看时传他的 { code, name }。★ 2026-08-22 王老师定 ★
 *   业务员看得到主管排的班和**他自己**的请假，一个格子都点不动，
 *   也看不到同事请了几天假——那是别人的事。
 */
export default async function WorkCalendarPanel({
  viewer,
}: {
  viewer?: { code: string; name: string };
} = {}) {
  const readOnly = Boolean(viewer);
  const today = businessDay();
  const [marks, leaves, interns, formerly, audit] = await Promise.all([
    prisma.businessCalendar.findMany({ orderBy: { day: 'asc' }, select: { day: true, isWorkday: true } }),
    // ★ 只读模式只捞他自己的请假 ★ 过滤放在查询里，不放在渲染里——
    // 渲染层过滤的话，别人的请假仍然被发到了他的浏览器。
    prisma.leaveDay.findMany({
      where: viewer ? { user: { code: viewer.code } } : undefined,
      orderBy: { day: 'asc' },
      select: { day: true, reason: true, user: { select: { code: true } } },
    }),
    viewer
      ? Promise.resolve([{ name: viewer.name, code: viewer.code }])
      : prisma.user.findMany({
          where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
          orderBy: { createdAt: 'asc' },
          select: { name: true, code: true },
        }),
    /**
     * ★ 有请假记录、但已经不在名单里的人 ★（2026-08-22 补）
     * 请假下拉原来只列「在册实习业务员」，而上面那个 leaves 是**全表**捞的——
     * 已停用的、已转正的人，他们的请假照样画在日历上，却在下拉里选不中，
     * **于是撤不掉**。停用期回填（markDisabledSpanAsLeave）之后这种人只会更多。
     */
    viewer
      ? Promise.resolve([] as Array<{ name: string; code: string; disabledAt: Date | null; employeeType: string }>)
      : prisma.user.findMany({
      where: {
        leaveDays: { some: {} },
        OR: [
          { disabledAt: { not: null } },
          { employeeType: { not: 'INTERN' } },
          { participationMode: { not: 'ADMISSION' } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { name: true, code: true, disabledAt: true, employeeType: true },
    }),
    /**
     * ★ 留档体检 ★（2026-08-22 从「只认一个方向」换成三个方向）
     * 原来这里只算一件事：「这天现在标着放假，库里却还有留档」。
     * 于是另外几种改动全是黑的——标请假、撤请假、撤假期、把周末标成调休上班，
     * 一个都发现不了。尤其是**标了请假之后那天的旧留档还活着**：
     * 台账上被「请假」整行挡住看不见，可连续天数递推、次日横幅、
     * 业务员自己的历史记录都还在读它。
     * 现在改成 lib/ledger-audit.ts 的三向体检，顺带把「中间插过一天导致
     * 连续不达标天数从此全错」这种 catchUpSettlement 自愈不了的情况也查出来。
     */
    readOnly
      ? Promise.resolve({ from: null, dayCount: 0, sampleDays: [] as string[], byReason: { REST_DAY: 0, ON_LEAVE: 0, CHAIN_BROKEN: 0, RULE_CHANGED: 0 } })
      : loadLedgerAudit(),
  ]);

  return (
    <div className="section-block">
      <details className="card section-fold" style={{ padding: '12px 16px' }}>
        <summary>
          工作日历
          <span className="sub">
            放假 <span className="num">{marks.filter((m) => !m.isWorkday).length}</span> 天 · 调休{' '}
            <span className="num">{marks.filter((m) => m.isWorkday).length}</span> 天 ·{' '}
            {readOnly ? '我的请假' : '请假'} <span className="num">{leaves.length}</span> 天
            {audit.dayCount > 0 && (
              <b style={{ color: 'var(--bad)', marginLeft: 8 }}>有 {audit.dayCount} 天留档待重算</b>
            )}
          </span>
        </summary>

        <div style={{ marginTop: 12 }}>
          {/* ★ 只读模式一个字都不写 ★（2026-08-23 王老师定）
              日历本身就说明了哪几天放假、哪几天是他的请假，不需要再解释一遍。 */}
          <div className="small muted" style={{ lineHeight: 1.9, marginBottom: readOnly ? 0 : 12 }}>
            {!readOnly && (
              <>在日历上点日期即可，<b style={{ color: 'var(--text)' }}>点哪天算哪天</b>。</>
            )}
            {!readOnly && (
            <Help topic="team-calendar" label="为什么必须维护它" />
            )}
          </div>

          <CalendarBoard
            readOnly={readOnly}
            today={today}
            marks={marks}
            leaves={leaves.map((item) => ({ code: item.user.code, day: item.day, reason: item.reason }))}
            interns={[
              ...interns.map((p) => ({ name: p.name, code: p.code, note: '' })),
              // 不在册但有请假记录的，排在后面并注明为什么——至少撤得掉
              ...formerly.map((p) => ({
                name: p.name,
                code: p.code,
                note: p.disabledAt ? '已停用' : p.employeeType === 'REGULAR' ? '已转正' : '不参加准入',
              })),
            ]}
            audit={{
              from: audit.from,
              dayCount: audit.dayCount,
              sampleDays: audit.sampleDays,
              byReason: audit.byReason,
            }}
          />
        </div>
      </details>
    </div>
  );
}
