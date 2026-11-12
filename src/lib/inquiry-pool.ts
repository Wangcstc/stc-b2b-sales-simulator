/**
 * 询盘池：难度分档、按考点分组、每日派单。
 *
 * ★ 为什么要有这个文件 ★（2026-08-23）
 * 在这之前，首页把 104 封人设按三档折叠平铺，业务员从上往下点。
 * 实测下来 104 封里**只有 17 封被点开过**，其余 87 封上线至今零次；
 * 点击死死卡在每档头几行，而简单档头 6 行恰好全是同一个骨架 P1——
 * 从上往下点三局，练的是同一个考点三遍。
 *
 * 根因不是排版，是**选择的单位错了**：104 封 = 32 个骨架 × 1–7 封皮肤。
 * 列表上写的「买家姓名 / 国家 / 等级」不携带任何学习信息，
 * 业务员没有判断依据，只能点最上面那个。
 *
 * 所以这里把两件事分开：
 *   ① 首页不给他挑——pickTodayQueue 每天派三封（三档各一），练完自动补；
 *   ② 想自己挑的去题库页——groupByPersona 按考点分组，每组写清考什么。
 *
 * ★ 派单不落库 ★「今天派哪三封」是 (人, 业务日, 今天已开过的局) 的纯函数，
 * 刷新结果稳定、练完自动换下一封，不需要任何队列表，也就不会有
 * 「队列表和真实开局对不上」这类只能靠对账才发现的脏数据。
 */
import { businessDay } from './business-day';
import { variantDifficulty } from './variant-difficulty';
import { personaPriority, type MasteryState } from './drill-assign';
import type { Force, SessionType } from '../../engine/types';

/* ═════════════ 难度分档 ═════════════ */

export type Bucket = 'simple' | 'standard' | 'hard';

export const BUCKET_ORDER: Bucket[] = ['simple', 'standard', 'hard'];

export const BUCKET: Record<Bucket, { label: string; color: string; hint: string }> = {
  simple: { label: '简单', color: 'var(--ok)', hint: '先把话听清楚——客户说的和你以为的，是不是同一件事' },
  standard: { label: '标准', color: 'var(--warn)', hint: '推进卡在哪里——沉默、决策链、复购与临门让步' },
  hard: { label: '困难', color: 'var(--bad)', hint: '要判断的东西不在字面上——风险、边界、价格锚点、真实身份' },
};

/** simple_with_distractors 归进简单档：带干扰项只是加了噪音，考的还是听清楚 */
export function bucketOf(difficulty: string): Bucket {
  if (difficulty === 'hard') return 'hard';
  if (difficulty === 'standard') return 'standard';
  return 'simple';
}

/* ═════════════ 纯算法只认的最小形状 ═════════════ */

/**
 * ★ 不直接吃 Prisma 类型 ★ 与 pickExamVariants 同一条口径：
 * 挑题逻辑是这套系统里最该被测试盯住的东西，绑上 Prisma 就只能连着库测。
 */
export interface PoolPersonaShape {
  code: string;
  name: string;
  tests: string;
  difficulty: string;
  sessionType: 'INQUIRY' | 'FOLLOWUP';
  /**
   * 这个考点主考哪几力。派单的弱项加成读它。
   * ★ 只有 negotiation / stability 能区分考点 ★ 其余五力 32 个考点全都主考，
   * 理由与后果见 `drill-assign.ts` 文件头。可选：题库页那条取数不需要它。
   */
  activeForces?: readonly string[];
}

export interface PoolItemShape {
  /** PersonaVariant.id（cuid）。★ Session.variantId 存的就是这个，不是 〈题型〉-〈国家〉-〈序号〉 ★ */
  id: string;
  /** 〈题型〉-〈国家〉-〈序号〉，印在链接和演习 ID 里的那个 */
  variantId: string;
  /**
   * 变体级难度覆盖（2026-08-28 下沉）。null ＝ 跟骨架走。
   * ★ 别直接读它 ★ 一律走 `variantDifficulty(item)`，那是全站唯一一处解析口径。
   */
  difficulty?: string | null;
  persona: PoolPersonaShape;
}

