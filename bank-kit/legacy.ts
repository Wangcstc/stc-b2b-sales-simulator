/**
 * 旧格式题目 → 题库格式 v1。
 *
 * 旧格式是 v8 之前项目里 `p0/personas/*.json` 与 `p0/bg-packages/*.json` 的写法。
 * 这个转换器只做机械映射，不改题目内容：
 *   · 编号：P22-EX-001 → <新题型编码>-<国家两位代码>-<序号>，旧编号留在 `_legacy_id`
 *   · 题型：考纲 v1 的 P1–P32 → 考纲 v2 的 55 型（P10 与 P28 合并为 F04）
 *   · 题池：pool_type / exam_only → pool_type
 *   · 难度：旧题型的档位与新题型默认档位不同时（合并题型会这样），把旧档位写到题目上，实际难度不变
 *   · 产品：五花八门的键名 → 规范化字段，认不出的原样放进 extra，一个值都不丢
 *   · 来源：`_source_slug` / `_source_comment` 与各暗牌上的 `_source` → 顶层 `_source`（只记编号与出处）
 *   · 验证用例：`_verify_cases` → `verify_cases`
 */
import { typeFromLegacyCode } from '../standards/index';
import type { BgPackage, Persona, PoolType, PriceTier, Product, SourceNote } from './types';

/* ───────────── 国家 → 两位代码 ───────────── */

const COUNTRY: Record<string, string> = {
  Argentina: 'AR', Australia: 'AU', Bangladesh: 'BD', Brazil: 'BR', 'Burkina Faso': 'BF', Cameroon: 'CM',
  Canada: 'CA', Chile: 'CL', Colombia: 'CO', "Côte d'Ivoire": 'CI', Czechia: 'CZ',
  'Democratic Republic of the Congo': 'CD', France: 'FR', Gabon: 'GA', Georgia: 'GE', Germany: 'DE',
  Ghana: 'GH', 'Hong Kong': 'HK', Hungary: 'HU', India: 'IN', Italy: 'IT', Japan: 'JP', Kazakhstan: 'KZ',
  Kenya: 'KE', Libya: 'LY', Mexico: 'MX', Morocco: 'MA', Netherlands: 'NL', Nigeria: 'NG', Pakistan: 'PK',
  Poland: 'PL', Romania: 'RO', Russia: 'RU', 'Saudi Arabia': 'SA', Senegal: 'SN', Serbia: 'RS', Spain: 'ES',
  Sweden: 'SE', Turkey: 'TR', Türkiye: 'TR', 'United Arab Emirates': 'AE', 'United Kingdom': 'GB',
  'United States': 'US', China: 'CN', Singapore: 'SG', Malaysia: 'MY', Indonesia: 'ID', Thailand: 'TH', Vietnam: 'VN',
  Philippines: 'PH', 'South Korea': 'KR', Israel: 'IL', Egypt: 'EG', 'South Africa': 'ZA', Ireland: 'IE', Belgium: 'BE',
  Switzerland: 'CH', Austria: 'AT', Portugal: 'PT', Greece: 'GR', Denmark: 'DK', Norway: 'NO', Finland: 'FI', Ukraine: 'UA',
  'New Zealand': 'NZ', Peru: 'PE', Iraq: 'IQ', Iran: 'IR', Qatar: 'QA', Kuwait: 'KW', Oman: 'OM', Jordan: 'JO',
};
/** 常见简写、别名 → 标准国名 */
const COUNTRY_ALIAS: Record<string, string> = {
  USA: 'United States', US: 'United States', 'U.S.': 'United States', 'U.S.A.': 'United States', America: 'United States',
  'United States of America': 'United States', UK: 'United Kingdom', 'U.K.': 'United Kingdom', 'Great Britain': 'United Kingdom',
  Britain: 'United Kingdom', England: 'United Kingdom', UAE: 'United Arab Emirates', 'Ivory Coast': "Côte d'Ivoire",
  'Czech Republic': 'Czechia', Korea: 'South Korea', 'Republic of Korea': 'South Korea', Holland: 'Netherlands',
  'The Netherlands': 'Netherlands', 'Russian Federation': 'Russia', Turkiye: 'Türkiye', 'Hong Kong SAR': 'Hong Kong',
  'Mainland China': 'China', PRC: 'China', KSA: 'Saudi Arabia', 'DR Congo': 'Democratic Republic of the Congo', DRC: 'Democratic Republic of the Congo',
};
/** 别名统一成标准国名；认不出原样返回 */
export function canonicalCountry(country: string): string {
  const c = country.trim();
  return COUNTRY_ALIAS[c] ?? Object.keys(COUNTRY).find((k) => k.toLowerCase() === c.toLowerCase()) ?? c;
}
export function countryCode(country: string): string {
  return COUNTRY[canonicalCountry(country)] ?? 'XX';
}

