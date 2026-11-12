/**
 * 忠实度：暗牌是素材里真有的，还是编的（原 `scripts/import/verify-fidelity.ts` 的判定部分）。
 *
 * 每张暗牌在 `_source.quotes` 里交代出处：出自素材第几条消息的哪句原话，或者标明是补写的并写理由。
 * 归一化复用 `engine/scoring.normalize`，与评分侧的引文校验逐字节同一口径。
 */
import { normalize } from '../../engine/scoring.js';
import type { Persona } from '../../bank-kit/index';
import { cardsOf, type Problem } from './regex';

export interface Material {
  /** 素材每条消息的正文（脱敏后） */
  text: string[];
  /** 导出件自带的中文对照，可能为空 */
  textCn: string[];
}

export interface FidelityResult {
  problems: Problem[];
  checked: number;
  invented: number;
}

/**
 * @param material 素材正文；派生题（全部补写）可以传 null
 * @param strict   严格模式：每张暗牌都必须交代来历（新题一律严格）
 */
export function checkFidelity(p: Persona, material: Material | null, strict = true): FidelityResult {
  const problems: Problem[] = [];
  const quotes = new Map((p._source?.quotes ?? []).map((q) => [q.card, q]));
  const haystack = (material?.text ?? []).map(normalize);
  const haystackCn = (material?.textCn ?? []).map(normalize);
  let checked = 0;
  let invented = 0;

  for (const key of Object.keys(cardsOf(p))) {
    const q = quotes.get(key);
    if (!q) {
      if (strict) problems.push({ level: '✗', what: `${key} 没有交代出处：要么给出素材里的原话，要么写 invented: true 并写理由` });
      continue;
    }
    if (q.invented) {
      if (!q.why?.trim()) problems.push({ level: '✗', what: `${key} 标了补写却没写理由` });
      else invented += 1;
      continue;
    }
    if (!material) {
      problems.push({ level: '✗', what: `${key} 声称引自素材，但没有素材可对照` });
      continue;
    }
    const quote = normalize(q.quote ?? '');
    if (!quote) {
      problems.push({ level: '✗', what: `${key} 的原话是空的` });
      continue;
    }
    checked += 1;
    const idx = q.message_index;
    const hit =
      typeof idx === 'number' && idx >= 0 && idx < haystack.length && (haystack[idx]!.includes(quote) || (haystackCn[idx] ?? '').includes(quote));
    if (hit) continue;
    const real = haystack.findIndex((line) => line.includes(quote));
    if (real !== -1) {
      problems.push({ level: '⚠', what: `${key} 的原话在第 ${real} 条，不在第 ${idx} 条` });
      continue;
    }
    problems.push({ level: '✗', what: `${key} 的原话在素材里找不到：「${(q.quote ?? '').slice(0, 40)}」——内容是编的，或者引文抄错了` });
  }
  return { problems, checked, invented };
}
