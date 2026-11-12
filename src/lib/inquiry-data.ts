/**
 * 询盘池的取数层。
 *
 * ★ 为什么和 inquiry-pool.ts 分开 ★ 两个原因，各自都足够：
 * ① 题库页的筛选是 client 组件干的，它要渲染 InquiryRow；
 *    只要那条 import 链上挂着 prisma，@prisma/client 就会被打进浏览器包。
 * ② 挑题算法是这套系统里最该被测试盯住的东西，纯函数才测得动。
 * 所以纯逻辑全在 inquiry-pool.ts，会碰库的只有这个文件。
 *
 * ★ 页面一律不查暗牌 ★（2026-08-23 血的教训）
 * 改版时先写成 `include: { persona: true, bgPackage: true }` 图省事——
 * 那会把整行 PersonaVariant 拉出来：hiddenCard、distractors、exitLines、
 * quoteReactions、背调包里预埋的 planted_error 全在里面。这些一旦进了
 * 页面组件，React 就会把它们序列化进 HTML 的 RSC 负载，
 * **等于把每一局的答案、解锁口令和陷阱注释印在网页源码里**，右键查看源代码就能读。
 * 所以这里只 select 界面真正要显示的字段，并且当场压成 InquiryCard——
 * 暗牌连内存都不进，也就没有第二次漏出去的机会。
 */
import { prisma } from './db';
import { businessDay } from './business-day';
import type { InquiryCard, PlayRecord } from './inquiry-pool';
import { leitnerNext, weakestForceOf, type MasteryState } from './drill-assign';
import type { Force } from '../../engine/types';

/**
 * 演习池。★ poolType 这个条件一个字都不能省 ★
 * 考试专用的那 42 封只能出现在教练台的题库页，
 * 漏进业务员看得到的任何列表都等于泄题（见系统总览「考试题库只在 /replay 显示」）。
 */
export async function loadDrillCards(): Promise<InquiryCard[]> {
  const rows = await prisma.personaVariant.findMany({
    where: { poolType: 'DRILL', active: true },
    select: {
      id: true,
      variantId: true,
      openCard: true, // 明牌，本来就是给业务员看的
      difficulty: true, // 变体级难度覆盖（2026-08-28 下沉）。解析一律走 variantDifficulty
      // activeForces：派单的弱项加成要看这个考点主考哪几力（只有 negotiation/stability 有区分度）
      persona: {
        select: { code: true, name: true, tests: true, difficulty: true, sessionType: true, activeForces: true },
      },
      bgPackage: { select: { id: true } }, // 只要「有没有」，不要里面的内容
    },
    orderBy: { variantId: 'asc' },
  });

  return rows.map((row) => {
    const o = row.openCard as Record<string, unknown>;
    return {
      id: row.id,
      variantId: row.variantId,
      difficulty: row.difficulty,
      /**
       * ★ activeForces 是 Json 列，类型系统管不住它 ★ 库里存的是字符串数组，
       * 但 Prisma 给的是 JsonValue（可能是 null、可能是任何东西）。
       * 在这里收窄一次，别把 `as` 撒到每个读点上——一个拼错的力名会一路飘进派单算分。
       */
      persona: {
        ...row.persona,
        activeForces: Array.isArray(row.persona.activeForces)
          ? (row.persona.activeForces.filter((f): f is string => typeof f === 'string') as readonly string[])
          : [],
      },
      hasBg: row.bgPackage !== null,
      name: String(o.name ?? ''),
      company: String(o.company ?? ''),
      country: String(o.country ?? ''),
      buyerLevel: String(o.buyer_level ?? ''),
      // ★ 客户可以在后台把这些字段全部隐藏 ★ 隐藏和「值为 0」是两回事：
      // 前者说明这个人不想被看见（P12 就是整排空白），后者是真的没动作。
      // 所以这里显示「登录 — 天」，不显示「登录 0 天」。
      loginDays: String(o.login_days_90d ?? '—'),
      tags: Array.isArray(o.tags) ? (o.tags as string[]) : [],
      blacklisted: Number(o.blacklisted_count ?? 0),
      productViews: o.product_views_90d == null ? null : Number(o.product_views_90d),
      validInquiries: o.valid_inquiries_90d == null ? null : Number(o.valid_inquiries_90d),
      inquiryText: String(o.inquiry_text ?? ''),
    } satisfies InquiryCard;
  });
}