/**
 * 界面上一封询盘要显示的**全部**内容。
 *
 * ★ 这是一道边界，不只是一个类型 ★ 页面和组件只认这个形状，
 * 于是暗牌（hiddenCard / distractors / exitLines / quoteReactions / 背调包正文）
 * 根本没有进入渲染树的路径——不然它们会被 React 序列化进 HTML 的 RSC 负载，
 * 右键查看源代码就能读到每一局的解锁口令和陷阱注释。
 * 装配在 inquiry-data.ts 的 loadDrillCards 里，那里也不 select 暗牌。
 */
export interface InquiryCard extends PoolItemShape {
  /** 有没有背调资料包。只要这一个布尔，不要包里的内容 */
  hasBg: boolean;
  name: string;
  company: string;
  country: string;
  /** 平台原样字段：A、B、C、两档 L 级，或 "-"（= 客户把等级藏了） */
  buyerLevel: string;
  loginDays: string;
  tags: string[];
  blacklisted: number;
  productViews: number | null;
  validInquiries: number | null;
  /** 探需局是询盘原文，跟进局是本局前情 */
  inquiryText: string;
}

/** 一封人设在「我」身上的战绩。key 一律是 variant 的 cuid */
export interface PlayRecord {
  count: number;
  lastAt: Date | null;
  bestScore: number | null;
  bestTier: string | null;
}

export type PlayHistory = ReadonlyMap<string, PlayRecord>;

/* ═════════════ 排序用的小工具 ═════════════ */

/** FNV-1a。只用来给并列的候选定一个稳定又不眼熟的先后，不是随机数发生器 */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** null（没练过）排最前 */
function cmpLastAt(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a.getTime() - b.getTime();
}

/**
 * P2 排在 P10 前面。
 * ★ 这一条修的是一个真 bug ★ 原来列表按 variantId 字符串排，
 * 于是 "P10-…" < "P11-…" < "P2-…"，P4「报价后沉默型」被排到标准档第 58 位。
 */
