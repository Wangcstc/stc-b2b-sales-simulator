import Link from 'next/link';
import { cookies } from 'next/headers';
import { prisma } from '@/lib/db';
import AppShell, { loadShellStat } from '@/components/AppShell';
import { HomeGuide } from '@/components/Guide';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import { tierSubLabel } from '@/lib/recent-tier';
import IdentityPendingNotice from '@/components/IdentityPendingNotice';
import AdmissionPanel from '@/components/AdmissionPanel';
import WeeklyExamPanel from '@/components/WeeklyExamPanel';
import { examTrackOf } from '@/lib/exam-track';
import { FLAG, InquiryBody, ReceiveButton, buyerLevelText, initials } from '@/components/InquiryRow';
import {
  BUCKET,
  bucketOf,
  personaCoverage,
  personaStats,
  pickTodayQueue,
  queueNonce,
  queueSeed,
  rerollCookieName,
  type InquiryCard,
  type PersonaStat,
  type PlayRecord,
} from '@/lib/inquiry-pool';
import { loadDrillCards, loadMyHistory } from '@/lib/inquiry-data';
import RecentSessions from './RecentSessions';
import Icon from '@/components/Icon';
import { variantDifficulty } from '@/lib/variant-difficulty';
import { businessDay } from '@/lib/business-day';
import { workshopMode } from '@/lib/workshop/mode';
import SampleButton from './workshop/SampleButton';

/** 首页「最近的局」最多列这么多。翻页一页 10 条，够 20 页 */
const RECENT_TAKE = 200;

export const dynamic = 'force-dynamic';

/**
 * 首页 = 模拟询盘
 *
 * ★ 界面越像真实后台，训练迁移越好 ★
 * 新人在真实场景里看到的就是：一个商机进来、一张客户信息页、一段询盘原文。
 * 所以这里不做"选一个练习关卡"，做"几封新询盘等你接待"。
 * 平台数据（买家等级、登录天数、标签、被拉黑数）全部原样摆出来——
 * 那不是装饰，是第一课 7.1「平台数据的读法」要考的东西。
 *
 * ★ 2026-08-23 改：不再平铺全池，改成系统派单 ★
 * 池子扩到 104 封之后，原来那套「按难度三档折叠、一档几十行」彻底失效了：
 * 实测 104 封里只有 17 封被点开过，其余 87 封上线至今零次，
 * 而简单档头 6 行恰好全是同一个骨架 P1——从上往下点三局，练的是同一个考点三遍。
 * 真实工作里业务员也不"挑询盘"，询盘是分给他的。所以首页只留三封，
 * 想自己挑的去 /inquiries（全量题库，按考点分组、可筛可搜）。
 */

/** 今日队列这一格的状态文案。「这个考点碰过没有」比「这一封碰过没有」更要紧 */
function queueStatus(stat: PersonaStat | undefined, record: PlayRecord | undefined) {
  if (!stat || stat.count === 0) return { text: '这个考点你还没练过', fresh: true };
  if (record && record.count > 0) {
    return { text: `这一封练过 ${record.count} 局${record.bestTier ? ` · 最好 ${record.bestTier}` : ''}`, fresh: false };
  }
  return { text: `这个考点练过 ${stat.count} 局，这一封是新的`, fresh: false };
}

