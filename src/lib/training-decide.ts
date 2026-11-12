/**
 * 结构化训练任务的**判定内核**——纯函数，不碰数据库、不碰时钟。
 *
 * ★ 为什么拆出来 ★（2026-08-25，与 settlement-decide.ts 同一轮）
 * `training.ts` 里有两段真正的判定，都长在 prisma 调用中间，因此都没法测：
 *   ① `taskSessionValid()` —— 决定这一局算不算「有效练习局」。
 *      算，任务标 COMPLETED 并解锁下一项；不算，任务标 INVALID 并**再生成一道补测**。
 *      也就是说它直接决定新人今天要不要重练一局。
 *   ② `pickTrainingVariant()` 里那段排序 —— 决定他抽到哪道题。
 *      「同一变体同一天不重复」和「优先给练得最少的」两条规则藏在一句 sort 里，
 *      而它上面是 findMany、下面是 throw，整段没有任何办法单独验证。
 *
 * 拆完的规矩和 engine/ 一样：判定在这里，取数与写库留在 training.ts。
 * 这个文件受 `check-engine-purity` 看管，出现 prisma 会直接让 `npm run verify` 失败。
 */

/** 训练任务的槽位类型。与 BASELINE_TRAINING_PLAN 保持一致 */
export type TaskSlot = 'SIMPLE_INQUIRY' | 'STANDARD_INQUIRY' | 'HARD_INQUIRY' | 'FOLLOWUP';

/**
 * 基线训练计划：8 道题的固定顺序。
 * 简单 ×2 → 标准 ×3 → 困难 ×2（最后一道带背调）→ 跟进 ×1。
 * ★ 只有最后一道困难局要求背调包 ★ 背调是加料，不是每道题都配得起。
 */
export const BASELINE_TRAINING_PLAN: readonly { slotType: TaskSlot; requiresBg: boolean }[] = [
  { slotType: 'SIMPLE_INQUIRY', requiresBg: false },
  { slotType: 'SIMPLE_INQUIRY', requiresBg: false },
  { slotType: 'STANDARD_INQUIRY', requiresBg: false },
  { slotType: 'STANDARD_INQUIRY', requiresBg: false },
  { slotType: 'STANDARD_INQUIRY', requiresBg: false },
  { slotType: 'HARD_INQUIRY', requiresBg: false },
  { slotType: 'HARD_INQUIRY', requiresBg: true },
  { slotType: 'FOLLOWUP', requiresBg: false },
];

/** 一个训练周期里，8 道任务初始该是什么状态：第一道解锁，其余排队 */
export function buildTrainingPlan(): { orderNo: number; slotType: TaskSlot; requiresBg: boolean; status: 'UNLOCKED' | 'PENDING' }[] {
  return BASELINE_TRAINING_PLAN.map((item, index) => ({
    orderNo: index + 1,
    slotType: item.slotType,
    requiresBg: item.requiresBg,
    // ★ 只解锁第一道 ★ 一次全解锁，新人会挑简单的先做，难度梯度就白设计了
    status: index === 0 ? ('UNLOCKED' as const) : ('PENDING' as const),
  }));
}

/** 训练周期编号：A-简码-起始业务日。同一个人同一天重复调用要得到同一个编号 */
export function trainingCycleId(code: string, startDay: string): string {
  return `A-${code}-${startDay.replaceAll('-', '')}`;
}

// ───────────────────────── 有效练习局 ─────────────────────────

/** 判「有效练习局」需要看的那几件事。调用方从库里取好填进来 */
export interface TaskSessionSnapshot {
  status: string;
  exitReason: string | null;
  /** 这一局的消息，只用到 role */
  messages: { role: string }[];
  /** 复盘问答 */
  coachQa: { answer: string | null; followUp: string | null; followUpAnswer: string | null; skipped: boolean }[];
  /** 评分结果。reportMd 有值才算真出过报告 */
  score: { reportMd: string | null } | null;
}

/** 复盘至少要答满几题才算完整 */
export const DEBRIEF_MIN_QUESTIONS = 5;
/**
 * 至少要有几次业务员动作，这一局才算"练过了"。
 * ★ 提前离场可以豁免 ★ 客户被气走了本来就没机会说满 6 轮——
 * 那一局照样有教育意义，不该判成无效让他重来。
 */
export const MIN_TRAINEE_ACTIONS = 6;

/** 复盘答完整了没：每题都答了，有追问的追问也答了，且没有一题是跳过的 */
export function isDebriefComplete(coachQa: TaskSessionSnapshot['coachQa']): boolean {
  return (
    coachQa.length >= DEBRIEF_MIN_QUESTIONS &&
    coachQa.every(
      (item) =>
        Boolean(item.answer?.trim()) &&
        (!item.followUp || Boolean(item.followUpAnswer?.trim())) &&
        !item.skipped,
    )
  );
}

/**
 * 这一局算不算「有效练习局」。
 *
 * 四条全中才算：局结束了、出了报告、复盘答完整、业务员真说够了话。
 * ★ 不算的后果不是"扣分"，是"补测" ★ 任务标 INVALID 并再排一道同类的，
 * 所以这里判宽了会让人蒙混过关，判严了会让人白练一局重来——两边都不能错。
 */