/* ───────────── 产品规范化 ───────────── */

const INCOTERMS = new Set(['exw', 'fob', 'cif', 'cfr', 'ddp', 'dap', 'fca']);
const CURRENCIES = new Set(['usd', 'eur', 'cny', 'rmb', 'gbp']);
/** 这些词出现在贸易术语后面时是计价单位或档次，不是港口 */
const NOT_PORT = new Set(['per', 'set', 'sets', 'pc', 'pcs', 'piece', 'pieces', 'unit', 'units', 'pair', 'pairs', 'est']);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** price_tiers_fob_ningbo_11pc → { incoterm: FOB, port: Ningbo, variant: 11pc } */
function parseTierKey(key: string): { incoterm: string | null; port: string | null; variant: string | null; currency?: string } {
  const tokens = key.replace(/^price_tiers_?/, '').split('_').filter(Boolean);
  let incoterm: string | null = null;
  let port: string | null = null;
  let currency: string | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    if (!incoterm && INCOTERMS.has(t)) incoterm = t.toUpperCase();
    else if (!currency && CURRENCIES.has(t)) currency = t.toUpperCase();
    else if (incoterm && !port && /^[a-z]+$/.test(t) && !NOT_PORT.has(t) && rest.length === 0) port = cap(t);
    else rest.push(t);
  }
  return { incoterm, port, variant: rest.length ? rest.join('_') : null, ...(currency ? { currency } : {}) };
}

const MOQ_PRIMARY: [string, string][] = [
  ['moq_pcs', 'pcs'], ['moq_sets', 'sets'], ['moq_pairs', 'pairs'], ['moq', ''], ['moq_official', ''],
  ['moq_standard', ''], ['moq_pcs_per_sku', 'pcs/SKU'], ['moq_bulk_pcs', 'pcs'], ['moq_standard_color', ''],
];

export interface NormalizedProduct {
  product: Product;
  /** 归进 extra 的原始键（供人工复核） */
  extraKeys: string[];
}

