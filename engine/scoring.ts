/**
 * 局分计算与引文校验（技术方案 8.3 / 8.4）
 *
 * ★ 双门槛不达标必须拒绝出分 ★
 * 这是 v6.0 的硬规则，不能因为"用户想看分数"就放行。
 * 样本不足时给一个精确到个位的分数，比不给分更有害——它看起来很客观。
 */

import type {
  ScoreOutput,
  Force,
  SessionScore,
  DrillTier,
  SessionType,
  SessionFacts,
} from './types';
import { pickWeights, DUAL_THRESHOLD, DRILL_TIERS, FLAG_THRESHOLD } from './rules';
import { applyDifficulty, normalizeFactor } from './difficulty';

/** 归一化：大小写、空白、标点、全半角，允许轻度不精确匹配 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[.,!?;:'"“”‘’（）()【】\[\]—\-–…、。，！？；：]/g, '');
}

export interface MessageLike {
  turn: number;
  content: string;
}

/**
 * ★ 引文校验 —— 评分可信度的地基 ★
 * 没有这一步，"强制取证"就只是 prompt 里的一句空话：模型会编出看起来很像的引文。
 * 引不出原话的维度降为 INSUFFICIENT（退出分母，对应 v6.0 规则）。
 */
export function verifyEvidence(out: ScoreOutput, messages: MessageLike[]): ScoreOutput {
  const byTurn = new Map(messages.map((m) => [m.turn, normalize(m.content)]));
  const result: ScoreOutput = {};

  for (const [force, item] of Object.entries(out) as [Force, ScoreOutput[Force]][]) {
    if (!item) continue;
    if (typeof item.score !== 'number') {
      result[force] = item;
      continue;
    }
    const valid = item.evidence.filter((e) => {
      const content = byTurn.get(e.turn);
      return content !== undefined && content.includes(normalize(e.quote));
    });
    result[force] =
      valid.length === 0
        ? { ...item, score: 'INSUFFICIENT', evidence: [], anchor: '证据无法回溯，该维度判为证据不足' }
        : { ...item, evidence: valid };
  }
  return result;
}

export function toDrillTier(raw: number): DrillTier {
  const hit = DRILL_TIERS.find((t) => raw >= t.min && raw <= t.max);
  return (hit?.tier ?? 'D1') as DrillTier;
}

export interface ScoreInputs {
  scores: ScoreOutput;
  sessionType: SessionType;
  /** 即时推进度 0/1/2 */
  progress?: 0 | 1 | 2;
  /**
   * 复盘作答质量 0/1/2；未作答传 undefined。
   *
   * ★ 只落库，不参与任何判定 ★（2026-08-24 起）留在入参里是为了调用方读起来完整，
   * 局分公式、段位、红旗一律不读它。要看完成率去台账，不要回来接进这里。
   */
  answerQuality?: 0 | 1 | 2;
  /**
   * 这一局开局时的难度系数（`Session.difficultyFactor`）。默认 1.0 = 标准难度。
   *
   * ★ 全系统唯一读它的地方就在下面那一行 ★ 门槛永远是 65，
   * α 调的是「拿到 65 有多难」，不是「多少分算过」。
   */
  difficultyFactor?: number;
}

/**
 * 局分计算。**纯代码**，不让 LLM 算术。
 *
 * 加权能力分 = Σ(得分 × 权重) ÷ Σ(可评权重)
 * 原始演习局分 = (加权能力分 − 1) ÷ 4 × 100
 */
export function computeSessionScore({
  scores,
  sessionType,
  progress,
  difficultyFactor = 1,
}: ScoreInputs): SessionScore {
  const weights = pickWeights(sessionType);
  const evaluable = (Object.entries(scores) as [Force, ScoreOutput[Force]][]).filter(
    ([, v]) => v && typeof v.score === 'number',
  ) as [Force, { score: number }][];

  const coverage = evaluable.reduce((sum, [f]) => sum + weights[f], 0);
  const evaluableCount = evaluable.length;

  if (coverage < DUAL_THRESHOLD.minCoverage || evaluableCount < DUAL_THRESHOLD.minCount) {
    return {
      precise: false,
      reason: `覆盖率 ${(coverage * 100).toFixed(0)}%、可评维度 ${evaluableCount} 项，未达双门槛（需 ≥60% 且 ≥4 项）`,
      coverage,
      evaluableCount,
      flags: [],
    };
  }

  const weighted = evaluable.reduce((sum, [f, v]) => sum + v.score * weights[f], 0) / coverage;
  const baseline = Math.round(((weighted - 1) / 4) * 100);

  /**
   * ★ 难度系数在这里、也只在这里生效 ★
   * 折算之后的 `raw` 才是全系统认的局分：段位、红旗、中位数、准入判定读的都是它。
   * α=1 时 `applyDifficulty` 原样返回，行为与 2026-08-23 之前逐位相同。
   */
  const raw = applyDifficulty(baseline, difficultyFactor);
  const tier = toDrillTier(raw);

  /**
   * ★ 复盘作答质量不再产出任何评分侧结论 ★（2026-08-24，08-19 反馈 #9）
   *
   * 王铖当场裁定：「接下来我会撇出去，不作为评分标准。」准入判定那边早就撇干净了
   * （`ADMISSION_CONFIG.activeGates` 只剩 `score`），只剩这里还挂着一条
   * `high_score_zero_insight`「高分·零认知」红旗——它进报告、进台账，
   * 业务员看到的就是"复盘答得不好被记了一笔"，和"不参与评分"这句话是打架的。
   *
   * ★ 数照常算、照常存 ★ `Score.answerQuality` 仍然逐局落库，
   * 管理者要看完成率/认真度（文档 5.2 第 4 条建议）数据是全的，只是不再变成结论。
   * 红旗类型里保留这个字面量：老的 Score 记录里存着它，报告要读得出来。
   */
  const flags: SessionScore['flags'] = [];
  if (raw >= FLAG_THRESHOLD.minScore && progress === 0) flags.push('high_skill_zero_progress');

  return {
    precise: true,
    coverage,
    evaluableCount,
    weightedAbility: weighted,
    rawScore: raw,
    /** 没打折之前的分。报告里要能说清「原始 70 → 难度系数 1.2 → 最终 65」 */
    baselineScore: baseline,
    difficultyFactor: normalizeFactor(difficultyFactor),
    tier,
    flags,
  };
}

/**
 * 洞察力的事实侧输入：★只数「新人问出来的」六要素★
 * 客户主动送上门的（volunteered）不计功劳——2026-08-05 手动跑局发现的缺口。
 */
export function insightFactBasis(facts: SessionFacts): {
  askedCount: number;
  volunteeredCount: number;
  unlockedCount: number;
  hasR1: boolean;
} {
  const values = Object.values(facts.elements);
  return {
    askedCount: values.filter((e) => e.collected && e.source === 'asked').length,
    volunteeredCount: values.filter((e) => e.collected && e.source === 'volunteered').length,
    unlockedCount: facts.unlockedCards.length,
    hasR1: facts.redlines.includes('R1'),
  };
}
