/**
 * 考试选题 + 几个判定共用的小工具。
 *
 * ★ 这个文件里【没有】任何「过没过」的判定 ★（2026-08-24 清理）
 *
 * 曾经有过。v2.0 的 `judgeExam()` 和它的 `EXAM_CONFIG`（3 局中位数 ≥45 ＋ 洞察≥3
 * ＋ 无红线 ＋ 复盘≥1）就长在这儿，v3.0 的双组五闸门长在 `admission.ts`。
 * 到 v1.1 两套都已经不再决定任何人的资格，只剩「让老记录还能重算」这一个用途——
 * 而库里一条老记录都没有（26 场考试全是 DAILY）。
 *
 * 留着它们的实际代价是：系统里同时摆着**两个叫 `medianScoreMin` 的常量**
 * （45 和 65），改错哪一个都不报错、没有测试会红。所以两套一起删掉了。
 *
 * ★ 判定的唯一真源 ★
 *   规则   → `admission-v11.ts` 的 `judgeWindow()`
 *   阈值   → `admission-v11.ts` 的 `ADMISSION_CONFIG`
 *   本场小结 → `redline-review.ts` 的 `settleDailyAttempt()`（只落数字，不判生死）
 */
import { POOL_REQUIREMENTS } from '../../standards/index';

/* ────────────────── 选题 ────────────────── */

export interface ExamCandidate {
  sessionType: 'INQUIRY' | 'FOLLOWUP';
  /** simple_with_distractors | standard | hard */
  difficulty: string;
}

export interface ExamPick<T> {
  picked: T[];
  /** 没凑齐的槽位。空数组＝三个槽位都拿到了该拿的题 */
  shortfalls: string[];
}

/**
 * 考试三局选题：探需·标准 ×1 ＋ 探需·困难 ×1 ＋ 跟进 ×1（需求 11.1）
 *
 * ★ 为什么不能取池子的前三个 ★
 * 原来的写法是 `[inquiry[0], inquiry[1], followup[0]]`——它有两个毛病：
 * ① 难度不受控。两局探需可能都是标准局，那这场考试就没考过困难局，
 *    而「困难局能不能撑住」正是准入要判的东西；
 * ② 固定顺序等于可透题。同一批新人前后脚考，第一个考完就能把三道题告诉后面的人，
 *    「每人每日 1 次」这道闸门当场作废。所以每个槽位在候选里**随机**取。
 *
 * ★ 缺料时降级，但要说出来 ★ 与池子不足退回演习池同一条口径——
 * 可以将就，不可以假装齐了。降级信息经 shortfalls 一路传到接口的 poolWarning。
 */
export function pickExamVariants<T extends ExamCandidate>(
  pool: T[],
  rand: () => number = Math.random,
): ExamPick<T> {
  const used = new Set<T>();
  const take = (list: T[]): T | undefined => {
    const avail = list.filter((v) => !used.has(v));
    if (avail.length === 0) return undefined;
    const v = avail[Math.floor(rand() * avail.length) % avail.length]!;
    used.add(v);
    return v;
  };

  const inquiry = pool.filter((v) => v.sessionType === 'INQUIRY');
  const followup = pool.filter((v) => v.sessionType === 'FOLLOWUP');
  const byDiff = (list: T[], d: string) => list.filter((v) => v.difficulty === d);

  const picked: T[] = [];
  const shortfalls: string[] = [];

  // 槽位 1：探需·标准
  const std = take(byDiff(inquiry, 'standard')) ?? take(inquiry);
  if (std) picked.push(std);
  else shortfalls.push('探需局不足，标准难度这一局没凑上');
  if (std && std.difficulty !== 'standard') shortfalls.push('池子里没有标准探需局，用别的难度顶了一局');

  // 槽位 2：探需·困难
  const hard = take(byDiff(inquiry, 'hard')) ?? take(inquiry);
  if (hard) picked.push(hard);
  else shortfalls.push('探需局不足，困难难度这一局没凑上');
  if (hard && hard.difficulty !== 'hard') shortfalls.push('池子里没有困难探需局，用标准局顶了一局');

  // 槽位 3：跟进
  const fup = take(followup) ?? take(inquiry);
  if (fup) picked.push(fup);
  else shortfalls.push('跟进局这一局没凑上');
  if (fup && fup.sessionType !== 'FOLLOWUP') shortfalls.push('池子里没有跟进局，用探需局顶了一局');

  return { picked, shortfalls };
}

/* ────────────────── 槽位 ────────────────── */