export function personaCodeOrder(code: string): number {
  const n = Number(/^P(\d+)/.exec(code)?.[1]);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/* ═════════════ 考点（骨架）维度的聚合 ═════════════ */

export interface PersonaStat {
  /** 这个考点下所有封加起来练过几局 */
  count: number;
  /** 这个考点下有几封被练过 */
  playedVariants: number;
  /** 最近一次练这个考点是什么时候 */
  lastAt: Date | null;
}

export function personaStats<T extends PoolItemShape>(
  pool: readonly T[],
  history: PlayHistory,
): Map<string, PersonaStat> {
  const stats = new Map<string, PersonaStat>();
  for (const item of pool) {
    const cur = stats.get(item.persona.code) ?? { count: 0, playedVariants: 0, lastAt: null };
    const rec = history.get(item.id);
    if (rec) {
      cur.count += rec.count;
      cur.playedVariants += 1;
      if (cmpLastAt(cur.lastAt, rec.lastAt) < 0) cur.lastAt = rec.lastAt;
    }
    stats.set(item.persona.code, cur);
  }
  return stats;
}

/** 考点覆盖率：32 个考点里碰过几个。首页 KPI 那一格 */
export function personaCoverage<T extends PoolItemShape>(
  pool: readonly T[],
  history: PlayHistory,
): { touched: number; total: number } {
  const stats = personaStats(pool, history);
  let touched = 0;
  for (const stat of stats.values()) if (stat.playedVariants > 0) touched += 1;
  return { touched, total: stats.size };
}

/* ═════════════ 每日派单 ═════════════ */

/**
 * 今天该接待哪几封：**简单／标准／困难各一封**。
 *
 * ★ 为什么是固定 1+1+1，不按段位自适应 ★
 * ① 实习业务员解锁考试要求「当天 ≥3 局有效演习、其中 ≥1 局非简单」
 *    （admission-v11 的 dailyDrillMin / minNonSimpleDrillsForUnlock），
 *    固定配比让这条门槛天然满足，不必让新人自己去数今天练了几局非简单；
 * ② 每天都覆盖三档，不会偏食；
 * ③ 规则一句话说得清，界面上「为什么是这三封」写得出来。
 * 段位自适应留到有足够真实样本之后再说。
 *
 * ★ 三封不是配额，是常备量 ★ openedToday 里的封会被排除，
 * 所以开一封就补一封，队列永远是「三封还没开过的」。练手局仍旧不限次数。
 *
 * @param openedToday 今天已经开过局的 variant cuid
 * @param seed 打破并列用，形如 `${userId}|${业务日}|${nonce}`。同一天同一人结果稳定
 */
export interface QueueContext {
  /** 今天（业务日）。间隔重复要拿它算到没到期 */
  today: string;
  /** 每个考点在他身上的状态。空 Map ＝ 退回旧的「平均覆盖」行为 */
  mastery: ReadonlyMap<string, MasteryState>;
  /** 最近若干局里最弱的那一力。null ＝ 样本不够，别猜 */
  weakestForce: Force | null;
}

/** 派单理由：界面上要说得出「今天为什么派这一封」。key 是 variant 的 cuid */
export type QueueReasons = ReadonlyMap<string, string>;

export function pickTodayQueue<T extends PoolItemShape>(
  pool: readonly T[],
  history: PlayHistory,
  openedToday: ReadonlySet<string>,
  seed: string,
  /**
   * ★ 可选 ★ 不传就是 2026-08-28 之前的行为（平均覆盖），
   * 现有测试与任何还没接上下文的调用点因此一行都不用改。
   */
  context?: QueueContext,
  /** 传进来就往里写每一封的入选理由。不传就不算 */
  reasons?: Map<string, string>,
): T[] {
  const stats = personaStats(pool, history);
  const picked: T[] = [];
  const used = new Set<string>();

  for (const bucket of BUCKET_ORDER) {
    const candidates = pool.filter(
      (item) => bucketOf(variantDifficulty(item)) === bucket && !openedToday.has(item.id) && !used.has(item.id),
    );
    if (candidates.length === 0) continue;

    /**
     * ① 先定考点。
     *
     * ★ 2026-08-28：从「平均覆盖」换成「弱项 × 间隔重复 × 新鲜度」★
     * 旧排序是「练得最少、最久没练」优先——那既不是刻意练习（跟他弱在哪无关），
     * 也不是间隔重复（"最久没练"是倒序，练过的考点越往后越不回来）。
     * 三项加权的定义与权重在 `drill-assign.personaPriority`，那是纯函数、有测试。
     *
     * ★ 旧的三条排序留作并列的打破者 ★ 新人第一天所有考点都没练过，
     * 三项分会齐刷刷相等；这时仍然按「练得最少、最久没练、稳定散列」来分，
     * 与改动之前逐位一致。**新规则只在有历史之后才真正开始起作用。**
     */
    const codeMeta = new Map<string, { activeForces: readonly string[]; sessionType: SessionType }>();
    for (const item of candidates) {
      if (!codeMeta.has(item.persona.code)) {
        codeMeta.set(item.persona.code, {
          activeForces: item.persona.activeForces ?? [],
          sessionType: item.persona.sessionType === 'FOLLOWUP' ? 'followup' : 'inquiry',
        });
      }
    }
    const priorityOf = (code: string): number => {
      if (!context) return 0;
      const meta = codeMeta.get(code)!;
      return personaPriority(
        { activeForces: meta.activeForces, sessionType: meta.sessionType, mastery: context.mastery.get(code) },
        { today: context.today, weakestForce: context.weakestForce },
      ).total;
    };

    const codes = [...new Set(candidates.map((item) => item.persona.code))].sort((a, b) => {
      const sa = stats.get(a) ?? { count: 0, playedVariants: 0, lastAt: null };
      const sb = stats.get(b) ?? { count: 0, playedVariants: 0, lastAt: null };
      return (
        // 分高的在前。差距小于 0.001 视为并列，交给下面三条旧规则
        (priorityOf(b) - priorityOf(a) > 0.001 ? 1 : priorityOf(a) - priorityOf(b) > 0.001 ? -1 : 0) ||
        sa.count - sb.count ||
        cmpLastAt(sa.lastAt, sb.lastAt) ||
        hash32(`${seed}|${a}`) - hash32(`${seed}|${b}`) ||
        personaCodeOrder(a) - personaCodeOrder(b)
      );
    });
    const code = codes[0]!;

    // ② 再定封：这个考点下没练过的优先
    const chosen = candidates
      .filter((item) => item.persona.code === code)
      .sort((a, b) => {
        const ra = history.get(a.id);
        const rb = history.get(b.id);
        return (
          (ra?.count ?? 0) - (rb?.count ?? 0) ||
          cmpLastAt(ra?.lastAt ?? null, rb?.lastAt ?? null) ||
          hash32(`${seed}|${a.variantId}`) - hash32(`${seed}|${b.variantId}`) ||
          a.variantId.localeCompare(b.variantId)
        );
      })[0]!;

    picked.push(chosen);
    used.add(chosen.id);
    if (reasons && context) {
      const meta = codeMeta.get(code)!;
      const why = personaPriority(
        { activeForces: meta.activeForces, sessionType: meta.sessionType, mastery: context.mastery.get(code) },
        { today: context.today, weakestForce: context.weakestForce },
      ).reason;
      if (why) reasons.set(chosen.id, why);
    }
  }

  return picked;
}

/* ═════════════ 「换一批」 ═════════════ */

/**
 * 换一批 = 把 seed 的 nonce 从 0 换成 1，**每日限一次**。
 *
 * ★ 为什么记在 cookie 里而不是建表 ★ 这不是安全边界，是自律提醒——
 * variantId 明文印在「接待」链接里，谁都能直接开任意一封练手局，
 * 「今天派三封」从来就拦不住人，也不打算拦。为这么一件事加一张表、
 * 跑一次迁移，代价和它的分量对不上。代价是清了 cookie 就能重置，认了。
 * 哪天要做到「主管看得见谁换过牌」，那时候再加表。
 */
export function rerollCookieName(day: string = businessDay()): string {
  return `drill_queue_${day.replaceAll('-', '')}`;
}

/** cookie 值 → nonce。没换过是 0，换过是 1 */
export function queueNonce(cookieValue: string | undefined): number {
  return cookieValue === '1' ? 1 : 0;
}

export function queueSeed(userId: string, nonce: number, day: string = businessDay()): string {
  return `${userId}|${day}|${nonce}`;
}

/** 题库页那个「随机来一封」。rand 可注入，理由同 pickExamVariants */
export function pickRandom<T>(list: readonly T[], rand: () => number = Math.random): T | undefined {
  if (list.length === 0) return undefined;
  return list[Math.floor(rand() * list.length) % list.length];
}

/* ═════════════ 按考点分组（题库页） ═════════════ */

export interface PersonaGroup<T> {
  code: string;
  name: string;
  tests: string;
  bucket: Bucket;
  sessionType: 'INQUIRY' | 'FOLLOWUP';
  variants: T[];
  /** 这个考点下练过的封数 */
  playedVariants: number;
  playedSessions: number;
  lastAt: Date | null;
}

/**
 * 按骨架分组。**分组键是 persona.code，不是 persona.tests**——
 * tests 是自由文本（多数长成 "A + B"），拿它当键会分出一堆只差一个字的组。
 *
 * 排序：没碰过的考点在前，然后按难度档，最后按 P 编号自然序。
 */
export function groupByPersona<T extends PoolItemShape>(
  pool: readonly T[],
  history: PlayHistory,
): PersonaGroup<T>[] {
  const groups = new Map<string, PersonaGroup<T>>();
  for (const item of pool) {
    const persona = item.persona;
    let group = groups.get(persona.code);
    if (!group) {
      group = {
        code: persona.code,
        name: persona.name,
        tests: persona.tests,
        bucket: bucketOf(variantDifficulty(item)),
        sessionType: persona.sessionType,
        variants: [],
        playedVariants: 0,
        playedSessions: 0,
        lastAt: null,
      };
      groups.set(persona.code, group);
    }
    group.variants.push(item);
    const rec = history.get(item.id);
    if (rec) {
      group.playedVariants += 1;
      group.playedSessions += rec.count;
      if (cmpLastAt(group.lastAt, rec.lastAt) < 0) group.lastAt = rec.lastAt;
    }
  }

  for (const group of groups.values()) {
    group.variants.sort((a, b) => a.variantId.localeCompare(b.variantId));
  }

  return [...groups.values()].sort(
    (a, b) =>
      Number(a.playedVariants > 0) - Number(b.playedVariants > 0) ||
      BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket) ||
      personaCodeOrder(a.code) - personaCodeOrder(b.code),
  );
}

/** 一行右边那句「我的记录」 */
export function playLabel(rec: PlayRecord | undefined): string {
  if (!rec || rec.count === 0) return '没练过';
  const times = `练过 ${rec.count} 局`;
  return rec.bestTier ? `${times} · 最好 ${rec.bestTier}` : times;
}