/**
 * 「我」在每一封上的战绩，外加今天已经开过哪几封。
 * 两件事一次查完——用的是同一批行，分两次查纯属多一个来回。
 */
export async function loadMyHistory(userId: string): Promise<{
  history: Map<string, PlayRecord>;
  openedToday: Set<string>;
  /**
   * 每个**考点**在他身上的状态（Leitner 盒、上次哪天、上次几分、练过几局）。
   * 派单的三项加权读它，见 `drill-assign.personaPriority`。
   */
  mastery: Map<string, MasteryState>;
  /** 最近若干局里最弱的那一力。样本不够为 null——不猜 */
  weakestForce: Force | null;
}> {
  const rows = await prisma.session.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      variantId: true,
      createdAt: true,
      // ★ 考点编号 ★ 间隔重复的单位是考点，不是变体——复习时要换一个化身、不换考点
      variant: { select: { persona: { select: { code: true } } } },
      score: { select: { rawScore: true, tier: true, precise: true, forces: true } },
    },
  });

  const today = businessDay();
  const history = new Map<string, PlayRecord>();
  const openedToday = new Set<string>();

  for (const row of rows) {
    // ★ key 是 PersonaVariant.id（cuid），不是 〈题型〉-〈国家〉-〈序号〉 ★
    // Session.variantId 这个外键指的是主键，弄反了整页会显示成「全都没练过」
    if (businessDay(row.createdAt) === today) openedToday.add(row.variantId);
    const cur = history.get(row.variantId) ?? { count: 0, lastAt: null, bestScore: null, bestTier: null };
    cur.count += 1;
    if (cur.lastAt === null || row.createdAt > cur.lastAt) cur.lastAt = row.createdAt;
    // 证据不足的局没有可比的分（precise=false），不参与「最好成绩」
    const score = row.score;
    if (score?.precise && score.rawScore !== null && (cur.bestScore === null || score.rawScore > cur.bestScore)) {
      cur.bestScore = score.rawScore;
      cur.bestTier = score.tier;
    }
    history.set(row.variantId, cur);
  }

  /**
   * ★ 考点层面的状态：演习局与考试局都算 ★
   * 他昨天在考试里打了 P7 只得 40 分，那是"该练 P7"最强的信号，
   * 没有理由因为它发生在考试里就不算。间隔重复管的是记忆，不是场次归属。
   */
  const mastery = new Map<string, MasteryState>();
  // rows 是 createdAt 倒序，所以第一次遇到某个考点就是它最近的一局
  for (const row of rows) {
    const code = row.variant?.persona?.code;
    if (!code) continue;
    const day = businessDay(row.createdAt);
    const score = row.score?.precise ? row.score.rawScore : null;
    const seen = mastery.get(code);
    if (!seen) {
      mastery.set(code, { code, box: 1, lastDay: day, lastScore: score, plays: 1 });
    } else {
      seen.plays += 1;
    }
  }
  /**
   * 盒号要从**最早**那一局开始逐局推——盒子是链式的，倒着算不出来。
   * 上面那一轮只拿到了"最近一局"与"练过几局"，这里再正着走一遍推盒号。
   */
  for (const [code, state] of mastery) {
    let box = 1;
    for (const row of [...rows].reverse()) {
      if (row.variant?.persona?.code !== code) continue;
      box = leitnerNext(box, row.score?.precise ? row.score.rawScore : null);
    }
    state.box = box;
  }

  /**
   * 最弱的那一力。★ 只看有精确分的局 ★ 证据不足的局七力多半残缺，
   * 拿它算平均会把"没评到"说成"评得低"。
   */
  const forceRows = rows
    .filter((row) => row.score?.precise)
    .slice(0, 12)
    .map((row) => {
      const forces = (row.score?.forces ?? {}) as Record<string, { score?: unknown }>;
      const out: Partial<Record<Force, number>> = {};
      for (const [force, item] of Object.entries(forces)) {
        if (typeof item?.score === 'number') out[force as Force] = item.score;
      }
      return out;
    });

  return { history, openedToday, mastery, weakestForce: weakestForceOf(forceRows) };
}
