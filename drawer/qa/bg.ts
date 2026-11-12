/**
 * 背调包质检（原 `scripts/import/verify-bg.ts` 的判定部分，命令行与抽屉共用）。
 *
 * 背调包比题目更容易坏得无声无息，三种坏法都不会抛异常：
 *   · 预埋错误的 truth 和 claim 说的是同一件事 → 包里没有考点，界面一切正常；
 *   · detectable_via 指着包里不存在的材料 → 新人怎么查都识破不了，报告还判他「没识破」；
 *   · 写给出题人看的话忘了加下划线前缀 → 剥壳层不摘，答案直接发到浏览器。
 *
 * ★ 两套结构都认 ★ 甲：ai_report.content + planted_error（单个，抽屉只出这一套）；
 *   乙：ai_report.conclusion + findings + _planted_errors（复数，只给牌号，旧包有两份）。
 */
import { stripAnswers, validateBgPackage, type Persona } from '../../bank-kit/index';
import type { Problem } from './regex';

interface PlantedError {
  type?: string;
  claim?: string;
  truth?: string;
  detectable_via?: string[];
}

export interface BgPackageShape {
  persona_id?: string;
  variant_id?: string;
  ai_report?: {
    content?: string;
    conclusion?: unknown;
    findings?: unknown[];
    planted_error?: PlantedError;
    _planted_errors?: { ids?: string[]; detected_definition?: string };
  };
  website?: Record<string, unknown>;
  social?: Record<string, unknown>;
  contacts?: Record<string, unknown>;
}

/**
 * 名字像答案、却没有下划线前缀的键——剥壳层不会摘掉。
 * `note` 不在名单里：它在背调包里是材料描述（「店铺页面公开可查」），把它算进来会让健康的包一起报红。
 */
const ANSWERY = /(hint|answer|truth|design|decision|reasoning|planted|scoring_hook|card_hook)/i;

function leakyKeys(value: unknown, path: string[], out: string[]): void {
  if (Array.isArray(value)) return value.forEach((v, i) => leakyKeys(v, [...path, String(i)], out));
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_') || key === 'planted_error') continue;
    if (ANSWERY.test(key)) out.push([...path, key].join('.'));
    leakyKeys(child, [...path, key], out);
  }
}

/** 包里可查的材料：三块的名字和各块下一级的键，供 detectable_via 对照 */
function materialKeys(pkg: BgPackageShape): Set<string> {
  const keys = new Set<string>();
  for (const section of ['website', 'social', 'contacts'] as const) {
    const block = pkg[section];
    if (!block) continue;
    keys.add(section);
    for (const k of Object.keys(block)) if (!k.startsWith('_')) keys.add(k);
  }
  return keys;
}

/**
 * @param persona 这份包挂的题。传了就额外查「包与题对得上」：编号一致、报告写的是这个买家。
 */
export function checkBgPackage(pkg: BgPackageShape, persona?: Persona): Problem[] {
  const out: Problem[] = [];
  const hard = (what: string) => out.push({ level: '✗', what });
  for (const f of validateBgPackage(pkg)) hard(`背调包格式：${f.message}`);
  const leaky: string[] = [];
  leakyKeys(pkg, [], leaky);
  for (const k of leaky) hard(`背调包字段 \`${k}\` 名字像写给出题人看的，却没有下划线前缀——剥壳层不会摘它，F12 就能读到`);

  const multi = pkg.ai_report?._planted_errors;
  if (!pkg.ai_report?.planted_error && multi) {
    if (!(multi.ids ?? []).length) hard('_planted_errors.ids 是空的——没指明哪几张牌是预埋错误');
    if (!multi.detected_definition?.trim()) hard('_planted_errors.detected_definition 是空的——「怎样算识破」没写');
    if (!pkg.ai_report?.conclusion && !(pkg.ai_report?.findings ?? []).length) hard('ai_report 既没有 conclusion 也没有 findings——新人看不到报告内容');
    out.push({ level: '⚠', what: '背调包用的是乙套结构（conclusion + findings + _planted_errors），写新包请照甲套（content + planted_error）' });
    return out;
  }

  const planted = pkg.ai_report?.planted_error;
  if (!planted) {
    hard('背调包没有 planted_error——考点就是那个预埋的错误结论，没有它只是一堆资料');
    return out;
  }
  for (const f of ['type', 'claim', 'truth'] as const) if (!planted[f]?.trim()) hard(`planted_error.${f} 是空的`);
  if (planted.claim && planted.truth && planted.claim.trim() === planted.truth.trim()) hard('planted_error 的 claim 和 truth 一模一样——没有预埋任何错误');
  const via = planted.detectable_via ?? [];
  if (via.length < 2) hard(`detectable_via 只有 ${via.length} 条，至少两条：只有一条时新人漏看那一项就永远识破不了`);
  const content = pkg.ai_report?.content ?? '';
  if (!content.trim()) hard('ai_report.content 是空的——新人看不到报告正文');
  const materials = materialKeys(pkg);
  if (!materials.size) hard('没有任何交叉验证材料（website / social / contacts 全空）');
  if (planted.truth && JSON.stringify(stripAnswers(pkg)).includes(planted.truth.slice(0, 20))) {
    hard('剥壳之后 planted_error.truth 的内容仍然出现在发给浏览器的数据里——答案会被 F12 读到');
  }

  if (persona) {
    if (pkg.persona_id !== persona.id) hard(`背调包挂的是 ${pkg.persona_id}，题目是 ${persona.id}`);
    const name = persona.open_card.name.split(/\s+/).filter((x) => x.length > 2);
    if (name.length && !name.some((x) => content.includes(x))) out.push({ level: '⚠', what: `AI 报告正文里没提到买家「${persona.open_card.name}」，新人看不出报告写的是谁` });
    // 每条识破路径都要在包里找得到对应的材料（按「路径名里的词能在材料键名里找到」粗判）
    const flat = [...materials].join(' ').toLowerCase();
    const lost = via.filter((v) => !v.toLowerCase().split(/[_\s-]+/).some((w) => w.length > 3 && flat.includes(w)));
    if (lost.length === via.length && via.length) out.push({ level: '⚠', what: `识破路径（${via.join('、')}）在材料里一条都对不上，新人可能查不到` });
  }
  return out;
}
