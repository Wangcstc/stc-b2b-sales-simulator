import Link from 'next/link';
import { prisma } from '@/lib/db';
import NavTabs, { type TabItem } from './NavTabs';
import { requireUser, canSeeEveryone, type CurrentUser } from '@/lib/current-user';
import { recentTier, TIER_DIFFICULTIES, type RecentTier } from '@/lib/recent-tier';
import { businessDay } from '@/lib/business-day';
import { ADMISSION_CONFIG, fmt } from '@/lib/admission-v11';
import { countDrillsToday, previewWindow, todayExamState } from '@/lib/settlement';
import ThemeToggle from './ThemeToggle';
import HelpProvider from './HelpProvider';
import { examTrackOf } from '@/lib/exam-track';
import { previewWeek } from '@/lib/weekly-settlement';
import { weekMedianLabel } from '@/lib/weekly-exam';
import Icon from './Icon';
import pkg from '../../package.json';
import { workshopMode } from '@/lib/workshop/mode';
import { pendingCount } from '@/lib/workshop/service';

/**
 * 应用外壳：版头横幅（标题 + 元信息带 + 居中 TAB）+ 居中定宽内容
 *
 * ★ 版头三行，一行一件事 ★
 * ① 标题行：logo + 系统名 + 版本 + 右侧品牌名——"这是谁家的、第几版"（出处署名在页脚，不在这儿）
 * ② 元信息带：一眼看完"这套系统现在装了什么、我练到哪"，管道符分组，
 *    标签灰、数字亮，扫一遍就走，不许在这里做判断
 * ③ TAB 行：单独一条，sticky 到顶——横幅可以滚走，导航不许走
 *
 * 横幅的内层容器与页面内容同宽同 padding，元信息与正文共用一条边界线。
 */

/**
 * TAB 行只放**天天要用**的三件事。
 *
 * ★ 回放调参不在这里 ★（2026-08-06 移走）
 * 它是校准标尺的工具，一个季度未必点一次，却天天占着导航第三格；
 * 更要命的是它把扣分规则摆给被打分的人看。现在收进右上角齿轮，只有主管看得见。
 */
const BASE_NAV: TabItem[] = [{ href: '/', icon: 'inbox', label: '模拟询盘' }];

/**
 * 主管才看得到的 TAB。业务员看见了会去点，点了是 404，不如不显示。
 *
 * ★ 教练台从右上角的图标挪成正式 TAB ★（2026-08-20）
 * 它是主管每天要用的一页——盘谁在练、谁卡住、红线复核、标尺校准都在里面，
 * 藏成一个没有文字的图标，等于让人靠记忆去点。
 *
 * ★ 台账导出不再占一格 TAB ★ 它是一个下载动作，不是一个页面，
 * 而且用它的人和用教练台的是同一个人。现在做成教练台里的一个按钮。
 */
const MANAGER_NAV: TabItem[] = [
  { href: '/replay', icon: 'sliders', label: '教练台' },
  // ★ 题库工坊排在教练台后面 ★（需求文档 5.1）角标是等主管确认的选择题卡数
  { href: '/workshop', icon: 'layers', label: '题库工坊' },
  { href: '/team', icon: 'users', label: '账号管理' },
];

/** 题库工坊角标：等确认的卡数。读的是抽屉工作区的文件，读不到（托管平台、没建过批次）就不显示 */
function workshopBadge(): number {
  try {
    return workshopMode() === 'full' ? pendingCount() : 0;
  } catch {
    return 0;
  }
}

/**
 * 版本号 —— 唯一真源是 package.json，这里只读不写。
 *
 * ★ 显示完整的 主.次.修订 ★（v8.0.0 起）
 * 项目规定每一次修改都要升版本号，修订号也会变；只显示主.次的话，
 * 两个不同的版本在页面上看起来一样，业务员报障时就分不清是哪一版。
 *
 * ★ 写 v8.0.0，不写 v8.0.0版 ★ v 就是 version，后面再加「版」是同一个词说两遍。
 *
 * `npm run check:version` 会核对 package.json、README、CHANGELOG、git 标签与文档里的版本号是否一致。
 */
const VERSION = `v${pkg.version}`;

export interface ShellStat {
  played: number;
  /** ★ 段位是"近 8 局中位数"，不是最近一局 ★ 见 lib/recent-tier.ts */
  tier: RecentTier;
  examState: string;
  inbox: number;
  examOnly: number;
  /** ★ 只数当前这个人的局 ★ 以前数的是全库，多人一进来就是一笔糊涂账 */
  sessions: number;
}

