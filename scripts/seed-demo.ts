/**
 * 演示数据（2026-08-21，王老师要「先看看填满了长什么样」）
 *
 * ═══════════════ 这个脚本最重要的一条 ═══════════════
 * ★ 生成的每一行都要能被精确抹掉 ★
 * 上线时不是「大概清一清」，是**一条不剩**地退回原样，
 * 否则真实数据里会永远混着几局假的，而假的那几局会进判定窗口、
 * 会算进中位数、会决定谁能接询盘——那比没有演示数据糟得多。
 *
 * 三重保险：
 *   ① 清单：每建一行就把 (表, id) 记进 prisma/.demo-manifest.json，
 *      `--clean` 照着清单逐条删，不猜、不模糊匹配。
 *   ② 前缀：所有演习 ID 一律 `DEMO-` 开头（仍满足 schema 的「前缀 D」）。
 *      清单万一丢了，`--clean --force-prefix` 还能照前缀兜底。
 *   ③ 快照：被改动过的真实账号（期别、分配权那几个字段）在清单里存了原值，
 *      清理时逐字段还原，不是「设成默认值」。
 *
 * ═══════════════ 用法 ═══════════════
 *   npm run demo:seed     生成（会先清掉上一批，幂等）
 *   npm run demo:clean    抹掉，账号退回原样
 *   npm run demo:clean -- --force-prefix   清单丢了时按 DEMO- 前缀兜底清
 *
 * ═══════════════ 第二条铁律：只造真系统造得出来的状态 ═══════════════
 * ★ 演示数据必须是真实用户操作能达到的状态 ★
 * 曾经犯过一次（2026-08-21 王老师在台账上圈出来）：
 * 训练期某人当天演习只有 2/3 局、考试根本没解锁，行里却摆着三局考试分数。
 * 病根是这个脚本自己重写了一遍解锁规则——判断用的是「造了几局演习」，
 * 而真系统 `countDrillsToday` 数的是**有效局**（≥6 轮或正常结束），
 * 开了没打的空局一局都不算。造 3 局其中 1 局是空局，脚本以为解锁了，系统眼里只有 2 局。
 *
 * 所以：**凡是有闸门的地方，一律调真函数问，不许在这里重写规则**。
 * 生成完还要跑一遍 assertInvariants()——造出不可能的状态就报错退出，
 * 不许把矛盾数据交到界面上，那会让人对着假象改真需求。
 *
 * ═══════════════ 生成什么 ═══════════════
 * 演习局 / 考试局 / 对话 / 评分 / 考试场次 / 红线复核队列 / 标尺校准 / 登录流水。
 * ★ 每日结算不伪造 ★ 局造完之后跑真的 `catchUpSettlement`——
 * 判定结果由真代码算，看到的中位数、四条、期别变动才是真会发生的那一套。
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { businessDay, recentBusinessDays } from '../src/lib/business-day';
import { ADMISSION_CONFIG, unlockState } from '../src/lib/admission-v11';
// ★ 选题走真函数 ★ 见下面 pickExamSet 那段：一场考试的三局是排死的三个槽位，
// 不是随机三局。这个函数就是真系统 api/exam 用的那套规则的纯函数版。
import { pickExamVariants } from '../src/lib/exam';
import { V3_SCORE_RULE_VERSION } from '../src/lib/training';
import { currentDifficultyFactor } from '../src/lib/difficulty-setting';
import { catchUpSettlement, countDrillsToday } from '../src/lib/settlement';
import { emptyFacts } from '../engine/facts';
import { emptyUnlockState } from '../engine/unlock';
import { initialState } from '../engine/state-machine';
import { toDrillTier } from '../engine/scoring';
import { FORCES } from '../engine/types';
import { addDealFacts, buildDemoReport, COACH_QA, customerLine, demoCtx, traineeLine } from './demo-content';

const prisma = new PrismaClient();

/**
 * 生成后自检：训练期闸门是「当日有效演习 ≥ dailyDrillMin 局才解锁考试」，
 * 所以**任何一个有考试局的日子，当天的有效演习局数都必须达标**。
 *
 * ★ 为什么要有这个函数 ★ 光在生成处调对函数还不够——将来有人为了
 * 「让数据好看点」在别处补几局考试，或者改了 VALID_DRILL_MIN_TURNS，
 * 矛盾会重新出现，而且没人会发现，直到它又被人在界面上圈出来。
 * 这里直接用真函数复算一遍，造出不可能的状态就报错退出。
 */