/** 一场考试的三格。顺序就是开考时的生成顺序 */
export const EXAM_SLOTS = ['STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP'] as const;
export type ExamSlot = (typeof EXAM_SLOTS)[number];

/** ★ 页面上不许出现枚举原文 ★ 与 `TRACK_LABEL` 同一条规矩 */
export const EXAM_SLOT_LABEL: Record<ExamSlot, string> = {
  STANDARD_INQUIRY: '探需 · 标准',
  HARD_INQUIRY: '探需 · 困难',
  FOLLOWUP: '跟进',
};

/**
 * 这份变体属于哪个槽位。**全站唯一一份口径**（2026-08-28 合并）。
 *
 * ★ 吃的是**已经解析过的**档位，不是骨架的档位 ★（2026-08-28 难度下沉之后）
 * 调用方一律先过 `variantDifficulty(variant)` 再进来——难度可能挂在变体上，
 * 直接把 `persona` 传进来会漏掉覆盖，而漏掉的表现是"这份题被分进了错误的槽位"，
 * 不会报错。
 *
 * 原来有两份：`api/exam/route.ts` 一份（返回枚举），教练台 `ExamPoolSection` 一份
 * （返回中文标签，而且是个写在 JSX 里的箭头函数）。两份的分档逻辑一模一样，
 * 于是「教练台数出来的槽位份数」和「开考时真正能抽到的份数」靠的是两处各自维护——
 * 改一处不改另一处，主管会看着一个说够了的面板，撞上一个说不够的报错。
 */
export function examSlotOf(item: { sessionType: string; difficulty: string }): ExamSlot | null {
  if (item.sessionType === 'FOLLOWUP') return 'FOLLOWUP';
  if (item.sessionType !== 'INQUIRY') return null;
  if (item.difficulty === 'standard') return 'STANDARD_INQUIRY';
  if (item.difficulty === 'hard') return 'HARD_INQUIRY';
  // 简单探需不进考试池：考试要判的是"标准和困难撑不撑得住"
  return null;
}

/* ────────────────── 槽位内怎么抽 ────────────────── */

export interface SlotCandidate {
  /** 变体主键（cuid）。防重复排除用的就是它 */
  id: string;
  /** 考点编号（`Persona.code`，P1–P32）。★ 均匀随机的单位是它，不是变体 ★ */
  personaCode: string;
}

/**
 * 一个槽位里抽一份题：**先在考点里等概率，再在该考点的变体里等概率**。
 *
 * ★ 为什么不能直接在候选里等概率随机 ★（2026-08-28 改）
 * 原写法是 `candidates[Math.floor(rand() * candidates.length)]`——在**变体**里均匀。
 * 于是变体多的考点等于多拿了几张彩票。实测困难探需槽的分布：
 *
 *     P19 ×6  →  43%      P7 ×4  →  29%      P12 ×2  →  14%      P3 ×2  →  14%
 *
 * 而防重复只排除「上一场用过的骨架」，所以隔一场 P19 就能回来——
 * **一周之内同一个考点撞两三次，撞的还是准入最看重的那一局。**
 * 「换个化身防背题」的前提是考点够多；考点只有 4 个时，第二次见到 P19 的人
 * 已经知道这局考什么了——国家品类人名全变了，要问的东西一个字没变。
 *
 * 改成两步之后同一批题的分布变成 25% / 25% / 25% / 25%，**一份新题都不用写**。
 *
 * ★ 池子健康度的门槛因此挂在「考点数」上，不是「变体数」★
 * 见 `EXAM_POOL_HEALTH`。变体数够而考点数不够时，这个函数照样是均匀的，
 * 但均匀地在 4 个考点里转——所以它治不了根，只是把伤害摊平。
 *
 * @param rand 可注入。挑题逻辑是这套系统里最该被测试盯住的东西，
 *             绑上 `Math.random` 就只能靠跑一万次去猜它准不准。
 */
export function pickSlotVariant<T extends SlotCandidate>(
  candidates: readonly T[],
  rand: () => number = Math.random,
): T | undefined {
  if (candidates.length === 0) return undefined;

  const byCode = new Map<string, T[]>();
  for (const candidate of candidates) {
    const list = byCode.get(candidate.personaCode);
    if (list) list.push(candidate);
    else byCode.set(candidate.personaCode, [candidate]);
  }

  // ★ 键要排序 ★ Map 的插入序取决于候选是怎么从库里查出来的；
  // 不排序的话，同一个 rand 序列在两次查询顺序不同的情况下会抽到不同的题，
  // 测试也就锁不住任何东西。
  const codes = [...byCode.keys()].sort();
  const code = codes[Math.floor(rand() * codes.length) % codes.length]!;
  const pool = byCode.get(code)!;
  return pool[Math.floor(rand() * pool.length) % pool.length]!;
}

