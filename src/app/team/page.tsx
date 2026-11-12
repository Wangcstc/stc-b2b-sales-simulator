import { Fragment } from 'react';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/db';
import AppShell from '@/components/AppShell';
import { requireUser, canSeeEveryone } from '@/lib/current-user';
import { examTrackOf } from '@/lib/exam-track';
import { businessDay, friendlyStamp, stamp } from '@/lib/business-day';
import { loadLastSeen, loadRoster, STAGE_LABEL } from '@/lib/board';
import {
  catchUpSettlement,
  markDisabledSpanAsLeave,
  restoreAutomaticStage,
  setStageByManager,
} from '@/lib/settlement';
import Help from '@/components/Help';
import PageHelp from '@/components/PageHelp';
import { audit, AUDIT_LABEL, AFFECTS_JUDGEMENT, loadAuditLog } from '@/lib/admin-audit';
import WorkCalendarPanel from './WorkCalendarPanel';
import TraineeTeamView from './TraineeTeamView';
import PagedTable from '@/components/PagedTable';
import EmptyState from '@/components/EmptyState';
import ChangePassword from '@/components/ChangePassword';

export const dynamic = 'force-dynamic';

/**
 * 团队管理，只有主管进得来。
 *
 * ★ 主管不替人设口令 ★
 * 加人只填姓名和简码，口令由本人首次登录时自己设——主管设了也得口头传，
 * 传的路上就漏了，还得记。重置也是同一个道理：重置＝清掉口令，
 * 让本人重新登一次自己设，主管全程不碰任何人的口令。
 */


/* ── 「段位」这一列已于 2026-08-22 从这一页撤掉 ──（王老师问：这跟教练台不是一套逻辑吧）
   问得对，是两套：**段位**＝近 8 局（含自由练手局，只算标准/困难）的中位数换算成 D1–D4；
   **准入判定**＝最近 2 个业务日、6 局考试的中位数 ≥65。窗口、样本、用途全不一样。
   ★ 段位本身没废 ★ 它在版头、首页 KPI、报告页仍然是活的——那回答的是「我练到哪一档」。
   但它不该出现在账号管理这一页：这一页的每一个动作（改角色、改身份、定期别、重置口令、
   停用、删除）都跟段位无关，而它一个 62 分挨着教练台那套 65 分门槛摆着，
   只会被读成「他达标了没」。谁达标没有，去教练台看。 */

/** 「8月21日」。业务日那种 2026-08-21 的写法给人看太硬 */
function dayText(day: string): string {
  const [, month, date] = day.split('-') as [string, string, string];
  if (!month || !date) return day;
  return `${Number(month)}月${Number(date)}日`;
}

/* ★ dayOnly 于 2026-08-28 随「期别」格那三行小字一起删 ★
   「谁哪天被改的」现在只在下面「管理动作流水」那张表里出现，那儿用的是 stamp()。 */

/** 身份代号 → 中文。流水里要写人话，不写 INTERN */
const IDENTITY_LABEL: Record<string, string> = {
  INTERN: '实习业务员',
  REGULAR: '正式业务员',
  MANAGER: '管理员',
  OTHER: '待确认',
};

const ROLE_LABEL: Record<string, string> = {
  TRAINEE: '业务员',
  MANAGER: '主管',
  ADMIN: '管理员',
};

/** 加人失败时把话带回页面上。原来一律静默 return，点了「添加」什么都不发生 */
function addFailed(message: string): never {
  redirect(`/team?addErr=${encodeURIComponent(message)}`);
}

async function addUser(formData: FormData) {
  'use server';
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;

  const name = String(formData.get('name') ?? '').trim();
  const code = String(formData.get('code') ?? '').trim().toUpperCase();
  const employeeType = String(formData.get('employeeType') ?? 'OTHER');
  if (!name) addFailed('姓名不能为空');
  // 简码会长进演习 ID（D-简码-人设-日期-序号），只收字母数字
  if (!/^[A-Z0-9]{1,6}$/.test(code)) addFailed(`简码「${code}」不合法：只收 1–6 位字母或数字`);

  /**
   * ★ 撞码要报错，不能静默改名 ★（2026-08-22）
   * 原来这里是 `upsert({ where:{code}, update:{ name } })`——敲一个已经存在的简码，
   * 会走 update 分支，**把在职同事的名字改掉**，不报错、不提示、身份和期别原样不动。
   * 而简码是全系统最不能改的东西：它长在每一局的演习 ID（D-简码-人设-日期-序号）里，
   * 历史分和标尺校准都挂在上面。所以先查后建，撞了就把话说清楚。
   */
  const existing = await prisma.user.findUnique({
    where: { code },
    select: { name: true, disabledAt: true },
  });
  if (existing) {
    addFailed(
      `简码 ${code} 已经是「${existing.name}」的了${existing.disabledAt ? '（已停用，可在上面的表里恢复）' : ''}——换一个简码。简码会长进演习 ID，不能两个人共用。`,
    );
  }

  await prisma.user.create({
    data: {
      name,
      code,
      role: 'TRAINEE',
      employeeType: employeeType === 'INTERN' ? 'INTERN' : employeeType === 'REGULAR' ? 'REGULAR' : 'OTHER',
      participationMode: employeeType === 'INTERN' ? 'ADMISSION' : employeeType === 'REGULAR' ? 'WEEKLY_EXAM' : 'NONE',
      inquiryAccessStatus: employeeType === 'INTERN' ? 'NOT_ADMITTED' : 'NOT_APPLICABLE',
      identityConfirmedAt: new Date(),
    },
  });
  await audit({
    actorId: me.id,
    action: 'USER_ADD',
    after: `${name}（${code}）· ${IDENTITY_LABEL[employeeType] ?? '待确认'}`,
  });
  revalidatePath('/team');
}