export function normalizeProduct(legacy: Record<string, unknown>): NormalizedProduct {
  const src = { ...legacy };
  const take = (k: string) => {
    const v = src[k];
    delete src[k];
    return v;
  };
  const product: Product = { name: String(take('name') ?? '') };
  if ('model' in src) product.model = String(take('model'));
  if ('attributes' in src && src.attributes && typeof src.attributes === 'object') {
    product.attributes = take('attributes') as Record<string, unknown>;
  }
  if ('page_price' in src) product.page_price = take('page_price');

  // 价格档位
  const tiers: PriceTier[] = [];
  for (const key of Object.keys(src).filter((k) => /^price_tiers(_|$)/.test(k)).sort()) {
    const v = src[key];
    if (!Array.isArray(v) || !v.every((x) => x && typeof x === 'object' && 'unit_price' in x)) continue;
    const meta = parseTierKey(key);
    delete src[key];
    for (const raw of v as Record<string, unknown>[]) {
      const { min, max, unit_price, ...rest } = raw;
      tiers.push({
        min_qty: (min as number | null | undefined) ?? null,
        max_qty: (max as number | null | undefined) ?? null,
        unit_price: unit_price as number | string,
        currency: meta.currency ?? 'USD',
        incoterm: meta.incoterm,
        port: meta.port,
        variant: meta.variant,
        ...rest,
      });
    }
  }
  if (tiers.length) product.price_tiers = tiers;

  // 起订量：取第一个能认出的作主口径，其余留在 extra
  for (const [k, unit] of MOQ_PRIMARY) {
    const v = src[k];
    if (typeof v === 'number' || (typeof v === 'string' && v.trim())) {
      product.moq = { qty: v, ...(unit ? { unit } : {}) };
      delete src[k];
      break;
    }
  }

  // 交期
  const lt: NonNullable<Product['lead_time']> = {};
  if (typeof src.lead_time_days === 'number' || typeof src.lead_time_days === 'string') lt.bulk_days = take('lead_time_days') as number | string;
  if (typeof src.lead_time_sample_days === 'number') lt.sample_days = take('lead_time_sample_days') as number;
  if (typeof src.lead_time === 'string') lt.note = take('lead_time') as string;
  if (Object.keys(lt).length) product.lead_time = lt;

  // 包装
  const pk: NonNullable<Product['packing']> = {};
  const num = (k: string) => (typeof src[k] === 'number' || typeof src[k] === 'string' ? (take(k) as number | string) : undefined);
  const q = num('carton_qty');
  if (q !== undefined) pk.qty_per_carton = q;
  if (typeof src.carton_size_cm === 'string' || Array.isArray(src.carton_size_cm)) pk.carton_cm = take('carton_size_cm') as string;
  const g = num('carton_gross_kg');
  if (g !== undefined) pk.gross_kg = g;
  const n = num('carton_net_kg');
  if (n !== undefined) pk.net_kg = n;
  const cbm = num('carton_cbm');
  if (cbm !== undefined) pk.cbm = cbm;
  if (Object.keys(pk).length) product.packing = pk;

  // 认证：只收纯字符串数组
  if (Array.isArray(src.certifications) && src.certifications.every((c) => typeof c === 'string')) {
    product.certifications = (take('certifications') as string[]).map((name) => ({ name }));
  }

  if (src.surcharges && typeof src.surcharges === 'object' && !Array.isArray(src.surcharges)) {
    product.surcharges = take('surcharges') as Record<string, unknown>;
  }

  // 下划线说明原样保留在 product 上；其余一律进 extra
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith("_")) (product as unknown as Record<string, unknown>)[k] = v;
    else extra[k] = v;
  }
  if (Object.keys(extra).length) product.extra = extra;
  return { product, extraKeys: Object.keys(extra) };
}

/* ───────────── 题目 ───────────── */

type Legacy = Record<string, unknown> & {
  persona_variant_id: string;
  skeleton: Record<string, unknown> & { code: string; name: string; difficulty: string; session_type: string; tests: string };
  open_card: Record<string, unknown> & { country: string };
  product: Record<string, unknown>;
  hidden_card: Record<string, unknown>;
};

const TOP_KEEP = [
  'version', 'active', 'difficulty', 'open_card', 'leak_fallback', 'distractors', 'customs_capability', 'init_state',
  'rules_override', 'exit_lines', 'quote_reactions', 'followup_reactions', 'language_style', 'preset_elements',
];
const TOP_DROP = ['persona_variant_id', 'skeleton', 'product', 'hidden_card', 'exam_only', 'pool_type', 'pool_version'];

export interface MigrationReport {
  idMap: Record<string, string>;
  productExtraKeys: Record<string, string[]>;
  unresolvedDerivedFrom: Record<string, string>;
}