export function isValidTrainingSession(session: TaskSessionSnapshot): boolean {
  const traineeActions = session.messages.filter((item) => item.role === 'trainee').length;
  return (
    session.status === 'ENDED' &&
    Boolean(session.score?.reportMd) &&
    isDebriefComplete(session.coachQa) &&
    (traineeActions >= MIN_TRAINEE_ACTIONS || Boolean(session.exitReason))
  );
}

// ───────────────────────── 选题 ─────────────────────────

/** 选题只看这几个字段，其余（persona、bgPackage…）与排序无关 */
export interface TrainingCandidate {
  /** 数据库主键，用来和历史局对上 */
  id: string;
  /** 人设编号，同分时按它排，保证结果稳定 */
  variantId: string;
}

export interface RankInput<T extends TrainingCandidate> {
  candidates: T[];
  /** 今天已经练过的变体 id */
  usedTodayIds: Iterable<string>;
  /** 每个变体历史上被练过几次 */
  useCount: ReadonlyMap<string, number>;
}

/**
 * 把候选题排个序，最该派的排在最前。
 *
 * 两条规则，顺序不能反：
 * ① **同一变体同一天不能重复**——先把今天练过的整个剔掉，不是排到后面。
 *    重复练同一道题，任务是完成了，可什么也没练到。
 * ② 剩下的里优先给**练得最少**的；次数相同时按 variantId 排，
 *    保证同样的输入永远给同样的顺序（否则同一个人刷新一下就换一道题）。
 *
 * 返回空数组＝今天的这一类都练过了，调用方据此报错，不要硬派一道重复的。
 */
export function rankTrainingCandidates<T extends TrainingCandidate>(input: RankInput<T>): T[] {
  const usedToday = new Set(input.usedTodayIds);
  const available = input.candidates.filter((candidate) => !usedToday.has(candidate.id));
  return [...available].sort(
    (a, b) =>
      (input.useCount.get(a.id) ?? 0) - (input.useCount.get(b.id) ?? 0) ||
      a.variantId.localeCompare(b.variantId),
  );
}

/**
 * 槽位 → 人设筛选条件。
 * ★ 简单局包含「简单+干扰项」★ 干扰项只是加料，难度还算简单档。
 */
export function slotPersonaFilter(slot: TaskSlot):
  | { sessionType: 'FOLLOWUP' }
  | { sessionType: 'INQUIRY'; difficulty: string }
  | { sessionType: 'INQUIRY'; difficulty: { in: string[] } } {
  if (slot === 'FOLLOWUP') return { sessionType: 'FOLLOWUP' };
  if (slot === 'HARD_INQUIRY') return { sessionType: 'INQUIRY', difficulty: 'hard' };
  if (slot === 'STANDARD_INQUIRY') return { sessionType: 'INQUIRY', difficulty: 'standard' };
  return { sessionType: 'INQUIRY', difficulty: { in: ['simple', 'simple_with_distractors'] } };
}

/** 这个槽位认哪几个难度值。null ＝ 这个槽位不看难度（跟进局） */
function slotDifficulties(slot: TaskSlot): string[] | null {
  if (slot === 'FOLLOWUP') return null;
  if (slot === 'HARD_INQUIRY') return ['hard'];
  if (slot === 'STANDARD_INQUIRY') return ['standard'];
  return ['simple', 'simple_with_distractors'];
}

/**
 * 槽位 → **变体级**筛选条件（2026-08-28 补）。
 *
 * ★ 为什么不能只用 `slotPersonaFilter` ★
 * 难度那天从骨架下沉到变体（`PersonaVariant.difficulty`，null ＝ 跟骨架走）之后，
 * 「这一份是什么难度」不再只看骨架。而训练任务派题这条路**当时漏掉了**——
 * 它一直在用 `persona: slotPersonaFilter(slot)`，也就是只按骨架筛。
 * 后果：一份「骨架标准、变体覆盖成困难」的题会被派进标准槽，
 * 而一份真困难的题在困难槽里反而找不到。**不会报错，只会派错**。
 *
 * 现在漏没漏得出来是零影响（库里 0 份声明了覆盖），但这正是它危险的地方：
 * 第一份覆盖变体入库的那天才会发作，而那时没人会想到是这里。
 *
 * SQL 层没有 COALESCE 可用，只能把两种情况都写出来——与 `AppShell` 里那个
 * 段位筛选同一个写法、同一个理由。
 */
export function slotVariantFilter(slot: TaskSlot): Record<string, unknown> {
  const diffs = slotDifficulties(slot);
  const persona = slotPersonaFilter(slot);
  if (!diffs) return { persona };
  return {
    OR: [
      // 变体自己声明了档位 → 以它为准，只要局型对得上
      { difficulty: { in: diffs }, persona: { sessionType: 'INQUIRY' } },
      // 没声明 → 跟骨架走
      { difficulty: null, persona },
    ],
  };
}