async function assertNoLockedExamDays(
  users: Array<{ id: string; code: string }>,
  days: string[],
): Promise<void> {
  const bad: string[] = [];
  for (const user of users) {
    for (const day of days) {
      const exams = await prisma.session.count({
        where: {
          userId: user.id,
          mode: 'ADMISSION_EXAM',
          drillId: { startsWith: PREFIX },
          createdAt: {
            gte: new Date(`${day}T00:00:00+08:00`),
            lt: new Date(`${day}T23:59:59+08:00`),
          },
        },
      });
      if (exams === 0) continue;
      const { done } = await countDrillsToday(user.id, day);
      if (done < ADMISSION_CONFIG.dailyDrillMin) {
        bad.push(`${user.code} ${day}：有效演习 ${done}/${ADMISSION_CONFIG.dailyDrillMin} 局，却有 ${exams} 局考试`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(
      ['★ 造出了真系统产生不了的状态 ★ 训练期没解锁却考了试：', ...bad.map((b) => `  · ${b}`)].join('\n'),
    );
  }
  console.log('自检通过：没有「未解锁却考试」的日子');
}

/**
 * 自检二：造出来的考试场次必须满足真系统的不变量。
 *
 * ★ 2026-08-28 加 ★ 王老师那天在库里发现 6 条对不上账的记录（5 条「已交卷却有一局没分」、
 * 1 条「一场只登记了 2 局」），追下来全是这个脚本造的，而**没有任何东西拦住它**。
 * 上面那条 assertNoLockedExamDays 拦的是「未解锁却考试」，同样的手法这里再来一遍。
 *
 * 拦两条不变量，都直接对着真代码的行为写：
 *   ① 一场固定 sessionsPerExam 局 —— `api/exam` 的 POST 在开考瞬间就建满，
 *      少一局是造不出来的（`pickAdmissionVariants` 凑不齐会抛异常）。
 *   ② SETTLED ⇒ 每一局都有 Score 行 —— `settleDailyAttempt` 的守卫写死了这条，
 *      少一局分它就返回 null，根本走不到写 verdict 那一步。
 *
 * ★ 为什么假数据不真实是要报错的事 ★ 它不只是"看着不像"：
 * 这 6 条记录在教练台和考试记录里长得和真记录一模一样，谁去查一个真 bug 都会先被它绊住——
 * 这次就绊了一次。
 */
async function assertExamAttemptsConsistent(): Promise<void> {
  /**
   * ★ 扫全部 DAILY，不只扫这次造的 ★（2026-08-28 当天改）
   * 第一版是 `where: { poolVersion: 'demo' }`——同一天版本号刚改成写真的，
   * 于是这个自检**筛出 0 条、原样通过**，等于没跑。
   * 用「哪个字段标着 demo」来圈范围本来就是错的思路：那个字段是给界面看的，
   * 不是给清理和自检用的（清理靠 DEMO- 前缀与清单，见文件头）。
   *
   * 现在扫全表，并按来源分两档：
   *   · 这一趟造的（在清单里）→ 报错退出，不许把矛盾数据交出去
   *   · 库里原有的            → 只警告。别人真考出来的记录不该由这个脚本判死，
   *                              但也不能默不作声——2026-08-28 就是这么发现 6 条的。
   */
  const mine = new Set(manifest.rows['examAttempt'] ?? []);
  const attempts = await prisma.examAttempt.findMany({
    where: { attemptType: 'DAILY' },
    select: { id: true, businessDay: true, verdict: true, sessionIds: true, user: { select: { code: true } } },
  });
  const bad: string[] = [];
  const warn: string[] = [];
  for (const a of attempts) {
    const who = `${a.user.code} ${a.businessDay}`;
    const sink = mine.has(a.id) ? bad : warn;
    if (a.sessionIds.length !== ADMISSION_CONFIG.sessionsPerExam) {
      sink.push(`${who}：登记了 ${a.sessionIds.length} 局，一场应该是 ${ADMISSION_CONFIG.sessionsPerExam} 局`);
    }
    if (a.verdict === 'SETTLED') {
      const scored = await prisma.score.count({ where: { sessionId: { in: a.sessionIds } } });
      if (scored !== a.sessionIds.length) {
        sink.push(`${who}：已交卷（SETTLED）却只有 ${scored}/${a.sessionIds.length} 局有分`);
      }
    }
  }
  if (warn.length > 0) {
    console.warn(
      ['⚠ 库里原有的考试记录对不上账（不是这一趟造的，不拦生成）：', ...warn.map((w) => `  · ${w}`)].join('\n'),
    );
  }
  if (bad.length > 0) {
    throw new Error(
      ['★ 造出了真系统产生不了的状态 ★ 考试场次对不上账：', ...bad.map((b) => `  · ${b}`)].join('\n'),
    );
  }
  console.log(`自检通过：这一趟造的 ${mine.size} 场（全表 ${attempts.length} 场）局数与交卷状态都对得上`);
}

const MANIFEST = 'prisma/.demo-manifest.json';
const PREFIX = 'DEMO-';

/**
 * 不许出现「还没到的时间」。
 * ★ 2026-11-12 录屏前发现 ★ 今天的考试局写死在 19–21 点，早上跑脚本，界面上就是
 * 「今天 21:44 的考试」——录屏里一眼穿帮。今天的局一律压进「零点 ~ 现在」之间。
 */
const notFuture = (d: Date) => new Date(Math.min(d.getTime(), Date.now() - 60_000));

/** 登录时间：往日 8–20 点随机；今天在「8 点 ~ 现在」之间随机（还不到 8 点就落在零点附近），不堆在同一分钟 */
function loginTime(day: string, today: string): Date {
  const mm = String(between(0, 59)).padStart(2, '0');
  const hh = String(between(8, 20)).padStart(2, '0');
  if (day !== today) return new Date(`${day}T${hh}:${mm}:00+08:00`);
  const from = new Date(`${day}T08:00:00+08:00`).getTime();
  const to = Date.now() - 2 * 60_000;
  if (to <= from) return notFuture(new Date(`${day}T00:${mm}:00+08:00`));
  return new Date(from + rand() * (to - from));
}

/** 开局时间：往日按整点；今天按「当天几点」的比例压进「零点 ~ 现在 − 45 分钟」，保持先后顺序 */
function startTime(day: string, hour: number, today: string): Date {
  const mm = String(between(0, 59)).padStart(2, '0');
  const ss = String(between(0, 59)).padStart(2, '0');
  if (day !== today) return new Date(`${day}T${String(hour).padStart(2, '0')}:${mm}:${ss}+08:00`);
  const dayStart = new Date(`${day}T00:00:00+08:00`).getTime();
  const room = Date.now() - 45 * 60_000 - dayStart; // 留 45 分钟给一局打完
  if (room <= 0) return new Date(dayStart);
  const frac = Math.min(1, Math.max(0, (hour - 9) / 13)); // 演习 9–17 点、考试 19–21 点，整体映射到 0–1
  return new Date(dayStart + frac * room + Number(mm) * 1000);
}

/**
 * 演示用的虚拟业务员（`npm run demo:seed -- --people` 才会建）。
 * ★ 化名，不对应任何真人 ★ 用在录屏、截图、宣传时，让榜单和教练台不至于只有一个人。
 * 建出来的账号记进清单，`demo:clean` 连账号一起删；没设过口令，所以没人能用它们登录。
 * 员工身份一律是「实习业务员 + 参加准入」——脚本只给这种账号造数据。
 */
const DEMO_PEOPLE = [
  { code: 'LILY', name: 'Lily Chen' },
  { code: 'TOM', name: 'Tom Zhao' },
  { code: 'EMMA', name: 'Emma Liu' },
  { code: 'JASON', name: 'Jason Xu' },
  { code: 'SOPHIA', name: 'Sophia Lin' },
  { code: 'KEVIN', name: 'Kevin Wu' },
] as const;
/** 造多少个业务日的数据。15 个业务日≈三周，够把「近 7 天／近 14 天」两档筛选都撑起来 */
const DAYS = 15;

/** 清单结构。删的时候按这里逐条来 */
interface Manifest {
  createdAt: string;
  /** 表名 → 主键 id 列表。删除顺序按 ORDER 走 */
  rows: Record<string, string[]>;
  /** 被改动过的真实账号：原值快照，清理时逐字段还原 */
  users: Array<{
    id: string;
    code: string;
    stage: string;
    stageOverride: boolean;
    stageSetBy: string;
    stageSetAt: string;
    inquiryAccessStatus: string;
    accessSetBy: string;
    accessSetAt: string;
    accessEffectiveDay: string | null;
  }>;
}

/* ────────────────── 可复现的随机 ────────────────── */

/**
 * 定种随机。
 * ★ 不用 Math.random ★ 每跑一次都换一批数，就没法说「昨天那行为什么变了」，
 * 也没法拿同一批数据反复对界面。
 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20260821);
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

/* ────────────────── 假语料 ────────────────── */

const REVIEW_NOTES = [
  '看了原文，他确实只是重复上一封，没有带任何新信息——红线成立。',
  '这句是在确认交期，不是空催。抽取口径把「follow up」当成催单了，判误报。',
  '客户明确说了预算，他还按小单处理，投入明显缩水——成立。',
];

/* ────────────────── 清单读写 ────────────────── */

function loadManifest(): Manifest | null {
  if (!existsSync(MANIFEST)) return null;
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
    // 清空后的清单留在盘上（见 clearManifest 的注释），空的就当没有
    const rows = Object.values(m.rows ?? {}).reduce((a, b) => a + b.length, 0);
    if (rows === 0 && (m.users ?? []).length === 0) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * 清空清单。
 * ★ 是写空，不是删文件 ★ 删文件这个动作在某些运行环境（沙箱、只读挂载）里
 * 会直接把进程打掉，而且是无声的——清理跑到一半就停了，人还以为清干净了。
 * 写一个空清单同样表达「没有演示数据」，且这个动作到处都能做。
 */
function clearManifest() {
  writeFileSync(MANIFEST, JSON.stringify({ createdAt: new Date().toISOString(), rows: {}, users: [] }, null, 2), 'utf8');
}

function saveManifest(m: Manifest) {
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2), 'utf8');
}

/** 删除顺序：先删挂在别人身上的，再删被挂的。反了会撞外键 */
const DELETE_ORDER = [
  'scoreCalibration',
  'redlineReview',
  'score',
  'message',
  'coachQa',
  'examAttempt',
  'dailyEvaluation',
  'accessDecision',
  'loginEvent',
  'session',
] as const;

/* ══════════════════ 清理 ══════════════════ */

async function clean(forcePrefix: boolean) {
  const m = loadManifest();

  if (m) {
    for (const table of DELETE_ORDER) {
      const ids = m.rows[table] ?? [];
      if (ids.length === 0) continue;
      // 分批删，id 太多时一条 IN 会超长
      for (let i = 0; i < ids.length; i += 200) {
        const slice = ids.slice(i, i + 200);
        const deleted = await (prisma[table] as { deleteMany: (a: unknown) => Promise<{ count: number }> }).deleteMany({
          where: { id: { in: slice } },
        });
        void deleted;
      }
      console.log(`  删 ${table} ${ids.length} 行`);
    }

    // ★ 账号逐字段还原 ★ 不是「设回默认值」——他原来可能就是在岗期
    const demoUserIds = new Set(m.rows['user'] ?? []);
    for (const snap of m.users) {
      if (demoUserIds.has(snap.id)) continue; // 这个账号本身就是演示造的，下面整个删掉，不用还原
      await prisma.user.update({
        where: { id: snap.id },
        data: {
          stage: snap.stage as 'TRAINING' | 'ACTIVE',
          stageOverride: snap.stageOverride,
          stageSetBy: snap.stageSetBy as 'SYSTEM' | 'MANAGER',
          stageSetAt: new Date(snap.stageSetAt),
          inquiryAccessStatus: snap.inquiryAccessStatus as 'ACTIVE' | 'PAUSED' | 'NOT_ADMITTED' | 'NOT_APPLICABLE',
          accessSetBy: snap.accessSetBy as 'SYSTEM' | 'MANAGER',
          accessSetAt: new Date(snap.accessSetAt),
          accessEffectiveDay: snap.accessEffectiveDay,
        },
      });
      console.log(`  还原账号 ${snap.code}`);
    }
    // ★ 演示账号最后删 ★ 它们名下的局、分、流水上面已经按清单删完，外键不会拦
    if (demoUserIds.size > 0) {
      const gone = await prisma.user.deleteMany({ where: { id: { in: [...demoUserIds] } } });
      console.log(`  删演示账号 ${gone.count} 个`);
    }
    clearManifest();
    console.log('清单已清空。演示数据抹掉了，账号已退回原样。');
    return;
  }

  if (!forcePrefix) {
    console.log('没有找到清单文件，什么都没做。');
    console.log(`清单丢了的话跑：npm run demo:clean -- --force-prefix（按 ${PREFIX} 前缀兜底清）`);
    return;
  }

  // 兜底：按演习 ID 前缀。级联会带走 message / score / redlineReview / scoreCalibration
  const sessions = await prisma.session.findMany({
    where: { drillId: { startsWith: PREFIX } },
    select: { id: true, userId: true },
  });
  const ids = sessions.map((s) => s.id);
  const userIds = [...new Set(sessions.map((s) => s.userId))];
  console.log(`兜底模式：命中 ${ids.length} 局`);

  await prisma.examAttempt.deleteMany({ where: { userId: { in: userIds }, poolVersion: 'demo' } });
  await prisma.dailyEvaluation.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.accessDecision.deleteMany({ where: { subjectId: { in: userIds }, poolVersion: 'demo' } });
  await prisma.scoreCalibration.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.redlineReview.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.score.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.message.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.session.deleteMany({ where: { id: { in: ids } } });
  // 演示账号靠固定简码 + 没设过口令认（真人账号不会同时满足）
  const ghosts = await prisma.user.deleteMany({
    where: { code: { in: DEMO_PEOPLE.map((p) => p.code) }, passwordHash: null, sessions: { none: {} } },
  });
  if (ghosts.count > 0) console.log(`兜底：删演示账号 ${ghosts.count} 个`);
  console.log('兜底清理完成。★ 账号字段没还原 ★ 期别/分配权要人工到账号管理页确认一遍。');
}

/* ══════════════════ 生成 ══════════════════ */

/**
 * ★ 提到模块级，好让 main() 在异常时也能把它落盘 ★
 * 放在 seed() 里面时，造到一半抛错清单就丢了——库里留着几百行孤儿，
 * 而「能精确抹掉」正是这个脚本的头等要求。
 */
const manifest: Manifest = { createdAt: new Date().toISOString(), rows: {}, users: [] };

async function seed() {
  const note = (table: string, id: string) => {
    (manifest.rows[table] ??= []).push(id);
  };

  if (process.argv.includes('--people')) {
    for (const p of DEMO_PEOPLE) {
      const exists = await prisma.user.findUnique({ where: { code: p.code }, select: { id: true } });
      if (exists) {
        console.log(`  简码 ${p.code} 已被占用，跳过（不覆盖已有账号）`);
        continue;
      }
      const u = await prisma.user.create({
        data: {
          name: p.name,
          code: p.code,
          role: 'TRAINEE',
          employeeType: 'INTERN',
          participationMode: 'ADMISSION',
          inquiryAccessStatus: 'NOT_ADMITTED',
          identityConfirmedAt: new Date(),
        },
      });
      note('user', u.id);
    }
  }

  const interns = await prisma.user.findMany({
    where: { employeeType: 'INTERN', participationMode: 'ADMISSION', disabledAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (interns.length === 0) {
    console.log('库里没有「实习业务员 + 参加准入」的账号，教练台本来就没东西可显示。');
    console.log('先去账号管理把人的员工身份设成「实习业务员」，再跑这个脚本。');
    return;
  }

  const allUsers = await prisma.user.findMany({ where: { disabledAt: null } });
  const manager = allUsers.find((u) => u.role === 'MANAGER') ?? null;

  // 账号原值快照——清理时逐字段还原
  for (const u of interns) {
    manifest.users.push({
      id: u.id,
      code: u.code,
      stage: u.stage,
      stageOverride: u.stageOverride,
      stageSetBy: u.stageSetBy,
      stageSetAt: u.stageSetAt.toISOString(),
      inquiryAccessStatus: u.inquiryAccessStatus,
      accessSetBy: u.accessSetBy,
      accessSetAt: u.accessSetAt.toISOString(),
      accessEffectiveDay: u.accessEffectiveDay,
    });
  }

  const variants = await prisma.personaVariant.findMany({
    where: { active: true },
    include: { persona: true },
  });
  if (variants.length === 0) {
    console.log('库里一个人设都没有。先跑 npm run seed。');
    return;
  }
  const examPool = variants.filter((v) => v.examOnly || v.poolType === 'ADMISSION_EXAM');

  /**
   * 一场考试的三局怎么选。★ 2026-08-28 从「随机三局」改成走真规则 ★
   *
   * 原来是 `pickExam()` 连抽三次，抽到什么算什么。真系统不是这样——
   * `api/exam` 的 `pickAdmissionVariants` 把三局排死在三个槽位上：
   * 探需·标准 ×1 ＋ 探需·困难 ×1 ＋ 跟进 ×1（需求 11.1），
   * 而且同一场里**人设骨架不许重复**。
   *
   * 随机三局造出来的记录，在考试记录页上会显示成「第 1 局 · 探需·困难 / 第 2 局 · 探需·困难 /
   * 第 3 局 · 探需·困难」——一个真系统一次都产生不了的组合。
   * 这违反本文件开头那条铁律：**只造真系统造得出来的状态**。
   *
   * ★ 复用 lib/exam.ts 的 pickExamVariants ★ 那是这套槽位规则的纯函数版
   *（`api/exam` 里那份是带防重复与硬门槛的 DB 版）。在这之前它**只有测试在调**，
   * 生产代码一处都没用——现在演示数据用它，规则就只有一份定义了。
   */
  function pickExamSet(prevSkeletons: Set<string>) {
    // 先把上一场用过的骨架排除掉，剩下的交给真函数排槽位
    const avail = examPool.filter((v) => !prevSkeletons.has(v.persona.code));
    const usable = avail.length >= ADMISSION_CONFIG.sessionsPerExam ? avail : examPool;
    const { picked, shortfalls } = pickExamVariants(
      usable.map((v) => ({ ...v, sessionType: v.persona.sessionType as 'INQUIRY' | 'FOLLOWUP', difficulty: v.persona.difficulty })),
      rand,
    );
    return { picked, shortfalls };
  }
  const drillPool = variants.filter((v) => !v.examOnly && v.poolType !== 'ADMISSION_EXAM');
  /* ★ pickExam 于 2026-08-28 删 ★ 它是「考试局随机抽一个」，而一场考试的三局
     是排死的三个槽位——选题现在走 pickExamSet（下面那个），规则和真系统同一份。 */
  const pickDrill = () => pick(drillPool.length > 0 ? drillPool : variants);

  const days = recentBusinessDays(DAYS).reverse(); // 从旧到新造，序号才顺
  const today = businessDay();
  let seq = 0;

  /** 造一局，连对话带分一起 */
  async function makeSession(opts: {
    user: (typeof interns)[number];
    variant: (typeof variants)[number];
    day: string;
    mode: 'DRILL' | 'ADMISSION_EXAM';
    /** 0 = 开了没打的空局 */
    turns: number;
    rawScore: number | null;
    /**
     * 「评了，但证据不足」——出 Score 行、`precise: false`、`rawScore` 为 null。
     *
     * ★ 和 `rawScore: null` 不是一回事 ★（2026-08-28 加）
     * 这两种状态在判定里走**完全不同**的路：
     *   · 没有 Score 行     → `loadWindowSessions` 的 `score: { isNot: null }` 直接筛掉它，
     *                          判定窗口里那个格子是**空的**，读出来是「缺考」；
     *   · 有 Score 行但不精确 → 进窗口、占住格子（不算缺考），只是不进中位数，
     *                          界面上显示「证据不足」。
     * 下面考试局那个 `insufficient` 要的是后者，原来给的却是前者。
     */
    imprecise?: boolean;
    redlines: string[];
    answerQuality: number | null;
    hour: number;
    /**
     * 这一局按哪套评分口径判的、开局时的难度系数是多少。
     *
     * ★ 2026-08-28 加 ★ 在这之前所有局一律写死 `v2_forces_from_persona`、
     * 难度系数一个都不写。而 `Score.scoreRuleVersion` 的字段注释原话是
     * 「**不同口径的分不可比，别混在一起算中位数**」——演示局挂着 v2 的标签
     * 却和真局一起进同一个判定窗口，正是它警告的那件事。
     * 考试局现在跟真系统一样写 V3_SCORE_RULE_VERSION 与当前难度系数。
     */
    scoreRuleVersion?: string;
    difficultyFactor?: number;
  }) {
    const {
      user, variant, day, mode, turns, rawScore, imprecise = false, redlines, answerQuality, hour,
      scoreRuleVersion = 'v2_forces_from_persona', difficultyFactor,
    } = opts;
    seq += 1;
    const startedAt = startTime(day, hour, today);
    const ended = turns > 0 ? new Date(startedAt.getTime() + between(8, 40) * 60_000) : null;

    const facts = emptyFacts((variant.presetElements ?? []) as string[]);
    facts.redlines = redlines as typeof facts.redlines;
    // 打得越久收得越多，六要素跟着亮几个，报告页才不是一片空白
    const elementKeys = Object.keys(facts.elements);
    for (let i = 0; i < Math.min(elementKeys.length, Math.floor(turns / 1.6)); i += 1) {
      facts.elements[elementKeys[i] as keyof typeof facts.elements] = {
        collected: true,
        source: rand() > 0.75 ? 'volunteered' : 'asked',
        turn: i + 1,
      } as (typeof facts.elements)[keyof typeof facts.elements];
    }

    const ctx = demoCtx(variant);
    addDealFacts(facts, turns, ctx);

    const exitReason = turns > 0 ? pick(['maxTurns', 'patienceZero', null]) : null;
    const drillId = `${PREFIX}${user.code}-${variant.variantId}-${day}-${String(seq).padStart(3, '0')}`;
    const session = await prisma.session.create({
      data: {
        drillId,
        userId: user.id,
        variantId: variant.id,
        type: variant.persona.sessionType,
        mode,
        status: turns > 0 ? 'ENDED' : 'ACTIVE',
        exitReason,
        state: { ...initialState(70), turn: turns } as unknown as Prisma.InputJsonObject,
        unlockState: emptyUnlockState() as unknown as Prisma.InputJsonObject,
        facts: facts as unknown as Prisma.InputJsonObject,
        // 真系统一场考试的 3 局共用一个系数（见 api/exam 那段注释），这里照办
        ...(difficultyFactor === undefined ? {} : { difficultyFactor }),
        createdAt: startedAt,
        endedAt: ended,
      },
    });
    note('session', session.id);

    // 对话：一轮业务员一轮客户。复盘页与报告页都要读它
    for (let t = 1; t <= turns; t += 1) {
      const at = new Date(startedAt.getTime() + t * 90_000);
      const mine = await prisma.message.create({
        data: {
          sessionId: session.id,
          turn: t,
          role: 'trainee',
          content: traineeLine(t, ctx),
          createdAt: at,
        },
      });
      note('message', mine.id);
      const theirs = await prisma.message.create({
        data: {
          sessionId: session.id,
          turn: t,
          role: 'customer',
          content: customerLine(t, ctx),
          createdAt: new Date(at.getTime() + 30_000),
        },
      });
      note('message', theirs.id);
    }

    // 评分。rawScore=null 且 !imprecise 表示「已结束·未评分」，流水里要有这种行才真实
    if (turns > 0 && (rawScore !== null || imprecise)) {
      const forceScores = {} as Record<(typeof FORCES)[number], number>;
      for (const f of FORCES) {
        // 局分高的人各力也高，别出现「17 分但七力全 5」这种自相矛盾的行
        // 证据不足那一档没有局分，七力给低位——它本来就是「看不出来」
        const base = rawScore === null ? 1 : Math.round(rawScore / 22);
        forceScores[f] = Math.max(1, Math.min(5, base + between(-1, 1)));
      }
      const progress = between(0, 2) as 0 | 1 | 2;
      const coverage = Math.min(1, turns / 12);
      // 报告正文走真的 buildReport（见 demo-content.ts），七力证据引用的是这一局真实出现过的原话
      const { reportMd, forces } = buildDemoReport({
        drillId,
        turns,
        difficulty: variant.persona.difficulty,
        followup: variant.persona.sessionType === 'FOLLOWUP',
        ctx,
        exitReason,
        facts,
        forceScores,
        rawScore,
        tier: rawScore === null ? undefined : toDrillTier(rawScore),
        coverage,
        progress,
        answerQuality: answerQuality as 0 | 1 | 2 | null,
        imprecise,
        difficultyFactor,
        coachQa: answerQuality !== null,
      });
      if (answerQuality !== null) {
        for (const [idx, qa] of COACH_QA.entries()) {
          const row = await prisma.coachQa.create({
            data: { sessionId: session.id, idx, question: qa.question, answer: qa.answer, createdAt: ended ?? startedAt },
          });
          note('coachQa', row.id);
        }
      }
      const created = await prisma.score.create({
        data: {
          sessionId: session.id,
          forces: forces as unknown as Prisma.InputJsonObject,
          coverage,
          evaluableCount: FORCES.length,
          precise: !imprecise,
          rawScore,
          tier: rawScore === null ? null : toDrillTier(rawScore),
          progress,
          answerQuality,
          flags: [] as unknown as Prisma.InputJsonObject,
          reportMd,
          scoreRuleVersion,
          createdAt: ended ?? startedAt,
        },
      });
      note('score', created.id);
    }

    return session;
  }

  console.log(`造 ${days.length} 个业务日 × ${interns.length} 人…`);

  const examSessionsByUserDay = new Map<string, string[]>();
  /** 每人上一场用过的人设骨架。真系统禁止两场连着出同一个骨架，这里照办 */
  const prevSkeletons = new Map<string, Set<string>>();
  /** 一场考试的 3 局共用一个系数，和真系统一样在建局前读一次 */
  const demoDifficultyFactor = await currentDifficultyFactor();

  for (const [dayIndex, day] of days.entries()) {
    for (const [i, user] of interns.entries()) {
      // 每个人一条自己的成长曲线：一个稳步上升、一个卡在 65 边上、一个起伏
      const trend = [dayIndex * 1.1, dayIndex * 0.35, Math.sin(dayIndex / 2) * 6][i % 3]!;
      const floor = [52, 58, 60][i % 3]!;
      const skipDay = rand() < 0.1; // 有人某天没来

      // ── 演习局：训练期每天要 ≥3 局。多数日子练够，少数日子没练够——
      //    「演习差 N 局」那条文案要有机会出现，但不能天天出现，否则窗口永远填不满
      const drills = skipDay ? 0 : rand() < 0.2 ? between(0, 2) : between(3, 5);
      for (let d = 0; d < drills; d += 1) {
        const empty = rand() < 0.25; // 开了没打就走的空局，流水里的「隐藏 0 轮空局」要有东西可藏
        await makeSession({
          user,
          variant: pickDrill(),
          day,
          mode: 'DRILL',
          turns: empty ? 0 : between(6, 16),
          rawScore: empty ? null : Math.max(10, Math.min(95, Math.round(floor + trend + between(-8, 10)))),
          redlines: rand() < 0.14 ? [pick(['R1', 'R2', 'R3'])] : [],
          answerQuality: empty ? null : between(0, 2),
          hour: between(9, 17),
        });
      }

      // ── 考试局：练够 3 局才解锁；一场 3 局 ──
      // ★ 不许在这儿重写解锁规则 ★ 问真函数：它数的是**有效局**
      //（≥VALID_DRILL_MIN_TURNS 轮，或正常结束），开了没打的空局不算。
      // 上面那个 `drills` 是「造了几局」，含空局，拿它当闸门会造出
      // 「演习 2/3 局却有三局考试分」这种真系统产生不了的行。
      const unlocked = unlockState((await countDrillsToday(user.id, day)).done, 'TRAINING').unlocked;
      /**
       * ★ 这一天他本来就有一场考试的话，一局都不许再造 ★（2026-08-28 加）
       *
       * 「每人每天 1 场」是这套系统最硬的一条规则，DB 上有
       * `@@unique([userId, businessDay, attemptType])` 兜着。
       * 在这之前这个脚本从来不查——只要哪个账号被设成实习业务员、
       * 而他名下已经有真实考试记录，跑到那一天就会撞唯一键、整个脚本中断。
       * 2026-08-28 第一次跑就撞了：王老师那天刚被设成实习业务员，
       * 他 08-27 有一场自己真考的。
       *
       * ★ 查在建局之前，不是建完再兜 ★ 建完再撞的话，那三局考试局已经落库了，
       * 而它们的考试场次没建成——那正是「真系统造不出来的状态」：
       * 一堆没有归属的考试局，照样会被判定窗口捞进去算中位数。
       */
      const existingAttempt = await prisma.examAttempt.findFirst({
        where: { userId: user.id, businessDay: day, attemptType: 'DAILY' },
        select: { id: true },
      });
      if (existingAttempt) {
        console.log(`  跳过 ${user.code} ${day}：这一天他已经有一场真实考试，每人每天只能有 1 场`);
      }
      if (!skipDay && unlocked && !existingAttempt) {
        const ids: string[] = [];
        const scores: number[] = [];
        // ★ 今天留一个人考到一半 ★ 「进行中 / 考试差 N 局」这两种状态要有**真样本**：
        // 三局只打了两局。原来是把今天那场的 verdict 写成 null 来伪造「进行中」，
        // 而 2026-08-21 起考试状态改成数已出分的局、不读 verdict，那种伪造就失效了——
        // 何况它本来就造出了「三局分都在、却说没打完」这种自相矛盾的行。
        const inProgress = day === today && i === interns.length - 1;
        // ★ 三个槽位由真函数排：探需·标准 / 探需·困难 / 跟进 ★ 不再连抽三次
        const { picked, shortfalls } = pickExamSet(prevSkeletons.get(user.id) ?? new Set());
        if (shortfalls.length > 0) {
          throw new Error(
            [
              `★ 考试池凑不齐三个槽位 ★ ${user.code} ${day}：`,
              ...shortfalls.map((t) => `  · ${t}`),
              '演示数据不许降级凑数——降了级就不是真系统造得出来的组合了。先补考试池：npm run seed。',
            ].join('\n'),
          );
        }
        prevSkeletons.set(user.id, new Set(picked.map((v) => v.persona.code)));
        /**
         * ★ 三局一律全建，「考到一半」靠不打第三局表达 ★（2026-08-28 修）
         *
         * 原来是 `k < (inProgress ? 2 : 3)`——考到一半的那场**只建 2 局**，
         * sessionIds 里也就只有 2 个。真系统不是这样：`api/exam` 的 POST 在
         * 开考瞬间就把 3 局全建好（「可以关掉浏览器分次打，当天回来接着打」），
         * 没打的那局是一条 turns=0 的 ACTIVE 记录，照样在 sessionIds 里。
         *
         * 这个差别不是"看起来像不像"的问题，它会让真代码判错：
         * `settleDailyAttempt` 的守卫是
         *   `sessions.length !== attempt.sessionIds.length || sessions.some(s => !s.score)`
         * ——2 局的场次刚好两条都满足，于是它被**当成一场完整的考试收掉**，
         * 结论文案写「今日 3 局已交卷」，而库里只有 2 局。
         * 库里 2026-08-21 小许那条就是这么来的（medianScore 是两局算的）。
         */
        for (let k = 0; k < 3; k += 1) {
          // 考到一半：前两局打完，第三局只是被建出来，一轮没聊
          const notStarted = inProgress && k === 2;
          const raw = Math.max(15, Math.min(95, Math.round(floor + trend + between(-7, 9))));
          // 偶尔来一局「证据不足」，样本/精确局那两条提示才有机会露面
          const insufficient = !notStarted && rand() < 0.08;
          const s = await makeSession({
            user,
            variant: picked[k]!,
            day,
            mode: 'ADMISSION_EXAM',
            turns: notStarted ? 0 : between(8, 18),
            rawScore: insufficient || notStarted ? null : raw,
            // ★ 证据不足要出 Score 行 ★ 不出的话它在判定窗口里等于缺考，见 makeSession 的 imprecise
            imprecise: insufficient,
            redlines: rand() < 0.2 ? [pick(['R2', 'R3'])] : [],
            answerQuality: notStarted ? null : between(0, 2),
            hour: 19 + k,
            // 考试局和真系统同口径：同一套评分规则版本、同一场共用一个难度系数
            scoreRuleVersion: V3_SCORE_RULE_VERSION,
            difficultyFactor: demoDifficultyFactor,
          });
          ids.push(s.id);
          if (!insufficient && !notStarted) scores.push(raw);
        }
        examSessionsByUserDay.set(`${user.id}|${day}`, ids);

        const sorted = [...scores].sort((a, b) => a - b);
        const med = sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : Math.round((sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2);
        const attempt = await prisma.examAttempt.create({
          data: {
            userId: user.id,
            day,
            businessDay: day,
            attemptType: 'DAILY',
            sessionIds: ids,
            medianScore: med,
            // 打满 3 局就自动交卷（真系统在评完最后一局时做这件事）；考到一半那场留 null
            verdict: inProgress ? null : 'SETTLED',
            /**
             * ★ 版本号写真的 ★（2026-08-28）原来是 poolVersion: 'demo' +
             * scoreRuleVersion: 'v2_forces_from_persona'。考试记录页上每一场都印着
             * 「题池 X · 评分 Y」，演示场次印出来和真场次是两套号——而它们进的是
             * **同一个判定窗口、一起算中位数**。`Score.scoreRuleVersion` 的字段注释
             * 原话就是「不同口径的分不可比，别混在一起算中位数」。
             * ★ 那还怎么认出演示数据 ★ 靠 drillId 的 DEMO- 前缀和清单，
             * 那两样才是清理时真正用得上的，版本号从来不是。
             */
            poolVersion: picked[0]?.poolVersion ?? 'demo',
            scoreRuleVersion: V3_SCORE_RULE_VERSION,
            createdAt: notFuture(new Date(`${day}T19:30:00+08:00`)),
          },
        });
        note('examAttempt', attempt.id);
      }
    }
  }

  // ── 自检：不许有「没解锁却考了」的日子 ──
  await assertNoLockedExamDays(interns, days);
  await assertExamAttemptsConsistent();

  // ── 红线复核队列：只收考试局。留几条待裁、几条已裁 ──
  const flagged = await prisma.session.findMany({
    where: { drillId: { startsWith: PREFIX }, mode: 'ADMISSION_EXAM' },
    include: { messages: { where: { role: 'trainee' }, take: 1 } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  let pendingMade = 0;
  let ruledMade = 0;
  for (const s of flagged) {
    const codes = ((s.facts as { redlines?: string[] }).redlines ?? []).filter((c) => c === 'R2' || c === 'R3');
    for (const code of codes) {
      const settle = pendingMade >= 6; // 前 6 条留着待裁，剩下的直接判掉
      const review = await prisma.redlineReview.create({
        data: {
          sessionId: s.id,
          redline: code,
          status: settle ? pick(['CONFIRMED', 'DISMISSED']) : 'PENDING',
          evidence: {
            turn: between(3, 9),
            quote: s.messages[0]?.content ?? 'Hi, thank you for your inquiry!',
            drillId: s.drillId,
            personaName: '演示人设',
          } as Prisma.InputJsonObject,
          reviewedById: settle && manager ? manager.id : null,
          reviewedAt: settle ? notFuture(new Date(s.createdAt.getTime() + 86_400_000)) : null,
          note: settle ? pick(REVIEW_NOTES) : null,
          createdAt: s.createdAt,
        },
      });
      note('redlineReview', review.id);
      if (settle) ruledMade += 1;
      else pendingMade += 1;
    }
  }

  // ── 标尺校准：主管对着几局自己判一遍，Gate 0／Gate 4 那两个数才长得出来 ──
  const scored = await prisma.session.findMany({
    where: { drillId: { startsWith: PREFIX }, score: { isNot: null } },
    include: { score: true },
    orderBy: { createdAt: 'desc' },
    take: 12,
  });
  for (const s of scored) {
    const sysTier = s.score!.tier ?? 'D3';
    // 八成判得一样，两成差一档——差异率才不会是 100% 那种假数据
    const humanTier = rand() < 0.8 ? sysTier : `D${Math.max(1, Math.min(5, Number(sysTier.slice(1)) + (rand() < 0.5 ? -1 : 1)))}`;
    const forces: Record<string, unknown> = {};
    for (const f of FORCES.slice(0, 5)) {
      const sys = between(2, 5);
      const gap = rand() < 0.8 ? between(-1, 1) : between(-2, 2);
      const human = Math.max(1, Math.min(5, sys + gap));
      forces[f] = {
        system: String(sys),
        human: String(human),
        cause: Math.abs(sys - human) >= 2 ? pick(['anchor', 'evidence', 'facts', 'not_applicable']) : null,
      };
    }
    const calib = await prisma.scoreCalibration.create({
      data: {
        sessionId: s.id,
        systemTier: sysTier,
        humanTier,
        forces: forces as Prisma.InputJsonObject,
        note: '演示数据',
        createdAt: notFuture(new Date(s.createdAt.getTime() + 3_600_000)),
      },
    });
    note('scoreCalibration', calib.id);
  }

  // ── 登录流水：所有在用账号，每个业务日随机登一两次 ──
  for (const day of days) {
    for (const u of allUsers) {
      if (rand() < 0.25) continue; // 有人那天没登
      const times = between(1, 2);
      for (let k = 0; k < times; k += 1) {
        const ev = await prisma.loginEvent.create({
          data: {
            userId: u.id,
            kind: 'SIGN_IN',
            at: loginTime(day, today),
          },
        });
        note('loginEvent', ev.id);
      }
    }
  }

  /* ── 最后跑真的结算 ──
     ★ 每日判定不伪造 ★ 让 catchUpSettlement 照真规则算一遍，
     教练台上看到的中位数、四条、期别变动才是真会发生的那一套。
     它会顺带写 DailyEvaluation 与 AccessDecision，这两张表的新增行也要进清单。 */
  const evalBefore = new Set(
    (await prisma.dailyEvaluation.findMany({ select: { id: true } })).map((r) => r.id),
  );
  const decisionBefore = new Set(
    (await prisma.accessDecision.findMany({ select: { id: true } })).map((r) => r.id),
  );

  for (const u of interns) await catchUpSettlement(u.id);

  for (const r of await prisma.dailyEvaluation.findMany({ select: { id: true } })) {
    if (!evalBefore.has(r.id)) note('dailyEvaluation', r.id);
  }
  for (const r of await prisma.accessDecision.findMany({ select: { id: true } })) {
    if (!decisionBefore.has(r.id)) note('accessDecision', r.id);
  }

  // 让「人工设定」那条分支也有东西看：给第一个人手动锁一个期别
  if (interns[0] && manager) {
    await prisma.user.update({
      where: { id: interns[0].id },
      data: {
        stageOverride: true,
        stageSetBy: 'MANAGER',
        stageSetAt: new Date(),
      },
    });
    const decision = await prisma.accessDecision.create({
      data: {
        subjectId: interns[0].id,
        attemptIds: [],
        gateResults: {} as Prisma.InputJsonObject,
        recommendedStatus: 'NOT_ADMITTED',
        appliedStatus: 'ACTIVE',
        manualOverride: true,
        operatorId: manager.id,
        reason: '【演示数据】手上有三个在谈的客户，先让他接着跟，下周再看。',
        effectiveDay: today,
        poolVersion: 'demo',
        scoreRuleVersion: 'v2_forces_from_persona',
      },
    });
    note('accessDecision', decision.id);
  }

  saveManifest(manifest);

  const total = Object.values(manifest.rows).reduce((a, b) => a + b.length, 0);
  console.log('');
  console.log('演示数据已生成：');
  for (const [table, ids] of Object.entries(manifest.rows)) console.log(`  ${table.padEnd(18)} ${ids.length}`);
  console.log(`  合计 ${total} 行 · 待裁红线 ${pendingMade} 条 · 已裁 ${ruledMade} 条`);
  console.log('');
  console.log(`清单：${MANIFEST}`);
  console.log('★ 上线前跑 npm run demo:clean 抹掉，账号会逐字段还原 ★');
}

/* ══════════════════ 入口 ══════════════════ */

async function main() {
  const args = process.argv.slice(2);
  const wantClean = args.includes('--clean');
  const forcePrefix = args.includes('--force-prefix');

  if (wantClean) {
    console.log('清理演示数据…');
    await clean(forcePrefix);
    return;
  }

  // 生成前先清一遍：反复跑不会越堆越多
  if (loadManifest()) {
    console.log('发现上一批演示数据，先清掉…');
    await clean(false);
  }
  // ★ 造到一半崩了，清单也要落盘 ★
  // 被这个坑过一次：自检抛错时清单还没写，几百行孤儿留在库里，
  // 下一次跑因为 drillId 撞车又崩，只能用 --force-prefix 兜底（那条路不还原账号）。
  // 清单是「能精确抹掉」的第一层保险，它必须先于任何异常落盘。
  try {
    await seed();
  } catch (error) {
    saveManifest(manifest);
    console.error('★ 生成中断，已把已建行写进清单 ★ 先跑 npm run demo:clean 抹干净再重试。');
    throw error;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