/** 把一批旧格式题目和背调包转成题库格式 v1。编号按「题型 + 国家」分组、按旧编号排序后连续编号 */
export function migrateLegacy(
  legacyPersonas: Legacy[],
  legacyBgs: Record<string, unknown>[],
  /** 旧题之间有时用文件名（如 P7-V1）而不是内部编号互相指认，这里给出 文件名 → 内部编号 */
  aliases: Record<string, string> = {},
): {
  personas: Persona[];
  bgPackages: BgPackage[];
  report: MigrationReport;
} {
  const report: MigrationReport = { idMap: {}, productExtraKeys: {}, unresolvedDerivedFrom: {} };

  // 1. 分配新编号
  const natural = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  const sorted = [...legacyPersonas].sort((a, b) => natural(a.persona_variant_id, b.persona_variant_id));
  const seq = new Map<string, number>();
  for (const p of sorted) {
    const t = typeFromLegacyCode(p.skeleton.code);
    if (!t) throw new Error(`${p.persona_variant_id}：旧题型 ${p.skeleton.code} 在考纲 v2 里没有对应`);
    const key = `${t.code}-${countryCode(p.open_card.country)}`;
    const n = (seq.get(key) ?? 0) + 1;
    seq.set(key, n);
    report.idMap[p.persona_variant_id] = `${key}-${String(n).padStart(3, '0')}`;
  }

  // 2. 逐题转换
  const personas: Persona[] = sorted.map((p) => {
    const t = typeFromLegacyCode(p.skeleton.code)!;
    const id = report.idMap[p.persona_variant_id]!;
    for (const k of Object.keys(p)) {
      if (!k.startsWith('_') && !TOP_KEEP.includes(k) && !TOP_DROP.includes(k)) {
        throw new Error(`${p.persona_variant_id}：不认识的字段 ${k}`);
      }
    }

    const { code: _code, name: _name, ...skRest } = p.skeleton;
    const skeleton = { type_code: t.code, name: t.name, ...skRest } as unknown as Persona['skeleton'];

    // 暗牌：各自的 _source 收拢到顶层
    const quotes: SourceNote['quotes'] = [];
    const hidden_card: Record<string, unknown> = {};
    for (const [k, card] of Object.entries(p.hidden_card)) {
      if (k.startsWith('_') || !card || typeof card !== 'object') {
        hidden_card[k] = card;
        continue;
      }
      const { _source, ...rest } = card as Record<string, unknown> & { _source?: Record<string, unknown> };
      hidden_card[k] = rest;
      if (_source) {
        quotes.push({
          card: k,
          ...(typeof _source.message === 'number' ? { message_index: _source.message } : {}),
          ...(typeof _source.quote === 'string' ? { quote: _source.quote } : {}),
          ...(_source.invented === true ? { invented: true } : {}),
          ...(typeof _source.why === 'string' ? { why: _source.why } : {}),
        });
      }
    }
    const slug =
      (typeof p._source_slug === 'string' && p._source_slug) ||
      /imports\/([a-z0-9][a-z0-9-]*)/i.exec(String(p._source_comment ?? ''))?.[1] ||
      null;

    const { product, extraKeys } = normalizeProduct(p.product);
    if (extraKeys.length) report.productExtraKeys[id] = extraKeys;

    const out: Record<string, unknown> = { id };
    if (typeof p._derived_from === 'string') {
      // 旧字段有时带说明文字，如「P7-V1（文件内 persona_variant_id 为 P7-US-001）」：逐个候选编号去认
      const candidates = [p._derived_from, ...(p._derived_from.match(/P\d+-[A-Z0-9]+(?:-[A-Z0-9]+)?/g) ?? [])];
      const parent = candidates.map((c) => report.idMap[c] ?? report.idMap[aliases[c] ?? '']).find(Boolean);
      if (parent) out.derived_from = parent;
      else report.unresolvedDerivedFrom[id] = p._derived_from;
    }
    out.skeleton = skeleton;
    out.pool_type = (p.pool_type === 'admission_exam' || p.exam_only === true ? 'admission_exam' : 'drill') as PoolType;
    for (const k of TOP_KEEP) if (k in p) out[k] = p[k];
    // 合并题型后，新题型的默认档位可能和这道题原来的档位不一样：把原档位写到题目上，实际难度不变
    if (out.difficulty === undefined && p.skeleton.difficulty !== t.default_difficulty) out.difficulty = p.skeleton.difficulty;
    out.product = product;
    out.hidden_card = hidden_card;
    out.verify_cases = p._verify_cases ?? [];
    if (slug || quotes.length) out._source = { material_id: slug, quotes } satisfies SourceNote;
    out._legacy_id = p.persona_variant_id;
    for (const [k, v] of Object.entries(p)) {
      if (!k.startsWith('_') || ['_verify_cases', '_source_slug', '_source_comment', '_derived_from'].includes(k)) continue;
      out[k] = v;
    }
    if (typeof p._derived_from === 'string' && !out.derived_from) out._legacy_derived_from = p._derived_from;
    return out as unknown as Persona;
  });

  // 3. 背调包
  const bgPackages: BgPackage[] = legacyBgs.map((b) => {
    const legacyId = String(b.variant_id);
    const pid = report.idMap[legacyId] ?? report.idMap[aliases[legacyId] ?? ''];
    if (!pid) throw new Error(`背调包 ${legacyId} 找不到对应的题`);
    const { variant_id: _v, ...rest } = b;
    return { persona_id: pid, ...rest, _legacy_id: legacyId } as unknown as BgPackage;
  });

  return { personas, bgPackages, report };
}