function QueueCard({
  card,
  record,
  stat,
  why,
}: {
  card: InquiryCard;
  record: PlayRecord | undefined;
  stat: PersonaStat | undefined;
  /** 今天为什么派这一封。空＝没有特别理由，按覆盖派的 */
  why?: string;
}) {
  const bucket = BUCKET[bucketOf(variantDifficulty(card))];
  const followup = card.persona.sessionType === 'FOLLOWUP';
  const status = queueStatus(stat, record);

  return (
    <div className="card queue-card" style={{ ['--stripe' as string]: bucket.color }}>
      <div className="queue-kind">
        <span>{followup ? '跟进局' : '探需局'}</span>
        <span className="sep">·</span>
        <span style={{ color: bucket.color, letterSpacing: '.05em' }}>{bucket.label}</span>
      </div>

      <div className="queue-who">
        <span className="irow-av">{initials(card.name)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="queue-name">{card.name}</div>
          <div className="tiny muted">
            {FLAG[card.country] ?? ''} {card.company}
          </div>
        </div>
      </div>

      <div className="tiny muted">
        <span className="num">{buyerLevelText(card.buyerLevel)}</span>
        <span className="sep" style={{ margin: '0 6px' }}>
          ·
        </span>
        <span className="num">登录 {card.loginDays} 天</span>
        {card.blacklisted > 0 && (
          <span className="with-ico" style={{ color: 'var(--warn)', marginLeft: 8, gap: 3 }}>
            <Icon name="flag" size={12} />
            {card.blacklisted}
          </span>
        )}
        {card.hasBg && <span style={{ color: 'var(--accent-text)', marginLeft: 8 }}>◈ 背调包</span>}
      </div>

      {/* ★ 这一块是改版的全部理由 ★ 过去列表里只有客户是谁，
          没有一个字说这局考什么——业务员因此没有选题依据，只能点最上面那个 */}
      <div className="queue-point">
        <div className="tiny faint">考点</div>
        <div className="small">
          <b>{card.persona.name}</b>
        </div>
        <div className="tiny muted">考：{card.persona.tests}</div>
      </div>

      <div className="tiny" style={{ color: status.fresh ? 'var(--accent-text)' : 'var(--muted)' }}>
        {status.text}
      </div>

      {/* ★ 派单要说得出理由 ★（2026-08-28 第四批）
          派单从"平均覆盖"换成"弱项 × 间隔重复 × 新鲜度"之后，
          业务员会发现同一个考点隔几天又回来了。不说清楚，那看起来像系统坏了；
          说清楚，它才是"这是给你安排的复习"。 */}
      {why && (
        <div className="tiny" style={{ color: 'var(--accent-text)', marginTop: 4 }}>
          ◇ {why}
        </div>
      )}

      <details className="queue-more">
        <summary>看{followup ? '本局前情' : '询盘原文'}</summary>
        <div>
          <InquiryBody card={card} />
        </div>
      </details>

      <div className="queue-foot">
        <span className="tiny faint mono">{card.variantId}</span>
        <ReceiveButton card={card} className="primary" />
      </div>
    </div>
  );
}

/**
 * ★ 题库为空时的首页 ★（v8.2 起柜子不自带任何题）
 * 主管看到怎么装入题库；业务员看到「题库还没准备好」。不渲染派单、KPI 那一整套——
 * 没有题的时候那些数字全是 0，只会让人以为系统坏了。
 */
function EmptyBank({ manager }: { manager: boolean }) {
  return (
    <AppShell current="/">
      <div className="page-head">
        <h1>模拟询盘</h1>
      </div>
      <div className="card section-block" style={{ padding: '18px 20px' }}>
        <b>还没有题库</b>
        {manager ? (
          <div className="small" style={{ marginTop: 8, lineHeight: 1.8 }}>
            <p style={{ margin: 0 }}>系统装好了，但还没有题目。两条路，先走哪条都行：</p>
            <div className="ws-grid" style={{ marginTop: 10 }}>
              <div className="card">
                <b>① 投递素材，生成自己的题库</b>
                <p style={{ margin: '6px 0' }}>
                  把阿里国际站导出的聊天记录拖进题库工坊，投多少份都行。脱敏在你的浏览器里完成，你只需要回答选择题。
                </p>
                <Link href={workshopMode() === 'full' ? '/workshop/ingest' : '/workshop/bank'}>
                  <button className="primary">去题库工坊</button>
                </Link>
              </div>
              <div className="card">
                <b>② 先装样品题库试玩</b>
                <p style={{ margin: '6px 0' }}>8 道虚构的露营用品题，装上就能打一局、看报告。以后装你们自己的题库时，样品题不会混进去。</p>
                <SampleButton />
              </div>
            </div>
          </div>
        ) : (
          <div className="small" style={{ marginTop: 8 }}>题库还没准备好，请联系主管。</div>
        )}
      </div>
    </AppShell>
  );
}

export default async function Home() {
  const user = await requireUser();

  if ((await prisma.personaVariant.count({ where: { active: true } })) === 0) {
    return <EmptyBank manager={user.employeeType === 'MANAGER' || canSeeEveryone(user)} />;
  }

  const [pool, mine, recent, recentTotal, stat, jar] = await Promise.all([
    loadDrillCards(),
    loadMyHistory(user.id),
    // ★ 只列自己的局 ★ 混着别人的，"继续未聊完的局"会把你送进同事的对话
    // ★ select 不 include ★ 原来是 `include: { variant: { include: { persona: true } } }`，
    // 那会把整行 PersonaVariant（含 hiddenCard、exitLines、quoteReactions）拉进页面，
    // 再被序列化进 HTML——最近练过的那几封，答案就印在网页源码里了。
    // 这一段只用得到人设名字和分数，就只查这些。
    prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      // ★ 6 → 200 ★（2026-08-23 王老师要翻页）一页 10 条，够翻 20 页。
      // 现役业务员最多的也才 87 局，200 是留了很大余量的上限，不是常态截断。
      // 真超了 200，界面上会明写「共 N 局，列出最近 200」——不做无声截断。
      take: RECENT_TAKE,
      select: {
        id: true,
        drillId: true,
        mode: true,
        status: true,
        state: true,
        score: { select: { tier: true, rawScore: true, precise: true } },
        variant: { select: { persona: { select: { name: true } } } },
      },
    }),
    // 真实总数：列表有上限，标题上的数字不能跟着上限走，否则就是无声截断
    prisma.session.count({ where: { userId: user.id } }),
    loadShellStat(user),
    cookies(),
  ]);

  const nonce = queueNonce(jar.get(rerollCookieName())?.value);
  /**
   * ★ 三项加权派单 ★（2026-08-28 第四批）弱项 × 间隔重复 × 新鲜度。
   * 上下文（考点掌握度、最弱的那一力）由 loadMyHistory 一并算出来，不额外查库。
   */
  const queueReasons = new Map<string, string>();
  const queue = pickTodayQueue(
    pool,
    mine.history,
    mine.openedToday,
    queueSeed(user.id, nonce),
    { today: businessDay(), mastery: mine.mastery, weakestForce: mine.weakestForce },
    queueReasons,
  );
  const stats = personaStats(pool, mine.history);
  const cover = personaCoverage(pool, mine.history);

  // 只认「真的聊过」的局。刚创建还没说话的空局（考试一次开 3 局）
  // 不该占这个位置——那不是"未聊完"，是"还没开始"。
  const active = recent.find((s) => s.status === 'ACTIVE' && (s.state as { turn: number }).turn > 0);

  const kpis: [string, string, string | null][] = [
    ['已练局数', String(stat.played), `累计开局 ${stat.sessions} 局`],
    // 段位＝近 8 局中位数，小字里写清样本量——不足 3 局不给段位（见 lib/recent-tier.ts）
    ['演习段位', stat.tier.tier ?? '—', tierSubLabel(stat.tier)],
    // ★ 这一格原来是「待接待询盘 104」★ 和页头「客户库 104 个人设」是同一个数，
    // 说两遍还都没信息量。换成覆盖率之后它才回答一个人真正关心的问题：我还有多少没碰过。
    ['考点覆盖', `${cover.touched}/${cover.total}`, '练手局，不限次数、不计入准入'],
    ['今日考试', stat.examState, '每人每日 1 场（3 局）'],
  ];

  return (
    <AppShell current="/">
      {/* ── 页头 ── */}
      <div className="page-head">
        <h1>模拟询盘</h1>
        {active && (
          <Link href={`/drill/${active.id}`} className="page-head-right">
            <button className="primary">
              继续未聊完的局 · 第 <span className="num">{(active.state as { turn: number }).turn}</span> 轮
            </button>
          </Link>
        )}
      </div>

      {/* ── KPI 条 ── */}
      <div className="kpis section-block">
        {kpis.map(([l, v, sub]) => (
          <div key={l} className="kpi">
            <div className="section-label" style={{ margin: 0 }}>{l}</div>
            <div className="v">{v}</div>
            {sub && <div className="tiny faint" style={{ marginTop: 3 }}>{sub}</div>}
          </div>
        ))}
      </div>

      {/* ★ 一人一张卡，摆的是他自己那套训练要求 ★
          实习业务员 → 准入面板（解锁进度 + 状态条 + 结算横幅）；
          正式业务员 → 周考卡（本周 N/2 场）；
          身份待确认 → 一条提示，让他去找主管确认身份。
          ★ 2026-08-24 校准卡已删 ★（王老师：「没有需要校准的任务，请直接删」）
          ★ 主管这一格空着 ★ 他本来就不参加考试，给他挂一条「请主管把你设成实习/正式业务员」，
          等于让他去找自己确认身份——那不是提示，是噪音。 */}
      {examTrackOf(user) === 'ADMISSION' ? (
        <AdmissionPanel user={user} />
      ) : examTrackOf(user) === 'WEEKLY' ? (
        <WeeklyExamPanel user={user} />
      ) : user.employeeType === 'MANAGER' || canSeeEveryone(user) ? null : (
        <IdentityPendingNotice />
      )}

      {/* ── 新人指引 ── 摆在 KPI 和今日队列之间，它最后一句就是「直接点接待」 */}
      <HomeGuide />

      {/* ── 今日待接待 ── */}
      <div className="section-block">
        <div className="section-title">
          今日待接待
          <span className="sub">
            <span className="num">{queue.length}</span> 封
          </span>
        </div>

        <div className="queue-head">
          <span className="tiny muted">练完一封自动补一封，练手局不限次数</span>
          <span className="spacer" />
          <span className="tiny faint">
            考点覆盖 <span className="num">{cover.touched}</span>/<span className="num">{cover.total}</span>
          </span>
          {nonce === 0 ? (
            <a href="/api/reroll">
              <button className="ghost">换一批（今日剩 1 次）</button>
            </a>
          ) : (
            <button className="ghost" disabled>
              换一批（今日已用完）
            </button>
          )}
        </div>

        {pool.length === 0 ? (
          <div className="muted small">
            还没有人设。先跑 <code className="mono">npm run seed</code>。
          </div>
        ) : queue.length === 0 ? (
          <div className="muted small">
            今天演习池里的封你都开过了。想接着练去 <Link href="/inquiries">全部询盘</Link>。
          </div>
        ) : (
          <>
            <div className="queue-cards">
              {queue.map((v) => (
                <QueueCard
                  key={v.id}
                  card={v}
                  record={mine.history.get(v.id)}
                  stat={stats.get(v.persona.code)}
                  why={queueReasons.get(v.id)}
                />
              ))}
            </div>

            <details className="queue-why" style={{ marginTop: 12 }}>
              <summary>为什么是这三封？</summary>
              <div>
                ① 简单、标准、困难各一封——每天三档都碰一遍，不偏食；
                <br />
                ② 每一档里按三件事排优先级：<b>你在这个考点上分最低的</b>（弱项）、<b>该复习了的</b>
                （练过的考点会按 1／3／7／21／60 天回来，打到 65 分就往后排一档，没到就提前回来）、
                <b>还没碰过的</b>。再从选中的考点里挑一封你没打过的化身——
                <b>复习换化身、不换考点</b>：反复练同一个考点才形成肌肉记忆，换化身才防背题；
                <br />
                ③ 开过的封当天不再出现，所以练完一封会自动补一封新的上来。
                <br />
                <span className="faint">
                  想练指定的考点，去「全部询盘」按考点筛——那边 {pool.length} 封全开放，不受这三封限制。
                </span>
              </div>
            </details>
          </>
        )}

        <div style={{ marginTop: 16, textAlign: 'center' }}>
          <Link href="/inquiries">
            <button>
              全部询盘 <span className="num">{pool.length}</span> 封 · <span className="num">{cover.total}</span> 个考点 →
            </button>
          </Link>
        </div>
      </div>

      {/* ── 最近的局：一行一条，只留有信息量的。翻页在组件里 ── */}
      {recent.length > 0 && (
        <RecentSessions
          total={recentTotal}
          rows={recent.map((s) => ({
            id: s.id,
            drillId: s.drillId,
            mode: s.mode,
            status: s.status,
            personaName: s.variant.persona.name,
            tier: s.score?.tier ?? null,
            rawScore: s.score?.rawScore ?? null,
            precise: s.score?.precise ?? null,
            scored: Boolean(s.score),
          }))}
        />
      )}
    </AppShell>
  );
}
