/**
 * 花费：开工前预估，加工中逐次记账。单价读环境变量（元 / 百万 token），与柜子的成本台账同一组变量：
 *   PRICE_FLASH_IN_MISS / PRICE_FLASH_OUT —— flash 模型（归型）
 *   PRICE_PRO_IN_MISS   / PRICE_PRO_OUT   —— pro 模型（起草、变体、修订）
 * 单价填**空闲时段**的价格；`PRICE_PEAK_MULTIPLIER` 给高峰时段的倍数（DeepSeek 是 2，没有峰谷的服务商留空）。
 * 没配单价就只统计 token，不折算金额。
 */
import { modelFor, type Purpose } from './llm';

const num = (name: string) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function pricesFor(model: string): { inPer1M: number; outPer1M: number } {
  const pro = /pro/i.test(model);
  return pro
    ? { inPer1M: num('PRICE_PRO_IN_MISS'), outPer1M: num('PRICE_PRO_OUT') }
    : { inPer1M: num('PRICE_FLASH_IN_MISS'), outPer1M: num('PRICE_FLASH_OUT') };
}

/**
 * 这一刻的单价倍数。DeepSeek：北京时间周一到周五 9:00–12:00、14:00–18:00 为高峰，单价翻倍。
 * ★ 法定节假日认不出，一律按高峰算 ★ 多算一点只会让预算闸早停，少算会让它拦不住。
 */
export function peakMultiplier(at: Date = new Date()): number {
  const m = Number(process.env.PRICE_PEAK_MULTIPLIER);
  if (!Number.isFinite(m) || m <= 1) return 1;
  const bj = new Date(at.getTime() + 8 * 3600_000);
  const day = bj.getUTCDay();
  const h = bj.getUTCHours();
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18)) ? m : 1;
}

/**
 * @param at 调用发生的时间，用来判高峰；不传按空闲时段算（预估用）。
 *   缓存命中的输入没单独记，按未命中价算——同样是宁高勿低。
 */
export function costOf(model: string, inputTokens: number, outputTokens: number, at?: Date): number {
  const p = pricesFor(model);
  return ((inputTokens * p.inPer1M + outputTokens * p.outPer1M) / 1_000_000) * (at ? peakMultiplier(at) : 1);
}

/** 粗估字符数对应的 token：中文约 1.5 字/token、英文约 4 字符/token，这里统一按 3 字符/token 估 */
const tokensOf = (chars: number) => Math.ceil(chars / 3);

/**
 * 每次调用的 token 口径。★ 来自 2026-11-06 样品 8 份真模型实测 ★（deepseek-v4-flash 归型、v4-pro 起草修订）：
 *   归型：每次输入约 3.4k（考纲清单 + 素材）、输出约 1.1k；
 *   起草 / 修订：每次输出约 7.7k（含模型的推理 token），输入约 3k + 素材；
 *   一道题平均要 2.4 次 pro 调用才过闸（起草 1 次 + 修订 1.4 次）；
 *   变体：每次输入约 5.5k（母题 + 产品 + 字段说明），输出同起草。
 * ★ 2026-11-06 真实素材复测校准 ★ 10 份真实聊天共 99 次调用（10 归型 + 约 24 次母题 + 约 65 次变体，
 *   30 道变体），变体比样品难过闸、改写太浅还要重写，平均 2.2 次调用一道（样品是 1.3）。按样品口径会少估三成。
 * 换模型或改提示词后要重新量，改这几个数，别在调用处另算。
 */
export const COST_BASIS = {
  triageIn: 2500,
  triageOut: 1100,
  draftIn: 3000,
  draftOut: 7700,
  callsPerQuestion: 2.4,
  variantIn: 5500,
  callsPerVariant: 2.2,
};

export interface Estimate {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
  pricesConfigured: boolean;
  /** 其中母题部分（归型 + 起草 + 修订）；其余是考试变体 */
  mothers: { inputTokens: number; outputTokens: number };
}

/**
 * @param materialChars 每份素材的字符数
 * @param variantsPerMother 每道母题衍生几个变体（按每道母题都被采用、都能进考试估，是上限）
 */
export function estimateBatch(materialChars: number[], variantsPerMother: number): Estimate {
  const B = COST_BASIS;
  let tin = 0;
  let tout = 0;
  let cost = 0;
  const add = (purpose: Purpose, i: number, o: number) => {
    tin += i;
    tout += o;
    cost += costOf(modelFor(purpose), i, o);
  };
  for (const chars of materialChars) {
    const t = tokensOf(chars);
    add('triage', B.triageIn + t, B.triageOut);
    add('draft', Math.ceil((B.draftIn + t) * B.callsPerQuestion), Math.ceil(B.draftOut * B.callsPerQuestion));
  }
  const mothers = { inputTokens: tin, outputTokens: tout };
  for (let i = 0; i < materialChars.length * variantsPerMother; i += 1) {
    add('variant', Math.ceil(B.variantIn * B.callsPerVariant), Math.ceil(B.draftOut * B.callsPerVariant));
  }
  const pricesConfigured = pricesFor(modelFor('draft')).inPer1M > 0;
  return { inputTokens: tin, outputTokens: tout, costCny: Math.round(cost * 100) / 100, pricesConfigured, mothers };
}
