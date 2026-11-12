/**
 * 变体对母题的检查：结构必须一样，内容必须真的改过。
 *
 * ★ 结构比的是暗牌编号（H1、H2…），不是完整键名 ★ 母题常把内容写进键名（H5_malaysia_payment），
 *   变体换了内容、键名跟着改成 H5_singapore_payment 是对的；要守住的是张数、编号和依赖关系。
 * ★ 内容改写太少只提醒 ★ 相似度是字符层面的粗估，判不了「改得好不好」，只能标出「几乎没改」的，交给主管看。
 */
import type { Persona } from '../../bank-kit/index';
import { cardsOf, type Problem } from './regex';

/** 改写太少的提醒线：暗牌内容平均相似度达到它。样品实测：真改写过的 0.46–0.73，只改了数字的 0.81–0.90 */
export const VARIANT_SIMILARITY_WARN = 0.8;

const slot = (key: string) => /^([A-Za-z]+\d+)/.exec(key)?.[1] ?? key;

function bigrams(s: string): Map<string, number> {
  const t = s.replace(/\s+/g, '');
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i += 1) m.set(t.slice(i, i + 2), (m.get(t.slice(i, i + 2)) ?? 0) + 1);
  return m;
}

/** 字符二元组的 Dice 系数，0–1 */
export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [k, n] of x) inter += Math.min(n, y.get(k) ?? 0);
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  return total ? (2 * inter) / total : a === b ? 1 : 0;
}

export function checkVariant(mother: Persona, v: Persona): Problem[] {
  const out: Problem[] = [];
  const mc = cardsOf(mother);
  const vc = cardsOf(v);
  const mSlots = new Map(Object.keys(mc).map((k) => [slot(k), k]));
  const vSlots = new Map(Object.keys(vc).map((k) => [slot(k), k]));
  const ms = [...mSlots.keys()].sort().join('、');
  const vs = [...vSlots.keys()].sort().join('、');
  if (ms !== vs) {
    out.push({ level: '✗', what: `变体的暗牌编号（${vs}）与母题（${ms}）不一致：变体只换内容，不增删暗牌` });
    return out;
  }
  for (const [s, vk] of vSlots) {
    const mk = mSlots.get(s)!;
    const req = (c: { requires?: string[] }) => (c.requires ?? []).map(slot).sort().join('、');
    if (req(mc[mk]!) !== req(vc[vk]!)) out.push({ level: '✗', what: `${vk} 的前置牌（${req(vc[vk]!) || '无'}）与母题（${req(mc[mk]!) || '无'}）不一致` });
  }
  if (v.skeleton.type_code !== mother.skeleton.type_code) out.push({ level: '✗', what: '变体的题型与母题不一致' });
  const sims = [...vSlots].map(([s, vk]) => similarity(String(mc[mSlots.get(s)!]!.value), String(vc[vk]!.value)));
  const avg = sims.reduce((a, b) => a + b, 0) / (sims.length || 1);
  if (avg >= VARIANT_SIMILARITY_WARN) {
    out.push({ level: '⚠', what: `暗牌内容与母题平均相似度 ${avg.toFixed(2)}，几乎没改写：背过母题的新人能直接过这道考试题` });
  }
  return out;
}