async function updateIdentity(formData: FormData) {
  'use server';
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  const code = String(formData.get('code') ?? '');
  // ★ 和其余七个动作同一道闸 ★（2026-08-22 补）这里过去只查 canSeeEveryone，
  // 于是主管可以把**自己**或**最后一个在用的管理员**改成「待确认」——
  // 不会把人关在门外（role 没动），但会当场把自己的期别与分配权清掉，
  // 而且八个动作里只有它一个不过 guardTarget，口径不一致本身就是个坑。
  if (await guardTarget(code)) return;
  const employeeType = String(formData.get('employeeType') ?? 'OTHER');
  const normalized = employeeType === 'INTERN' ? 'INTERN' : employeeType === 'REGULAR' ? 'REGULAR' : 'OTHER';
  const before = await prisma.user.findUnique({ where: { code } });
  if (!before) return;
  // ★ 主管的身份不由这个表单管 ★（2026-08-23）
  // 「管理员」跟着 Role.MANAGER 自动走（见 setRole），界面上也渲染成只读。
  // 这里再挡一道：既不许把主管改成业务员身份，也不许从这个表单造出一个 MANAGER。
  // 理由是上一次事故的根因——管理员账号被手选成了「正式业务员」，而它的参与模式是「无」，
  // 两个字段从此对不上，check-readiness 报了半个月的「口径错误」。
  // **主管要不要考，是角色决定的事实，不是一个可以选错的选项。**
  if (before.role !== 'TRAINEE' || before.employeeType === 'MANAGER') return;
  const becomesIntern = normalized === 'INTERN' && before.employeeType !== 'INTERN';
  // 在岗期的人要改身份，必须勾过确认框——那一下会把他的分配权收走
  if (before.employeeType === 'INTERN' && before.stage === 'ACTIVE' && normalized !== 'INTERN') {
    if (!formData.get('ack')) return;
  }
  await prisma.user.update({
    where: { code },
    data: {
      employeeType: normalized,
      // ★ 只有身份真的变了才动这个时间 ★（2026-08-22）
      // 它是结算的锚点：「他是哪天成为实习业务员的，从那之后才判他」。
      // 原样保存一次就刷新的话，锚点会挪到今天，他之前所有该判的日子全被跳过。
      ...(normalized !== before.employeeType ? { identityConfirmedAt: new Date() } : {}),
      participationMode: normalized === 'INTERN' ? 'ADMISSION' : normalized === 'REGULAR' ? 'WEEKLY_EXAM' : 'NONE',
      inquiryAccessStatus: normalized === 'INTERN' ? 'NOT_ADMITTED' : 'NOT_APPLICABLE',
      accessSetBy: 'SYSTEM',
      accessSetAt: new Date(),
      accessEffectiveDay: businessDay(),
      overrideUntil: null,
      overrideReason: null,
      // ★ 只有「从非实习变成实习」才初始化期别 ★
      // 原来这里无条件写 stage:'TRAINING'——于是把一个在岗期的人的身份原样保存一次，
      // 他的分配权就没了，界面上没有任何提示。这是个静默的坑，堵掉。
      ...(becomesIntern
        ? { stage: 'TRAINING' as const, stageOverride: false, stageSetBy: 'SYSTEM' as const, stageSetAt: new Date() }
        : {}),
      trainingStartDay: normalized === 'INTERN' ? businessDay() : null,
      // ★ 这里原本还有一行无条件的 identityConfirmedAt: new Date() ★（2026-08-22 删）
      // 它在同一个对象字面量里重复了上面那个条件写入的键，而**后写的赢**——
      // 于是「只有身份真的变了才动锚点」那道防护一行都没生效过。
      // 后果：把一个从没考过试的人的身份原样保存一次，startDayOf 的锚点就挪到今天，
      // 他此前所有该判缺考的日子被整段跳过（settlement.evaluateUserDay 的 day <= startDay 直接 return），
      // 「缺考算不达标」这条规则被一次无意的点击关掉，且界面上没有任何提示。
      // ★ 不要再往这个对象里加第二个 identityConfirmedAt ★
    },
  });
  await audit({
    actorId: me.id,
    subjectId: before.id,
    action: 'IDENTITY_CHANGE',
    before: IDENTITY_LABEL[before.employeeType] ?? before.employeeType,
    after: IDENTITY_LABEL[normalized] ?? normalized,
    note:
      normalized === before.employeeType
        ? '身份没变（原样保存）'
        : becomesIntern
          ? '进准入训练，期别初始化为训练期'
          : '不再走准入，期别与分配权一并清掉',
  });
  revalidatePath('/team');
  revalidatePath('/');
}

/**
 * 人工切换期别（方案第二节，2026-08-22 改规则）。
 *
 * ★ 只管设定当天 ★ 原来是「一旦人工设定，自动判定永远不再改这个人」，
 * 理由是「自动失效等于系统替管理员撤销他自己的决定」。跑下来发现反过来更糟：
 * 主管改完就忘了，人一直锁着，系统算出来该退训练期也不动，而**没人记得去解锁**。
 * 王老师定：主管只对某一天负责，第二天交回系统——他不可能每天盯着。
 * 到期判定见 `overrideStillActive`，到期时由结算当场把标记摘掉。
 */
/**
 * 角色只有两档：业务员 / 管理员（ADMIN 是历史账号，等同管理员，不在界面上发）。
 *
 * ★ 两道守卫沿用 guardTarget ★ 不许动自己、不许动最后一个在用的管理员——
 * 少了任何一条，都可能把所有人关在这一页外面。
 */
