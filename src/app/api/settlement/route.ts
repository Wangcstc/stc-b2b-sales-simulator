import { NextResponse } from 'next/server';
import { businessDay } from '@/lib/business-day';
import { resettleRange, settleAllInterns } from '@/lib/settlement';
import { expireStaleAttempts } from '@/lib/exam-expiry';
import { settleAllRegulars } from '@/lib/weekly-settlement';
import { getCurrentUser, canSeeEveryone, type CurrentUser } from '@/lib/current-user';

/**
 * 每晚结算入口（方案第一节时序：每晚重算 → 次日生效）
 *
 * ★ 定时任务是主路径，但不是唯一路径 ★
 * 首页与账号管理页在渲染前都会调 catchUpSettlement 补一次。
 * 定时任务漏跑一次，判定就晚一天——而晚一天意味着一个该暂停的人
 * 多接一天真实询盘。所以这里宁可算重，不可算漏（幂等，重复跑只更新同一行）。
 *
 * 调用方式：
 *   · 定时任务（vercel.json 的 crons，或服务器 crontab）带 Authorization: Bearer $CRON_SECRET
 *   · 主管在浏览器里手动触发也可以（登录态即可）
 *
 * ★ 两条路，破坏性完全不同 ★（2026-08-22 分开）
 *   · **增量补算**（不带参数）：幂等、只补没算过的日子，GET / POST 都行，随便点
 *   · **重算**（带 from）：**先删后建**，会真的改人的期别与分配权 —— 见下面 requireDestructiveIntent
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Caller = { kind: 'cron' } | { kind: 'user'; user: CurrentUser };

async function authorize(req: Request): Promise<Caller | null> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') === `Bearer ${secret}`) return { kind: 'cron' };
  const user = await getCurrentUser();
  if (user && canSeeEveryone(user)) return { kind: 'user', user };
  return null;
}

/**
 * 重算这条路必须**明确表达意图**才放行。
 *
 * ★ 这里挡的是什么 ★（2026-08-22）原来 GET 和 POST 共用一个 run，于是
 * `GET /api/settlement?from=2026-08-01` 这么一个链接——地址栏手滑、浏览器预取、
 * 别人发来的链接、误点一次历史记录——就能把全员的判定留档删掉重放，
 * 真的改期别与分配权，且没有二次确认、没有任何记录。
 *
 * 现在两道：**必须是 POST**（GET 不许有副作用，这是 HTTP 的老规矩，
 * 也是唯一能挡住预取和误点的一条），**且必须显式带 confirm=yes**。
 * 页面上那个「从 X 起重算」按钮走的是 server action，不经过这里，不受影响。
 */
function requireDestructiveIntent(method: string, url: URL): NextResponse | null {
  if (method !== 'POST') {
    return NextResponse.json(
      {
        error: '重算是破坏性操作（先删后建），不能用 GET 触发',
        how: `POST ${url.pathname}?from=${url.searchParams.get('from')}&confirm=yes`,
        why: 'GET 会被浏览器预取、被链接误点。改期别和分配权这种事，必须是明确按下去的。',
      },
      { status: 405, headers: { Allow: 'POST' } },
    );
  }
  if (url.searchParams.get('confirm') !== 'yes') {
    return NextResponse.json(
      {
        error: '重算需要显式确认',
        how: '在这条 URL 后面加上 &confirm=yes 再发一次',
        why: '这会删掉那一段的判定留档并重放，**期别与分配权会真的跟着改**。',
      },
      { status: 400 },
    );
  }
  return null;
}

async function run(req: Request, method: 'GET' | 'POST') {
  const caller = await authorize(req);
  if (!caller) {
    return NextResponse.json({ error: '没有权限触发结算' }, { status: 401 });
  }

  const url = new URL(req.url);
  const from = url.searchParams.get('from');

  // ★ 改了判定口径或改了工作日历，必须整体重算 ★
  // 留档是按老规则/老日历算的，界面是按新的摆的，两边对不上账。
  if (from) {
    if (!DAY_RE.test(from)) {
      return NextResponse.json({ error: 'from 要写成 2026-08-01 这种业务日' }, { status: 400 });
    }
    if (from >= businessDay()) {
      return NextResponse.json({ error: '只能重算已经过去的业务日' }, { status: 400 });
    }
    const blocked = requireDestructiveIntent(method, url);
    if (blocked) return blocked;

    const who = caller.kind === 'cron' ? '定时任务' : `${caller.user.name}（${caller.user.code}）`;
    const done = await resettleRange(from, { trigger: `${who} 从 ${from} 起重算` });
    return NextResponse.json({
      resettledFrom: from,
      operator: who,
      ...done,
      note: done.truncated
        ? `一次最多重算 ${done.days} 个业务日，已跑到 ${done.through}。**后面还没跑完**，再发一次并把 from 换成 ${done.resumeFrom}。`
        : '这一批留档已按当前口径重算；期别与分配权会真的跟着改。',
    });
  }

  const today = businessDay();

  /**
   * ★ 第一步：把跨天没考完的场次收干净 ★（2026-08-28 加）
   *
   * 王老师 2026-08-28 报的那个洞就在这儿：这趟 cron 原来**完全不看 ExamAttempt**，
   * 只算局和分。「跨天作废」的代码是有的，但只长在 POST /api/exam 里——
   * 不点「开始今天的考试」就永远不触发。于是 08-27 那场一直是「进行中」，
   * 考试记录里三局照样能点「继续/评分」，等于昨天的考试今天接着考。
   *
   * ★ 排在判定前面 ★ 判定读的是局和分，不读这张表，所以先后其实不影响结论；
   * 但「先把昨天收干净，再判昨天」读起来才是一条时间线，
   * 出问题时也好定位——返回体里 staleExams 的数字对不上就是这一步出的事。
   */
  const stale = await expireStaleAttempts({ today });

  const results = await settleAllInterns(today);
  const failed = results.filter((item) => !item.ok);
  /**
   * ★ 正式业务员的周考挂在同一趟 cron 上 ★（2026-08-24）
   * 不加第二个 cron：两件事都是「每晚把账对一遍」，分成两趟只会多一个会漏跑的东西。
   * 每晚都 upsert 最近几周——本周滚动更新，周一那趟顺带把上一周封板成达标/未达标。
   *
   * ★ 它不改任何人的期别 ★ settleAllInterns 会写 User.stage、会停询盘分配；
   * settleAllRegulars 只写 WeeklyExamRecord 一张表，跑失败也动不了任何权限。
   */
  const weekly = await settleAllRegulars(today);
  const weeklyFailed = weekly.filter((item) => !item.ok);
  return NextResponse.json({
    today,
    settled: results.length - failed.length,
    failed,
    weeklySettled: weekly.length - weeklyFailed.length,
    weeklyFailed,
    // 跨天没考完的场次这一趟收了多少：settled=补交卷、expired=判作废
    staleExams: stale,
    note: '结算只处理已经过去的上海业务日；结论在下一个业务日生效。正式业务员的周考只记录，不改任何权限。跨天没考完的场次在这一趟收掉：三局分齐的补交卷，没打完的作废。',
  });
}

export async function GET(req: Request) {
  return run(req, 'GET');
}

export async function POST(req: Request) {
  return run(req, 'POST');
}