export async function loadShellStat(user: CurrentUser): Promise<ShellStat> {
  // 已练局数：全部局都算，练了就是练了
  const scores = await prisma.score.findMany({
    where: { session: { userId: user.id } },
    orderBy: { createdAt: 'desc' },
    select: { precise: true, rawScore: true },
  });

  // 段位：只算标准局与困难局。rawScore 不含难度系数，简单局计进来等于允许刷分。
  // 见 lib/recent-tier.ts 的 TIER_DIFFICULTIES
  const tierScores = await prisma.score.findMany({
    where: {
      session: {
        userId: user.id,
        /**
         * ★ 难度下沉之后这个筛选要写成两条 ★（2026-08-28）
         * 变体自己声明了档位就以变体为准，没声明才看骨架。
         * 只写 `persona.difficulty` 的话，一个「骨架标准、变体覆盖成困难」的局
         * 会被算进段位（对的），而「骨架困难、变体覆盖成简单」的局也会被算进来（错的）——
         * 后者正是简单局计进段位、允许刷分的那条路。
         * SQL 层没有 COALESCE 可用，只能用 OR 把两种情况都写出来。
         */
        variant: {
          OR: [
            { difficulty: { in: [...TIER_DIFFICULTIES] } },
            { difficulty: null, persona: { difficulty: { in: [...TIER_DIFFICULTIES] } } },
          ],
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    select: { precise: true, rawScore: true },
  });

  // ★ 段位＝近 8 局中位数，不是最近一局 ★（2026-08-14 改，原因见 lib/recent-tier.ts）
  // 原来这里是 `scores.find(s => s.precise)`——取最近一局就当段位。
  // 一个稳定在 55 的人打砸一局 30，页头当场掉到 D1，这不是他的水平。
  const recent = recentTier(
    tierScores.filter((s) => s.precise && s.rawScore !== null).map((s) => s.rawScore as number),
  );
  const today = businessDay();
  const exam = await prisma.examAttempt.findFirst({
    where: { userId: user.id, businessDay: today, attemptType: 'DAILY' },
    orderBy: { createdAt: 'desc' },
  });

  return {
    played: scores.length,
    tier: recent,
    // ★ 看 verdict，不看 passed ★ passed 现在恒为 null（一场考试不再判通过与否），
    // 按它判会在版头写「进行中」，而那场其实已经交卷了。
    // ★ v1.1：判定是最近 6 局的滚动窗口，每晚结算 ★ 这里只说这场考试打到哪一步；
    // 达标与否看首页状态条。原来还有一支「待复核」，随红线人工裁定一起取消（2026-08-24）。
    examState: exam
      ? exam.verdict === null
        ? '进行中'
        : exam.verdict === 'SETTLED'
          ? '已交卷'
          : exam.verdict === 'EXPIRED'
            ? '跨天作废'
            : exam.verdict
      : '未开始',
    inbox: await prisma.personaVariant.count({ where: { poolType: 'DRILL', active: true } }),
    examOnly: await prisma.personaVariant.count({ where: { poolType: 'ADMISSION_EXAM', active: true } }),
    sessions: await prisma.session.count({ where: { userId: user.id } }),
  };
}

/**
 * 版头元信息带的六项。**只放"我现在是谁、今天做到哪"**，不放系统家底。
 *
 * ★ 2026-08-23 王老师定，整条换掉 ★ 原来这里是「客户库 104 个人设 / 已练 N 局 /
 * 累计开局 N / 演习段位 / 询盘权限 / 今日考试」。毛病有三：
 *   ① 「客户库 104」是系统装了多少题，跟看的人今天要做什么没有一点关系；
 *   ② 「已练 0 局 · 累计开局 0」是两个同源的累计数，摆在最显眼的地方却从不驱动任何动作；
 *   ③ 「演习段位」跟着一句「还没有计入段位的局（简单局不计）」，一条带把规则也讲了，
 *      长到一行放不下——换行后管道符甩到行首，像少了半句话。
 * 现在六项全是**当事人自己的、当天会变的**：身份/期别决定他能做什么，
 * 今日演练与今日考试是他今天的进度，考试中位数是判定盯着的那一个数。
 *
 * ★ 段位不在这里了 ★ 它是近 8 局的滚动结论，一天之内几乎不动，
 * 首页 KPI 有一格专门讲它（含样本量与口径），版头不必再说一遍。
 */
export interface HeroMeta {
  /** 主管 / 管理员 / 实习业务员 / 正式业务员 */
  identity: string;
  /** 训练期 / 在岗期。不走准入的人是「不适用」——不能空着，空着会被读成"没查到" */
  stage: string;
  /** 今日有效演习局数。训练期写成 2/3，因为那个 3 是他今天能不能开考的闸 */
  drills: string;
  /** 今日考试：已考 / 进行中 / 未考 / 已作废 */
  exam: string;
  /** 判定窗口（最近 2 天 6 局）的局分中位数，带样本量 */
  examMedian: string;
}

/** 身份一格只回答"你在这套系统里是谁"，角色优先于用工类型——主管不必再标实习/正式 */
function identityLabel(user: CurrentUser): string {
  if (user.role === 'ADMIN') return '管理员';
  if (user.role === 'MANAGER') return '主管';
  if (user.employeeType === 'INTERN') return '实习业务员';
  if (user.employeeType === 'REGULAR') return '正式业务员';
  return '业务员';
}

export async function loadHeroMeta(user: CurrentUser): Promise<HeroMeta> {
  const today = businessDay();
  // ★ 准入那一套只对实习业务员成立 ★ 主管和正式员工照样能练、能开考试局，
  // 所以局数和考试状态对谁都算；只有"期别"是准入独有的，别人写不适用。
  // ★ 2026-08-24：口径按「考试轨」分，不再按身份猜 ★
  const track = examTrackOf(user);
  const admission = track === 'ADMISSION';

  const [drills, exam, window, week] = await Promise.all([
    countDrillsToday(user.id, today),
    todayExamState(user.id, today),
    // ★ 各读各的窗口 ★（2026-08-24）在这之前正式业务员也走 previewWindow，
    // 算出来的是「最近 2 个业务日 6 局」——那是准入的口径，跟他的周考要求不是一回事。
    admission ? previewWindow(user.id, today) : Promise.resolve(null),
    track === 'WEEKLY' ? previewWeek(user.id, today) : Promise.resolve(null),
  ]);

  const W = ADMISSION_CONFIG.windowSessions;
  // 中位数要么给数、要么说清缺多少，不给一个没有出处的裸数字——
  // 样本不齐时它不构成判定，摆出来必须带上这句，否则会被当成"他就这个水平"
  // ★ 分母要写清是哪一套 ★ 准入轨写「近 6 局」，周考轨写「本周 N/6 局」。
  // 两个数长得一模一样，不标口径的话没人分得出这 68 分是按哪套算出来的。
  const examMedian = week
    ? weekMedianLabel(week)
    : window === null
      ? '—'
      : window.medianScore === null
        ? `— · 样本 ${window.preciseCount}/${W} 局`
        : window.enough
          ? `${fmt(window.medianScore)} 分 · 近 ${W} 局`
          : `${fmt(window.medianScore)} 分 · 样本 ${window.preciseCount}/${W} 局`;

  return {
    identity: identityLabel(user),
    stage: admission ? (user.stage === 'ACTIVE' ? '在岗期' : '训练期') : '不适用',
    drills: admission
      ? `${drills.done}/${ADMISSION_CONFIG.dailyDrillMin} 局`
      : `${drills.done} 局`,
    exam,
    examMedian,
  };
}

export default async function AppShell({
  current,
  children,
  narrow,
}: {
  current: string;
  children: React.ReactNode;
  narrow?: boolean;
}) {
  const user = await requireUser();
  const meta = await loadHeroMeta(user);
  const cls = narrow ? 'container narrow' : 'container';
  /**
   * ★ 2026-08-24：正式业务员补齐，两条轨的 TAB 从此一模一样 ★
   * 在这之前 REGULAR 只有「校准任务」一格——考不了试、进不了训练台、
   * 账号管理还 404。王老师定：除训练要求外，其余功能跟实习业务员保持一致。
   *
   * ★ 同日「校准任务」整格删掉 ★（王老师：「没有需要校准的任务，请直接删」）
   * 那套东西从来没被用过：8 条任务全是自动生成的 PENDING，校准局零开局。
   * 留着只会让人分不清「这一局算不算我的考试」。
   * 注意：报告页上主管填判分的**标尺校准**是另一回事，没有动。
   */
  const track = examTrackOf(user);
  const workflowNav: TabItem[] =
    track !== null
      ? [
          { href: '/exam', icon: 'target', label: '考试闸门' },
          // ★ 训练台＝教练台的单人版 ★（2026-08-22 王老师定）业务员没有教练台，
          // 但「今日判定 / 历史台账 / 历史记录 / 登录流水」这四张表他该有自己那一份。
          { href: '/train', icon: 'sliders', label: '训练台' },
          { href: '/team', icon: 'users', label: '账号管理' },
        ]
      : canSeeEveryone(user)
        ? [{ href: '/exam', icon: 'target', label: '考试记录' }]
        : [];
  const nav = [...BASE_NAV, ...workflowNav];

  return (
    <>
      <header className="hero">
        <div className={cls}>
          <div className="hero-top">
            <Link href="/" className="hero-brand">
              <span className="brand-mark" role="img" aria-label="王铖运营社" />
              <span className="hero-name">STC 外贸业务沙盘</span>
              <span className="hero-ver">{VERSION}</span>
            </Link>
            {/* ★ 页头是品牌位 ★ 出处署名不和品牌并排放页头，挪到页脚了 */}
            <div className="hero-credit">王铖运营社</div>
          </div>

          {/* 元信息带：六项**当事人自己的、当天会变的**状态。口径见 loadHeroMeta */}
          {/* ── 元信息带 ──（2026-08-26 分组 + 去死格）
              原来是六格平铺一行，等宽等距，扫过去是一堵墙。两处改动：

              ★ 一、分成「你是谁」和「今天」两组，中间一条竖线 ★
              这六格本来就是两件事：前三格是身份（一天不变），后三格是今天的状态
              （随时在动）。挨着平铺时读不出这层区别，人只能一格一格念过去。

              ★ 二、永远填不出值的格子不再占位 ★
              主管的「期别」恒为"不适用"、「考试中位数」恒为"—"——
              准入窗口和周考窗口对他都不成立（见 loadHeroMeta：两个都返回 null）。
              一个永远说"没有"的格子不是信息，是噪音，而它还占着和真实数字一样的宽度。 */}
          <div className="hero-meta">
            <span className="hero-meta-group">
              <span>
                <i>姓名</i> <b>{user.name}</b>
              </span>
              <span>
                <i>身份</i> <b>{meta.identity}</b>
              </span>
              {/* 期别是准入轨独有的：正式业务员走周考、主管不参加，对他们没有这个概念 */}
              {track === 'ADMISSION' && (
                <span>
                  <i>期别</i> <b>{meta.stage}</b>
                </span>
              )}
            </span>

            <span className="hero-meta-sep" aria-hidden />

            <span className="hero-meta-group">
              <span>
                <i>今日演练</i> <b className="num">{meta.drills}</b>
              </span>
              <span>
                <i>今日考试</i> <b>{meta.exam}</b>
              </span>
              {/* 没有考试轨就没有窗口，中位数算不出来——那一格永远是「—」 */}
              {track !== null && (
                <span>
                  <i>考试中位数</i> <b className="num">{meta.examMedian}</b>
                </span>
              )}
            </span>
          </div>
        </div>
      </header>

      {/* TAB 单独一条，sticky 到顶——横幅可以滚走，导航不许走 */}
      <div className="tabbar">
        <div className={cls}>
          <div className="tabbar-inner">
            {/* ★ 模拟询盘不挂数字徽章 ★（2026-08-07 摘掉）
                徽章的含义是「有 N 件待办等着你处理」，可这里的 17 是客户库总量——
                它不会因为你练完一局就减一，挂着反而像永远清不完的红点。
                真要看这个数，版头元信息带的「客户库 17 个人设」已经写着了。 */}
            <NavTabs
              items={[...nav, ...(canSeeEveryone(user) ? MANAGER_NAV.map((t) => (t.href === '/workshop' ? { ...t, badge: workshopBadge() } : t)) : [])]}
              current={current.startsWith('/workshop') ? '/workshop' : current}
            />

            <div className="tabbar-right">
              {/* ★ 帮助入口只此一个，而且是条真链接 ★（2026-08-27）
                  原来这儿是个 ❓ 弹窗（GuideButton），和页面里那些讲字段的 ? 长得一模一样，
                  点开却是完全不同的东西——一屏六个问号，一半的困惑来自这儿。
                  现在它指向 /help：帮助中心一处收全站说明，
                  各页的「这页怎么用」抽屉读的也是同一份内容（见 content/help/）。
                  排在最前：新人要找它的次数，比找主题切换多得多。 */}
              {/* ★ 图标从 ❓ 换成「书」★ 这是整套方案里最省事、也最见效的一处区分：
                  一个 ? 只该有一个意思。现在全站的手势是——
                    「?」圆点  ＝ 这个字段是什么（就地一句话）
                    「书」图标 ＝ 说明文档（页面抽屉 / 帮助中心）
                  换之前两者长得一模一样，点开却天差地别，人只能靠试。 */}
              <Link href="/help" className="icon-btn" title="帮助中心" aria-label="帮助中心">
                <Icon name="book" size={16} />
              </Link>

              {/* ★ 台账导出：跟在帮助按钮旁边 ★（2026-08-20）
                  它从 TAB 挪进教练台之后，业务员就没有自助导出的入口了——
                  而台账导的本来就是**他自己的局**（接口按身份过滤，主管导全员、业务员只导自己）。
                  放这儿不占导航格，又随时点得到。
                  ★ 必须是 <a download>，不能走 <Link> ★ 这是下载接口不是页面，
                  走路由会被接管、拿不到文件（NavTabs 里那条注释说的就是这件事）。 */}
              <a
                href="/api/ledger"
                download
                className="icon-btn"
                title={canSeeEveryone(user) ? '导出全员演习台账（Excel）' : '导出我的演习台账（Excel）'}
                aria-label="台账导出"
              >
                <Icon name="download" size={16} />
              </a>

              {/* ★ 深浅色切换 ★ 2026-08-14 删、2026-08-25 加回——
                  当时删的理由是深色没有对应色号，换成母版那套色阶之后这个理由不成立了
                  （见 globals.css 里 :root[data-theme='light'] 那段）。
                  位置排在帮助与台账导出后面：它是"设一次就不动"的偏好，
                  不该跟每天要点的两个入口抢左边的位置。 */}
              <ThemeToggle />

              {/* ★ 身份跟着 TAB 一起吸顶 ★ 打了一半才发现记在别人名下，这局就白打了。
                  整块可点——窄屏只剩头像时照样点得动。

                  ★ 2026-08-26：去掉了尾巴上那个「账号」★
                  它指向 /account，而那一页只有三件事：看账号信息、改口令、退出登录。
                  账号信息在账号管理页的「我的账号」里显示得更全（多了身份、训练要求、
                  练了多少、最近登录），另外两件也搬过去了——一个入口、一整页，
                  只为两个动作，其中一个还和别处重复。
                  现在这块直接指向账号管理页，和 TAB 里那一格是同一处，不再有两个"账号"。 */}
              <a href="/team" className="whoami" title="我的账号">
                <span className="whoami-av">{user.code.slice(0, 2)}</span>
                <span className="whoami-main">
                  <b>{user.name}</b>
                  {canSeeEveryone(user) && <span className="whoami-role">主管</span>}
                </span>
              </a>

              {/* ★ 退出回到版头 ★（2026-08-26）
                  它先是跟改口令一起待在账号管理页最下面的那一块里；改口令改成弹窗之后，
                  它不能跟着进去——那是个口令表单，塞一个「走人」进去语义不对。
                  做成一条细链接而不是按钮：和旁边的名字同一档重量，
                  既随手够得到，又不会像个随时会被误触的红色按钮天天杵在那儿。 */}
              <a href="/signout" className="whoami-out" title="退出登录">
                退出
              </a>
            </div>
          </div>
        </div>
      </div>

      {/* ★ 帮助抽屉的宿主 ★（2026-08-27）
          抽屉本身由各页的 <PageHelp page="…" /> 注册、由页内的 <Help topic="…" /> 拉开，
          但它得挂在一个跨页都在的地方，否则每一页都要自己摆一遍。
          这是个客户端组件，包住的 children 仍然是服务端渲染的——
          RSC 允许客户端组件把 server children 原样透传，没有把页面拖进客户端。 */}
      <HelpProvider>
        <div className="page-body">
          <div className={cls}>{children}</div>
        </div>
      </HelpProvider>

      {/* ★ 页脚是出处位 ★
          上行品牌名、下行系统名版本 + 方法论出处。
          方法论确实是王铖运营社的——评分锚点、复盘提问方式、教练口吻都来自那套东西，
          抹掉出处等于把别人的方法算在自己头上。品牌归品牌，出处归出处，两件事分开放。 */}
      <footer className="site-footer">
        <div className="site-footer-brand">
          王铖运营社 <span aria-hidden="true">·</span>{' '}
          <Link href="/cooperation" className="cooperation-link">企业合作</Link>
        </div>
        <div className="site-footer-by">
          STC 外贸业务沙盘 {VERSION} · 教练方法论：王铖运营社业务教练
        </div>
      </footer>
    </>
  );
}