/**
 * 考试池健康度门槛（2026-08-28 定案，见《题库管理方案》第六节）。
 *
 * ★ 变体数够 ≠ 池子健康 ★ 上线硬门槛一直只有「每槽 ≥14 份」，
 * 而 42 份题可以全部来自 4 个考点——漏洞台账 N-8 记的「14 个工作日一轮回」
 * 是变体口径，按考点口径算要严重得多。这里补上按考点算的两条。
 */
const REQ = POOL_REQUIREMENTS;
/**
 * 两条硬门槛允许用环境变量调低（演示、试用时只有样品题库，凑不够每槽 14 道）。
 * 只认 ≥1 的整数；没配或配错就用标准层的默认值。正式使用请不要调低。
 */
function envMin(name: string, fallback: number): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.[name];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

export const EXAM_POOL_HEALTH = {
  /** 每槽题数下限。低于此值 `pickAdmissionVariants` 直接抛错，不许开考 */
  minVariantsPerSlot: envMin('POOL_EXAM_SLOT_MIN_QUESTIONS', REQ.exam_slot_min_questions),
  /** 每槽题型数目标。低于此值教练台告警——不抛错，抛错会让现有池子当场开不了考 */
  targetPersonasPerSlot: REQ.exam_slot_target_types,
  /** 每槽题型数下限。低于此值抛错：3 个题型的槽位已经不是"抽题"，是"轮流" */
  minPersonasPerSlot: envMin('POOL_EXAM_SLOT_MIN_TYPES', REQ.exam_slot_min_types),
  /**
   * 单个考点在一个槽里的最大占比。超了告警。
   *
   * ★ 为什么是 0.25 不是 0.2 ★ 一个槽 14 份，0.2 换算过来是「一个考点最多 2 份」——
   * 跟进槽有 11 个考点、最大的那个占 3 份（21%），是全系统最健康的一个槽，
   * 却会被 0.2 报成告警。**把最健康的那一格标红，等于把这条告警作废**——
   * 主管看两天就不看了，真正该喊的困难探需 43% 也跟着被忽略。
   * 0.25 放过 3/14，正好卡在「4 份就算独大」上。
   */
  maxPersonaShare: REQ.exam_slot_max_type_share,
  /** 「不重题天数」低于这个数就进教练台待办条 */
  freshDaysWarn: REQ.fresh_days_warn,
} as const;

/** 练习池题数下限（上线检查用），同样可用环境变量调低 */
export const DRILL_POOL_MIN = envMin('POOL_DRILL_MIN_QUESTIONS', REQ.drill_min_questions);

/* ────────────────── 共用小工具 ────────────────── */

/**
 * 中位数。**全站唯一一份实现**——别再各写各的。
 *
 * ★ 为什么强调"唯一一份" ★（2026-08-25 合并）
 * 这个函数原来有两份：这里一份，board.ts 里还有一份私有的。两份在空数组上行为不同——
 * 这里返回 0，那边会算成 `s[-1] + s[0]`，得到 **NaN**。那边靠调用点写 `valid.length > 0`
 * 挡住了，所以一直没出事；但守卫在调用点、不在函数里，第二个调用点忘了写就静默出 NaN，
 * 而 NaN 会一路穿过 `>= 65` 这类比较（永远为 false）变成"没达标"——
 * 一个判定 bug，界面上却看不出任何异常。现在只留这一份。
 *
 * ★ 空数组返回 0 是**刻意的**，但调用点通常不该依赖它 ★
 * 「没有样本」和「中位数是 0 分」是两回事。判定逻辑要区分这两者时，
 * 请在调用前自己判空并给出 null（admission-v11 与 board 都是这么做的），
 * 不要拿这里的 0 当"没样本"用。
 */
export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 结论文案守卫：禁止出现任何等级表述（需求 11.3 / 1.3 铁律）。
 *
 * 演习分只叫【演习段位 D】。写成「达到 L2」会造出一批"纸上谈兵"的高分新人——
 * 七力漂亮、真实商机零推进。宁可不出结论，也不出一句会误导人的结论。
 */
export function assertConclusionClean(text: string): void {
  const m = text.match(/\bL[1-5]\b|能力段位|达到\s*L/);
  if (m) throw new Error(`考试结论文案出现禁用的等级表述「${m[0]}」`);
}
