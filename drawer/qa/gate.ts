/**
 * 工序⑥ 质检 + 工序⑦ 校准：一道题所有的机器闸门一次跑完。
 *
 * 任何一条 ✗ 都是硬问题：抽屉不会把它送去主管确认，而是退回模型修订（最多 maxAttempts 次）。
 * ⚠ 只提醒，写进确认卡的推荐理由里让主管知道。
 */
import { QUALITY_RULES, syllabusType } from '../../standards/index';
import { lintPersona, validatePersona, type Persona } from '../../bank-kit/index';
import { runAutoplay, toAutoplayShape, type AutoplayPersona } from './autoplay';
import { checkBuyerLanguage, checkPriceConsistency, type CatalogItem } from './consistency';
import { checkFidelity, type Material } from './fidelity';
import { checkRegex, type Problem } from './regex';
import { SIX_ELEMENTS } from '../../engine/types.js';

export interface GateResult {
  problems: Problem[];
  /** 机制难度指数（0–100），打不通时为 null */
  index: number | null;
}

export function runGates(p: Persona, material: Material | null, catalog: CatalogItem[] | undefined): GateResult {
  const problems: Problem[] = [];
  const hard = (what: string) => problems.push({ level: '✗', what });

  // 格式：Schema 不过，后面的检查没有意义
  const schema = validatePersona(p, p.id);
  if (schema.length) {
    for (const f of schema.slice(0, 12)) hard(`格式：${f.where} ${f.message}`);
    return { problems, index: null };
  }

  // 考纲：题型、档位
  const t = syllabusType(p.skeleton.type_code);
  if (!t) hard(`题型 ${p.skeleton.type_code} 不在考纲里`);
  else {
    const allowed = [t.default_difficulty, ...t.also_difficulties];
    if (!allowed.includes(p.skeleton.difficulty)) hard(`${t.name}只能出 ${allowed.join(' / ')}，写的是 ${p.skeleton.difficulty}`);
    if (p.pool_type === 'admission_exam' && !t.exam_eligible) hard(`${t.name}暂不进考试，不能放进考试池`);
  }

  // 质量门槛（对已有题库只提醒，对新题是硬门槛）
  for (const w of lintPersona(p)) hard(w);
  const r = QUALITY_RULES.init_state_range;
  for (const [k, v] of Object.entries(p.init_state)) {
    if (typeof v === 'number' && (v < r.min || v > r.max)) hard(`开局 ${k}=${v}，标准是 ${r.min}–${r.max}`);
  }

  const oc = p.open_card;
  if (!oc.company.trim()) hard('买家公司名是空的：素材里没有就虚构一个（与买家国家相称）');
  else if (oc.name.trim().toLowerCase() === oc.company.trim().toLowerCase()) hard(`买家姓名写成了公司名「${oc.name}」`);
  // 补写过半：这道题主要是编的，不是从素材里来的——不拦，但要让主管知道
  const qs = p._source?.quotes ?? [];
  const inv = qs.filter((x) => x.invented).length;
  // 变体的暗牌按设计全部标为「由母题改写」，不算
  if (!p.derived_from && qs.length && inv * 2 > qs.length) problems.push({ level: '⚠', what: `暗牌 ${qs.length} 张里 ${inv} 张是补写的，超过一半：这道题主要靠编，离素材较远` });

  // 跟进局前情：引擎按六要素代码判定哪些已经谈过，写成别的等于前情没写，新人要把六要素重新问一遍
  const preset = (p.preset_elements ?? []) as unknown[];
  const bad = preset.filter((x) => typeof x !== 'string' || !(SIX_ELEMENTS as readonly string[]).includes(x));
  if (bad.length) hard(`preset_elements 只能写六要素代码（${SIX_ELEMENTS.join(' / ')}），写成了：${bad.map(String).join('；').slice(0, 120)}`);
  if (p.skeleton.session_type === 'inquiry' && preset.length) hard('询盘局没有前情，preset_elements 应为空');
  if (p.skeleton.session_type === 'followup' && !preset.length) problems.push({ level: '⚠', what: '跟进局没写前情（preset_elements），新人要把六要素从头问一遍' });
  const fr = (p as unknown as { followup_reactions?: Record<string, unknown> }).followup_reactions;
  if (fr && Object.keys(fr).some((k) => /[一-龥]/.test(k))) hard('followup_reactions 的键名里有中文：多半是把输出格式的说明照抄了进来');

  problems.push(...checkRegex(p));
  // 编译不过的正则会让引擎当场抛异常：先报出来，后面的自动对局不跑（否则整批加工被一道题打断）
  if (problems.some((x) => x.level === '✗' && /编译不过/.test(x.what))) return { problems, index: null };
  problems.push(...checkFidelity(p, material, true).problems);
  problems.push(...checkBuyerLanguage(p));
  problems.push(...checkPriceConsistency(p, catalog));

  const played = runAutoplay(toAutoplayShape(p as unknown as AutoplayPersona));
  problems.push(...played.problems);
  return { problems, index: played.difficulty?.index ?? null };
}

export const hardCount = (ps: Problem[]) => ps.filter((x) => x.level === '✗').length;