async function setRole(formData: FormData) {
  'use server';
  const code = String(formData.get('code') ?? '');
  const requested = String(formData.get('role') ?? '');
  if (requested !== 'TRAINEE' && requested !== 'MANAGER') return;
  const target = await prisma.user.findUnique({ where: { code } });
  if (!target) return;
  // 升权不必过 guardTarget（不会把人关在门外）；降权必须过
  if (requested === 'TRAINEE' && (await guardTarget(code))) return;
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  /**
   * ★ 身份跟着角色走，不再让人手选 ★（2026-08-23 王老师提）
   *
   * 设为主管 → 身份自动「管理员」，参与模式「无」，询盘权限「不适用」；
   * 降回业务员 → 身份退回「待确认」，由主管另行指定实习还是正式。
   *
   * ★ 为什么要联动，而不是加一个选项就算了 ★
   * 加选项解决不了根因。上一次的错是管理员账号被手选成「正式业务员」——
   * 一个只有三个选项、其中「待确认」还兼着「不参加考核」两种意思的下拉框，
   * 选错几乎是必然的。而且主管改不了自己（guardTarget），选错之后连自救都做不到。
   * 现在这件事由角色决定：**改角色的那一下，身份自动对齐，不存在选错的空间。**
   *
   * identityConfirmedAt 只在身份真的变了时才写——它是结算锚点，
   * 原样保存一次就刷新的话，锚点会挪到今天（见 updateIdentity 里那段更长的说明）。
   */
  const nextEmployeeType = requested === 'MANAGER' ? 'MANAGER' : target.employeeType === 'MANAGER' ? 'OTHER' : target.employeeType;
  const identityChanged = nextEmployeeType !== target.employeeType;
  await prisma.user.update({
    where: { code },
    data: {
      role: requested,
      ...(identityChanged
        ? {
            employeeType: nextEmployeeType,
            participationMode: 'NONE' as const,
            inquiryAccessStatus: 'NOT_APPLICABLE' as const,
            identityConfirmedAt: new Date(),
            accessSetBy: 'SYSTEM' as const,
            accessSetAt: new Date(),
            accessEffectiveDay: businessDay(),
            trainingStartDay: null,
            overrideUntil: null,
            overrideReason: null,
          }
        : {}),
    },
  });
  await audit({
    actorId: me.id,
    subjectId: target.id,
    action: 'ROLE_CHANGE',
    before: ROLE_LABEL[target.role] ?? target.role,
    after:
      (ROLE_LABEL[requested] ?? requested) +
      (identityChanged ? `（身份随之改为${IDENTITY_LABEL[nextEmployeeType] ?? nextEmployeeType}）` : ''),
  });
  revalidatePath('/team');
}

