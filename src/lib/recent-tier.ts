import { median } from './exam';
import { toDrillTier } from '../../engine/scoring';

/**
 * 演习段位怎么从多局算出来。
 *
 * ★ 2026-08-14 建 ★ 在这之前，版头和账号管理页的「段位」取的都是**最近一局**
 * （`scores[0]`）。那是拿一个数字冒充结论：一个稳定在 55 分的人随手打砸一局 30，
 * 页头当场显示 D1；而系统自己在考试通过文案里写着
 * 「样本量 3 局 < 正式定级门槛（8–10 局）」——它明明认为定级要 8–10 局。
 *
 * ★ 为什么是中位数不是平均 ★
 * 一局踩红线不该把人打回原形；但连着两局差就该真的掉下去，那是应该的。
 * 平均做不到这件事——一个 0 分能把七局好局全部拉垮。
 *
 * ★ 为什么是"近 N 局"不是全部 ★
 * 新人第一周的烂分不该跟他一辈子。取全部等于练得越久越难翻身，
 * 那会让这个数字从"你现在什么水平"变成"你曾经有多差"。
 *
 * ★ 为什么不累加 ★
 * rawScore 是 0–100 的能力分，不是积分。累加只会随练习量单调增长，
 * 那是在奖励刷局数，不是衡量能力。
 *
 * ★ 考试局计入 ★ 考试通过文案自己写的是「演习段位 D，样本 3 局」——
 * 考试局本来就产出演习段位。把它排除，等于让页头忽略这个人最严肃的那三局。
 */

/**
 * 段位取近多少局。
 * 8 不是随手定的，是 `exam.ts` 的 PASS_TEXT 里已经写死的「正式定级门槛 8–10 局」的下限。
 * 取下限而不是上限，是让段位早几天变得可用。**改这个数之前先去看那段文案**——
 * 两处对不上，就等于同一套系统里有两套"多少局才算数"的说法。
 */
export const TIER_WINDOW = 8;

/**
 * 少于这么多局不给段位。
 * 一两局的中位数不是水平，是运气。宁可显示「样本不足」也不挂一个会被当真的段位——
 * 这套系统里的段位是要拿去决定谁能接真实询盘的，不能靠一局。
 */
export const TIER_MIN_SAMPLE = 3;

/**
 * 哪些难度的局计入段位。**简单局不计。**
 *
 * ★ 为什么要排除简单局 ★（2026-08-14 加）
 * `computeSessionScore` 算 rawScore 时**不含难度系数**——只有七力加权，
 * 所以打简单局和打困难局，同样的表现拿同样的分。
 * 演习池里简单/标准/困难都有、又不限次数，那么「近 8 局中位数」的最优解
 * 就变成了只打简单局。段位是要拿去判断谁能接真实询盘的，
 * 一个靠刷简单局堆上去的 D4 会把人放错位置。
 *
 * ★ 为什么不是给 rawScore 加难度系数 ★
 * 那会改动每一局的分，历史局和新局从此不可比，等于把已经存下来的数据作废。
 * 在统计口径上排除，历史分一个不动，随时可以改回来。
 *
 * ★ 考试局不受影响 ★ 考试三槽位是「探需标准 + 探需困难 + 跟进」，
 * 随机抽题、挑不了难度，本来就全在这个集合里。
 */
export const TIER_DIFFICULTIES = ['standard', 'hard'] as const;

export interface RecentTier {
  /** 样本够才有段位；不够是 null */
  tier: string | null;
  /** 中位数局分。样本不够时仍然给（可以看，但不构成段位） */
  score: number | null;
  /** 实际参与计算的局数（已经按窗口截断） */
  sample: number;
  /** 样本够不够 TIER_MIN_SAMPLE */
  enough: boolean;
}

/**
 * @param rawScoresNewestFirst **只传精确评分（precise）的局分，按时间从新到旧**。
 *   覆盖度不达双门槛的局没有 rawScore，本来就不该参与——传进来会拉低所有人。
 */
export function recentTier(rawScoresNewestFirst: number[]): RecentTier {
  const window = rawScoresNewestFirst.slice(0, TIER_WINDOW);
  const sample = window.length;
  if (sample === 0) return { tier: null, score: null, sample: 0, enough: false };

  const score = Math.round(median(window));
  const enough = sample >= TIER_MIN_SAMPLE;
  return { tier: enough ? toDrillTier(score) : null, score, sample, enough };
}

/** 版头/表格里那句话。样本不够时说清楚还差多少，别让人以为系统坏了 */
export function tierLabel(t: RecentTier): string {
  if (t.sample === 0) return '— · 还没有计入段位的局（简单局不计）';
  if (!t.enough) return `— · 已有 ${t.sample} 局计入，满 ${TIER_MIN_SAMPLE} 局才出段位`;
  return `${t.tier} · ${t.score} 分 · 近 ${t.sample} 局中位数`;
}

/** KPI 卡那种「大字＋小字」的排版用：大字放段位，小字放这句 */
export function tierSubLabel(t: RecentTier): string {
  if (t.sample === 0) return '还没有计入段位的局 · 简单局只练不计段';
  if (!t.enough) return `已有 ${t.sample} 局计入，满 ${TIER_MIN_SAMPLE} 局才出段位`;
  // ★ 这个中位数不是准入判定的那个 ★ 段位取近 8 局（含演习局），准入取最近 6 局考试局。
  // 两个数字并排出现时不写清口径，人会以为系统在自相矛盾。
  return `${t.score} 分 · 近 ${t.sample} 局中位数 · 不含简单局 · 与准入判定不同口径`;
}