async function setStage(formData: FormData) {
  'use server';
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  const code = String(formData.get('code') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const requested = String(formData.get('stage') ?? '');
  if (!reason) return;
  if (requested !== 'TRAINING' && requested !== 'ACTIVE') return;
  await setStageByManager({ code, stage: requested, operatorId: me.id, reason });
  revalidatePath('/team');
  revalidatePath('/');
}

async function restoreAuto(formData: FormData) {
  'use server';
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;
  const code = String(formData.get('code') ?? '');
  await restoreAutomaticStage(code, me.id);
  revalidatePath('/team');
  revalidatePath('/');
}

async function resetPassword(formData: FormData) {
  'use server';
  const me = await requireUser();
  if (!canSeeEveryone(me)) return;

  const code = String(formData.get('code') ?? '');
  // 清掉口令而不是设一个新的：下次登录时本人自己设，主管不经手
  // ★ 同时把令牌版本号 +1 ★（N-9，2026-08-28）不加这一下，那个人手上已经签发的
  // 旧令牌还能再用 30 天——主管以为把人挡住了，其实没有。
  const target = await prisma.user.update({
    where: { code },
    data: { passwordHash: null, tokenVersion: { increment: 1 } },
  });
  await audit({
    actorId: me.id,
    subjectId: target.id,
    action: 'PASSWORD_RESET',
    after: '口令已清空，等本人下次登录时自己设',
  });
  revalidatePath('/team');
}

/**
 * 两道闸门，两个操作都要过。
 *   ① 不许动自己——把自己删了或停了，就再没人能进这一页；
 *   ② 不许动最后一个在用的主管——同上，团队会失去管理入口。
 * 返回 null 表示放行。
 */
async function guardTarget(code: string): Promise<string | null> {
  const me = await requireUser();
  if (!canSeeEveryone(me)) return '没有权限';
  if (code === me.code) return '不能动自己的账号';

  const target = await prisma.user.findUnique({ where: { code } });
  if (!target) return '账号不存在';

  if (target.role !== 'TRAINEE') {
    const liveManagers = await prisma.user.count({
      where: { role: { not: 'TRAINEE' }, disabledAt: null },
    });
    if (liveManagers <= 1) return '这是最后一个在用的主管，动了就没人能管理了';
  }
  return null;
}

/**
 * 停用／恢复。有记录的人只能走这条——台账要留住。
 *
 * ★ 恢复之前先把停用那几天标成「对他不是业务日」★（2026-08-22）
 * 停用期间 catchUpSettlement 直接 return、一行留档都不写——这是对的。
 * 可一旦恢复，disabledAt 变成 null，补算按工作日历往回追 30 个业务日，
 * **把停用那几天全部补判成「缺考、不达标」**，连续 2 天就退回训练期、停发新询盘。
 * 而这一页的说明正教主管「离职走停用，别删」，于是产假、长病假、借调都走这条路——
 * 人回来上班的第一天，先被系统扣一次资格。
 *
 * 顺序不能反：**先写请假、再放开 disabledAt**。反过来的话，中间那一瞬间任何一次
 * 页面渲染都可能触发 catchUpSettlement，把该豁免的日子先判掉。
 */
async function toggleDisabled(formData: FormData) {
  'use server';
  const code = String(formData.get('code') ?? '');
  if (await guardTarget(code)) return;

  const me = await requireUser();
  const u = await prisma.user.findUnique({ where: { code } });
  if (!u) return;
  const backfilled = u.disabledAt ? await markDisabledSpanAsLeave(u.id, u.disabledAt, me.id) : 0;
  await prisma.user.update({
    where: { code },
    // ★ 停用与恢复都把令牌版本号 +1 ★（N-9）停用本来有 getCurrentUser 那条兜底，
    // 但恢复之后旧令牌又会活过来——那是停用期间那个人手上的令牌，不该复活。
    data: { disabledAt: u.disabledAt ? null : new Date(), tokenVersion: { increment: 1 } },
  });
  await audit({
    actorId: me.id,
    subjectId: u.id,
    action: u.disabledAt ? 'USER_ENABLE' : 'USER_DISABLE',
    before: u.disabledAt ? '已停用' : '在用',
    after: u.disabledAt ? '在用' : '已停用',
    note: u.disabledAt
      ? backfilled > 0
        ? `停用期 ${backfilled} 个工作日已标成「停用期」，不会被补判缺考`
        : '停用期内没有需要豁免的工作日'
      : '停用期间不结算、不判定',
  });
  revalidatePath('/team');
}

/**
 * 真删。★ 只对一个局都没开过的账号开放 ★
 * 有局／有考试记录的，数据库那边 Session.userId 与 ExamAttempt.userId 都是 Restrict，
 * 硬删会直接撞外键——这里提前拦住，免得抛一个看不懂的数据库错误给主管。
 */
async function deleteUser(formData: FormData) {
  'use server';
  const code = String(formData.get('code') ?? '');
  if (await guardTarget(code)) return;

  const u = await prisma.user.findUnique({
    where: { code },
    include: { _count: { select: { sessions: true, examAttempts: true } } },
  });
  if (!u) return;
  if (u._count.sessions > 0 || u._count.examAttempts > 0) return; // 有记录只能停用

  // ★ 先记流水再删 ★ 删完就没有 subjectId 可指了（外键是 RESTRICT），
  // 所以这一条不带 subjectId，把人写在 before 里
  const me = await requireUser();
  await audit({
    actorId: me.id,
    action: 'USER_DELETE',
    before: `${u.name}（${u.code}）· ${IDENTITY_LABEL[u.employeeType] ?? u.employeeType}`,
    note: '一局都没开过，允许真删',
  });
  await prisma.user.delete({ where: { code } });
  revalidatePath('/team');
}

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ addErr?: string; pwErr?: string; pwOk?: string }>;
}) {
  const { addErr, pwErr, pwOk } = await searchParams;
  const me = await requireUser();
  /**
   * ★ 同一个 TAB，两套内容 ★（2026-08-22 王老师定）
   * 业务员走只读视图：工作日历（点不动）、我的账号（只有自己）、
   * 主管对我做过的修改。主管那套动作一个都不给——不是把按钮藏起来，
   * 是那些 server action 在 TraineeTeamView 里根本没被 import。
   *
   * ★ 2026-08-24：正式业务员也进这一套只读视图 ★
   * 原来只放行实习业务员，正式业务员一律 404——可他一样有口令要改、
   * 一样会被主管改身份、一样要看工作日历。王老师定：除训练要求外，
   * 其余功能跟实习业务员保持一致。身份待确认的账号仍然 404：这一页对他没有内容。
   */
  if (!canSeeEveryone(me)) {
    if (examTrackOf(me) !== null) {
      return (
        <AppShell current="/team">
          <div className="page-head">
            <h1>账号管理</h1>
            <PageHelp page="team" />
          </div>
          <TraineeTeamView me={me} pwErr={pwErr} pwOk={pwOk} />
        </AppShell>
      );
    }
    notFound();
  }

  const users = await prisma.user.findMany({
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    include: {
      _count: { select: { sessions: true, examAttempts: true } },
      // ★ 只取计数，不拉 sessions 本身 ★（2026-08-26）
      // 原来 include 了每个人的每一局，只为算「N 局有分」和「共开过 N 局」两个显示值；
      // 这两个数当天先后被撤掉（成绩口径不属于这一页，判定与段位都在教练台），
      // 于是这个 include 也跟着去掉——代价本来是每人每局取一行，
      // 本库里两个人就各有 82 / 87 局。
      // ★ _count 不能删 ★「删除」按钮的 clean 判据读的就是它。
      accessDecisions: { where: { manualOverride: false }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const liveManagers = users.filter((u) => u.role !== 'TRAINEE' && !u.disabledAt).length;

  /**
   * ★ 自由局单独数一次 ★（2026-08-27）
   * 上面的 _count.sessions 是这个人名下**所有**的局，考试局也在里面
   * （考试局是 mode=ADMISSION_EXAM / EXAM 的 Session，ExamAttempt.sessionIds 指的就是它们）。
   * 「练了多少」那一列要分开说「自由 N 局 / 考试 N 场」，所以自由局得单独按 mode 数。
   * ★ 用 groupBy 而不是给 _count 加 where ★ 同一个关系没法同时要"带条件"和"不带条件"两个数，
   * 而不带条件的那个不能丢——「删除」按钮的 clean 判据读的就是它（有任何一局都不许真删）。
   * 一次 groupBy 全表扫完，按人分好，不随人数多一个人就多一次查询。
   */
  const drillCounts = await prisma.session.groupBy({
    by: ['userId'],
    where: { mode: 'DRILL' },
    _count: { _all: true },
  });
  const drillOf = new Map(drillCounts.map((r) => [r.userId, r._count._all]));

  // ★ 先补结算再取数 ★ 定时任务漏跑时，主管这一页看到的会是昨天的判定，
  // 而他正要照着这个数字决定今天给谁分询盘。幂等，只处理已经过去的业务日。
  const interns = users.filter(
    (u) => u.employeeType === 'INTERN' && u.participationMode === 'ADMISSION' && !u.disabledAt,
  );
  for (const intern of interns) await catchUpSettlement(intern.id);
  const roster = await loadRoster();
  const rosterOf = new Map(roster.map((row) => [row.code, row]));
  const lastSeen = await loadLastSeen();
  // 人工覆盖历史：谁、什么时候、把谁改成了什么、理由。表里一直在存，过去一条都没显示过。
  const auditLog = await loadAuditLog(60);
  const overrides = await prisma.accessDecision.findMany({
    where: { manualOverride: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
    include: { subject: { select: { name: true, code: true } }, operator: { select: { name: true } } },
  });

  const rows = users.map((u) => {
    const isMe = u.code === me.code;
    // 最后一个在用的主管不能动——动了就没人能进这一页了
    const lastManager = u.role !== 'TRAINEE' && !u.disabledAt && liveManagers <= 1;
    return {
      code: u.code,
      name: u.name,
      role: u.role,
      employeeType: u.employeeType,
      participationMode: u.participationMode,
      inquiryAccessStatus: u.inquiryAccessStatus,
      stage: u.stage,
      /* ★ stageOverride 留着 ★ 它还撑着「今天主管定的」标记和「立刻交回系统」按钮。
         ★ stageSetAt / recommendedStage / overrideReason 于 2026-08-28 摘掉 ★
         它们只喂给那三行已删的小字，留着就是查了没人读的死数据。 */
      stageOverride: u.stageOverride,
      lastSeen: friendlyStamp(lastSeen.get(u.id)),
      userId: u.id,
      hasPassword: u.passwordHash !== null,
      isMe,
      disabled: Boolean(u.disabledAt),
      // 一个局、一次考试都没有的才允许真删；其余只能停用，台账要留住
      total: u._count.sessions,
      // 自由练的局数（历史累计）。考试局不算在里面，两个数各说各的
      drills: drillOf.get(u.id) ?? 0,
      exams: u._count.examAttempts,
      clean: u._count.sessions === 0 && u._count.examAttempts === 0,
      locked: isMe || lastManager,
      lockReason: isMe ? '不能动自己' : lastManager ? '最后一个在用的主管' : '',
    };
  });

  return (
    <AppShell current="/team">
      <div className="page-head">
        <h1>账号管理</h1>
        {/* ★ 页头不再挂「?」，改成「这页怎么用」★（2026-08-27）
            问号是「这个字段什么意思」的手势，一整页的口径不该用它——
            点开是八条带滚动条的文档，没人读得下去。现在写成一个有字的按钮：
            人一看就知道点了会出来一整篇，内容进抽屉（见 components/HelpProvider.tsx）。 */}
        <PageHelp page="team" />
      </div>
      {/* ── 工作日历 ── 排在账号表之前（2026-08-22 王老师定）：
          假期没标，那几天全员判「整天缺考」，底下这张表里的期别就全是错的。
          默认折叠，占一行。 */}
      <WorkCalendarPanel />

      <div className="section-title">
        账号一览
        {/* ★ 这里原来挂着一个装了 8 条口径的「?」★（2026-08-27 拆掉）
            那 8 条是按列排的：角色、身份、期别、口令、练了多少、按钮、锁定规则。
            既然是按列写的，就该待在各自那一列的表头上——而不是攒成一篇
            让人自己在心里对号入座。现在：
              · 完整的 8 条一条没少，在 content/help/team.tsx 里，
                入口是页头那个「这页怎么用」。
            （当天晚些时候又撤掉了一版「每列一句常驻小字」，理由见下面表头处。）*/}
        <span className="sub">
          共 <span className="num">{rows.length}</span> 人
        </span>
      </div>

      <PagedTable
        className="team-table roster"
        /* 列宽按「这一列真正要装多少字」定，不让内容长短去决定间隙。
           序号给固定值（它永远只有一两位数），其余按比例分。 */
        cols={['46px', '13%', '9%', '11%', '17%', '18%', '11%', '21%']}
        head={
          <tr>
            {/* ★ 序号跨页连续 ★ 它是在分页之前、对整份名册算出来的，
                所以翻到第 2 页第一行是 11 不是 1——这才是"第几个人"该有的样子。 */}
            <th className="cell-idx">#</th>
            <th>业务员</th>
            {/* ── 表头只留列名 ──（2026-08-27 晚 王老师定：撤掉那一排常驻小字）
                那排小字是同一天早上加的，本意是「最高频的解释不该藏在问号里」。
                加完再看：六列各挂一句，横着排成一整条灰色注释带，
                比它想解释的六个列名还长——每次阅读都要先跳过它，才看得到第一行数据。
                而这一页已经有「这页怎么用」了：一个有字的按钮，点开是完整的八条口径。
                口径一条没丢，还在 content/help/team.tsx 里，只是不再摊在表头上。 */}
            <th>角色</th>
            <th>身份</th>
            <th>期别</th>
            <th>口令 · 最后登录</th>
            <th className="num-col">练了多少</th>
            <th className="cell-ops">操作</th>
          </tr>
        }
      >
{rows.map((u, i) => (
          <Fragment key={u.code}>
            {/* ── 只读行 ──
                ★ 2026-08-26：这张表从「永远处于编辑态」改成「读为默认，改为按需」★
                改之前每一行都把三个表单摊开摆着（改角色、改身份、改期别＋理由输入框），
                实测 7 个人的表格高 1321px、平均行高 182px、表里 45 个交互控件、
                「改」这两个字出现 16 次，而表宽 942px 已经撑出横向滚动。
                可这三个动作一个月未必用一次——打开这一页九成是来看
                「谁在用、谁没设口令、谁练了多少」。为一个罕见动作牺牲每一次阅读，不划算。

                ★ 用纯 CSS 展开，不引客户端状态 ★ 行尾那个「编辑」是个 <label>，
                配一个视觉隐藏的 checkbox，靠 `tr:has(.row-toggle:checked) + .roster-edit`
                把下面那一行放出来。这样五个 server action 表单原样留在服务端渲染的 DOM 里，
                权限判断一行都不用动——把它们搬进客户端组件才是真正有风险的做法。
                老浏览器不支持 :has() 时编辑行常驻显示，等于退回今天的样子，功能不丢
                （见 globals.css 里那段 @supports）。 */}
            <tr className="roster-row">
              <td className="cell-idx">{i + 1}</td>

              {/* ── 谁 ── 简码挂在名字底下：它会长进每一局的演习 ID，不能不给看 */}
              <td>
                <div className="cell-main">
                  <b style={u.disabled ? { color: 'var(--muted)', textDecoration: 'line-through' } : undefined}>
                    {u.name}
                  </b>
                  {u.isMe && <span className="tiny faint">（你）</span>}
                  {u.disabled && (
                    <span className="chip tiny" style={{ color: 'var(--muted)' }}>已停用</span>
                  )}
                </div>
                <div className="tiny faint mono">{u.code}</div>
              </td>

              {/* ── 角色 ── 两个下拉都收在编辑行里，这里只读 */}
              <td>
                <div className="cell-main">{ROLE_LABEL[u.role] ?? u.role}</div>
              </td>

              {/* ── 身份 ──
                  ★ 2026-08-26 去掉了底下那句参与模式 ★
                  原来这里还有一行小字「在走准入训练 / 在走每周考试 / 暂时不参加训练」。
                  它不是一个独立字段——`updateIdentity` 里参与模式是**跟着身份写死的**
                  （实习→准入训练、正式→每周考试、待确认→不参加），
                  所以它对每一行都只是把上面那个身份换句话再说一遍，七行七句，纯占地方。 */}
              <td>
                <div className="cell-main">{IDENTITY_LABEL[u.employeeType] ?? u.employeeType}</div>
              </td>

              {/* ── 期别 ── 只有实习业务员有 */}
              <td>
                {u.employeeType === 'INTERN' ? (
                  <>
                    {/* ★ 两个数字打架的时候，人要看得见在打架 ★（方案第二节）*/}
                    <div className="cell-main">
                      <b>{STAGE_LABEL[u.stage]}</b>
                      {u.stageOverride && (
                        <span className="tiny" style={{ color: 'var(--warn)' }}>今天主管定的</span>
                      )}
                    </div>
                    {/* ★ 2026-08-28 砍掉这一格里的三行小字 ★（王老师定）
                        原来是：「8月28日 · 理由：第一名」「只管当天，明早结算完自动交回系统」
                        「系统算下来应该是「训练期」」。三行都是**同一件事的注解**——
                        「今天主管定的」这个标记已经把事实说清楚了，谁改的、什么时候改的、
                        写了什么理由，下面「管理动作流水」那张表逐条留着（AUDIT_LABEL）。
                        一张 7 人的表里，每个被改过的人都顶三行小字，表就没法扫了。

                        【留意】「系统算下来应该是 X」原是方案第二节
                        「两个数字打架时人要看得见在打架」那条的落地点，这一删就只剩
                        教练台「今日判定」的『判定』列能看出打架了。要是以后发现主管
                        看不出人工值和系统值不一致，该补的是那一列，不是把这三行加回来。 */}
                    {/* ★ 「立刻交回系统」留在读行，不收进编辑行 ★
                        它是一键动作、没有输入，而且**有时效**：只在今天有人工改期别时出现。
                        把一个限时的动作藏进折叠里，等于让人发现不了它。 */}
                    {u.stageOverride && !u.locked && (
                      <form action={restoreAuto}>
                        <input type="hidden" name="code" value={u.code} />
                        <button className="ghost small" type="submit">立刻交回系统</button>
                      </form>
                    )}
                  </>
                ) : (
                  <>
                    <div className="cell-main faint">不分期别</div>
                    <div className="tiny faint">只有实习业务员走这一套</div>
                  </>
                )}
              </td>

              {/* ── 口令 · 最后登录 ── */}
              <td>
                {u.hasPassword ? (
                  <div className="cell-main">口令已设</div>
                ) : (
                  <div className="cell-main" style={{ color: 'var(--warn)' }}>还没设口令</div>
                )}
                <div className="tiny faint">
                  {u.lastSeen
                    ? '最后登录 ' + u.lastSeen
                    : u.hasPassword
                      ? '没有登录记录 · 8月20日前的没存'
                      : '等本人第一次登录时自己设'}
                </div>
              </td>

              {/* ── 练了多少 ──
                  ★ 这一列有两个用途，都不是成绩 ★
                  ① 这个账号有没有人在用——决定该「停用」还是该「删除」；
                     「删除」只对一局都没开过的账号开放（clean 判的就是这两个数）。
                  ② 主管统计每个账号的历史累计。
                  真要看谁练得怎么样，去教练台——这一页不排段位、不判达标。
                  两个数都取自 _count，不用把每个人的每一局都捞回来。 */}
              <td className="num-col">
                {u.total === 0 && u.exams === 0 ? (
                  <div className="cell-main faint">一局都没开过</div>
                ) : (
                  <>
                    {/* ★ 两个数分开说 ★（2026-08-27）原来第一行是「N 局」，
                        那个 N 把考试局也算进去了，底下又跟一句「考试 N 场」——
                        看的人只能猜这两个数是不是包含关系。现在上面那行写明「自由」：
                        自由局按 mode=DRILL 数，考试按场（一场考试底下有好几局）数，
                        两个都是历史累计，互不重叠。 */}
                    <div className="cell-main">
                      自由 <b className="num">{u.drills}</b> 局
                    </div>
                    <div className="tiny faint">
                      考试 <span className="num">{u.exams}</span> 场
                    </div>
                  </>
                )}
              </td>

              <td className="cell-ops">
                {u.locked ? (
                  <>
                    {/* ★ 「不能动自己」说的是改角色 / 停用 / 删除，不包括改口令 ★
                        改自己的口令一直是允许的（要验旧口令），只是过去藏在 /account。
                        就地开弹窗，不跳锚点——这一页很长，跳下去还得自己滚回来。 */}
                    {u.isMe && <ChangePassword error={pwErr} ok={pwOk} />}
                    <span className="tiny faint">{u.lockReason}</span>
                  </>
                ) : (
                  <>
                    {/* ★ 编辑开关 ★ checkbox 视觉隐藏但仍可聚焦（键盘能用空格切换），
                        label 长成按钮的样子。文案两段，靠 CSS 换：收起时显示「编辑」，
                        展开时显示「收起」——不用 JS 也说得清当前是哪个状态。 */}
                    <input
                      type="checkbox"
                      id={`roster-edit-${u.code}`}
                      className="row-toggle"
                      aria-label={`展开或收起 ${u.name} 的编辑项`}
                    />
                    <label htmlFor={`roster-edit-${u.code}`} className="row-edit-btn">
                      <span className="on-collapsed">编辑</span>
                      <span className="on-expanded">收起</span>
                    </label>

                    {u.hasPassword && !u.disabled && (
                      <form action={resetPassword}>
                        <input type="hidden" name="code" value={u.code} />
                        <button className="ghost small" type="submit">
                          重置口令
                        </button>
                      </form>
                    )}

                    {/* 停用／恢复：有记录的人只有这一条路，账和台账都留着 */}
                    <form action={toggleDisabled}>
                      <input type="hidden" name="code" value={u.code} />
                      <button className="ghost small" type="submit">
                        {u.disabled ? '恢复' : '停用'}
                      </button>
                    </form>

                    {/* 真删只给「干干净净」的账号——多半是简码敲错了刚加完就要撤 */}
                    {u.clean && (
                      <form action={deleteUser}>
                        <input type="hidden" name="code" value={u.code} />
                        <button className="ghost small danger" type="submit">
                          删除
                        </button>
                      </form>
                    )}
                  </>
                )}
              </td>
            </tr>

            {/* ── 编辑行 ── 默认收起；上面那行的 checkbox 勾上才显示 */}
            {!u.locked && (
              <tr className="roster-edit">
                <td colSpan={8}>
                  <div className="edit-panel">
                    <div className="edit-field">
                      <span className="edit-label">角色</span>
                      <form action={setRole} className="cell-form">
                        <input type="hidden" name="code" value={u.code} />
                        <select
                          name="role"
                          defaultValue={u.role === 'TRAINEE' ? 'TRAINEE' : 'MANAGER'}
                          aria-label={u.name + ' 的角色'}
                        >
                          <option value="TRAINEE">业务员</option>
                          <option value="MANAGER">管理员</option>
                        </select>
                        <button className="ghost small" type="submit">保存</button>
                      </form>
                    </div>

                    <div className="edit-field">
                      <span className="edit-label">身份</span>
                      {/* ★ 主管的身份是只读的 ★（2026-08-23）
                          它跟着角色自动走（见 setRole），不给下拉框——
                          上一次事故就是手选选出来的：管理员账号被选成「正式业务员」，
                          而参与模式是「无」，两个字段对不上，判定脚本报了半个月的口径错误。
                          主管改不了自己（guardTarget），选错之后连自救都做不到。 */}
                      {u.role !== 'TRAINEE' ? (
                        <span className="small faint">
                          {IDENTITY_LABEL[u.employeeType] ?? u.employeeType} · 随角色自动设定
                        </span>
                      ) : (
                        <form action={updateIdentity} className="cell-form">
                          <input type="hidden" name="code" value={u.code} />
                          <select name="employeeType" defaultValue={u.employeeType} aria-label={u.name + ' 的身份'}>
                            <option value="OTHER">待确认</option>
                            <option value="INTERN">实习业务员</option>
                            <option value="REGULAR">正式业务员</option>
                          </select>
                          <button className="ghost small" type="submit">保存</button>
                          {/* ★ 在岗期的人改身份＝收走分配权，必须先勾一下 ★ */}
                          {u.employeeType === 'INTERN' && u.stage === 'ACTIVE' && (
                            <label className="tiny cell-ack">
                              <input type="checkbox" name="ack" />
                              我知道这会收走他的分配权
                            </label>
                          )}
                        </form>
                      )}
                    </div>

                    {u.employeeType === 'INTERN' && (
                      <div className="edit-field edit-field-wide">
                        <span className="edit-label">期别</span>
                        <form action={setStage} className="cell-form">
                          <input type="hidden" name="code" value={u.code} />
                          <select name="stage" defaultValue={u.stage} aria-label={u.name + ' 的期别'}>
                            <option value="TRAINING">训练期</option>
                            <option value="ACTIVE">在岗期</option>
                          </select>
                          <input name="reason" placeholder="改成这样的理由" required className="cell-reason" />
                          <button className="ghost small" type="submit">保存</button>
                        </form>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        ))}
      </PagedTable>

      <div className="section-block">
        <div className="section-title">
          加一个业务员
          <Help topic="team-add" />
        </div>
        {addErr && (
          <div className="card" style={{ borderColor: 'var(--bad)', marginBottom: 10 }}>
            <div className="small" style={{ color: 'var(--bad)' }}>
              <b>没有加成</b>
            </div>
            <div className="small" style={{ marginTop: 4, lineHeight: 1.8 }}>{addErr}</div>
          </div>
        )}
        <form action={addUser} className="card signin-add-form" style={{ marginTop: 0 }}>
          <div>
            <label>姓名</label>
            <input name="name" placeholder="张三" required />
          </div>
          <div>
            {/* ★ 第 0 层：能被界面说清的规则，不写进说明 ★（2026-08-27）
                「简码定了别改」原来是「加一个业务员」那个气泡里的第 1 条。
                可它根本不是一条需要人记住的规矩——加完之后系统本来就不给改简码的入口
                （编辑行里 code 一律走 hidden，见下面几处 <input type="hidden" name="code">）。
                规则既然已经被界面强制了，就把这件事**在填的时候当场说一句**，
                比事后写进一篇八条的说明有用得多。 */}
            <label>简码</label>
            <input name="code" placeholder="ZS" maxLength={6} required />
            <span className="field-note">
              1–6 位字母或数字，比如 ZS。定了<b>不能改</b>——它会长进每一局的演习 ID
            </span>
          </div>
          <div>
            <label>身份</label>
            <select name="employeeType" defaultValue="OTHER">
              <option value="OTHER">待确认</option>
              <option value="INTERN">实习业务员</option>
              <option value="REGULAR">正式业务员</option>
            </select>
          </div>
          {/* 空标签占位：让按钮和输入框落在同一水平线上，不受「简码」下面那行小字影响 */}
          <div className="add-form-action">
            <label aria-hidden="true">&nbsp;</label>
            <button className="primary" type="submit">
              添加
            </button>
          </div>
        </form>
      </div>

      {/* ── 人工覆盖历史 ──
          AccessDecision 一直在存操作人、理由、生效日，过去一条都没显示过。
          谁在什么时候把谁的期别改成了什么——这是要能追的。 */}
      <div className="section-block">
        <div className="section-title">
          主管改过的期别
          <span className="sub">谁、什么时候、把谁改成了什么、为什么</span>
        </div>
        {overrides.length === 0 ? (
          <EmptyState
            title="还没有人手工改过期别。"
            hint="一直是系统自己在判：每天结算一次，达标升在岗期、连着不达标退回训练期。你在上面的表里改过谁，这里就会留一行。"
          />
        ) : (
          <PagedTable
            className="team-table"
            head={
              <tr>
                <th>什么时候</th>
                <th>改的是谁</th>
                <th>改成什么</th>
                <th>谁改的</th>
                <th>为什么</th>
                <th>从哪天起算</th>
              </tr>
            }
          >
            {overrides.map((item) => (
              <tr key={item.id}>
                <td className="small">{friendlyStamp(item.createdAt)}</td>
                <td className="small">
                  <b>{item.subject.name}</b> <span className="faint mono tiny">{item.subject.code}</span>
                </td>
                <td className="small">
                  {item.appliedStatus === 'ACTIVE'
                    ? '在岗期'
                    : item.appliedStatus === 'PAUSED'
                      ? '训练期 · 暂停分新询盘'
                      : '训练期'}
                </td>
                <td className="small muted">{item.operator?.name ?? '系统'}</td>
                <td className="small">{item.reason ?? '—'}</td>
                <td className="small faint">{dayText(item.effectiveDay)}</td>
              </tr>
            ))}
          </PagedTable>
        )}
      </div>

      {/* ── 管理动作流水 ──（2026-08-22 新增）
          上面那张「主管改过的期别」只覆盖一个动作。加人、改角色、改身份、重置口令、
          停用、恢复、删除、标假期、标请假、点重算——这十个过去一条记录都没有，
          而其中一半会直接改判定结果。 */}
      <div className="section-block">
        <div className="section-title">
          管理动作流水
          <Help topic="team-audit" />
          <span className="sub">最近 <span className="num">{auditLog.length}</span> 条</span>
        </div>
        {auditLog.length === 0 ? (
          <EmptyState
            title="还没有记录。"
            hint="这张表从 2026-08-22 起才开始记，在那之前的动作补不出来。加人、改身份、停用、重置口令这些动作一发生就会留一行。"
          />
        ) : (
          <PagedTable
            className="team-table"
            head={
              <tr>
                <th>什么时候</th>
                <th>谁</th>
                <th>干了什么</th>
                <th>对谁</th>
                <th>改成什么</th>
              </tr>
            }
          >
            {auditLog.map((item) => (
              <tr key={item.id}>
                <td className="small">{friendlyStamp(item.at)}</td>
                <td className="small muted">{item.actorName}</td>
                <td className="small">
                  <b>{AUDIT_LABEL[item.action] ?? item.action}</b>
                  {AFFECTS_JUDGEMENT.has(item.action) && (
                    <div className="tiny" style={{ color: 'var(--warn)' }}>影响判定</div>
                  )}
                </td>
                <td className="small">
                  {item.subjectName ? (
                    <>
                      <b>{item.subjectName}</b>{' '}
                      <span className="faint mono tiny">{item.subjectCode}</span>
                    </>
                  ) : (
                    <span className="faint">全员</span>
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
      </div>

      {/* ── 「判定阈值 · 只读」已于 2026-08-22 撤销 ──
          它是一整块摆在页面上的规则说明：一个数都不会变、也没有任何可操作的东西，
          却占着和「账号一览」同一级的位置。王老师问「有必要独立成一章吗」——没有。
          整块并进教练台「今日判定」标题旁的「?」里（窗口几局、门槛多少、停用的三条、
          真源文件与「要改找开发」那几句一并搬走）。★ 判定在哪儿看，规则就写在哪儿 ★
          界面上少一块，规则也不再有两处各写一遍、日后对不上的机会。 */}
    </AppShell>
  );
}
