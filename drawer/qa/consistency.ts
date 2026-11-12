/**
 * 一致性：题目里的价格与产品表一致；买家说的话不出现中文。
 */
import type { Persona } from '../../bank-kit/index';
import type { Problem } from './regex';

export interface CatalogItem {
  model?: string;
  name: string;
  moq?: string;
  price_tiers?: { min_qty: number; unit_price: number; currency: string; incoterm: string; port?: string }[];
}

const CJK = /[一-龥]/;

/** 买家会原样说出口的文本里不许有中文（中文只能出现在说明类字段） */
export function checkBuyerLanguage(p: Persona): Problem[] {
  const lines: [string, string][] = [
    ['开场询盘', p.open_card.inquiry_text],
    ['收尾话', p.leak_fallback],
    ...Object.entries(p.exit_lines).map(([k, v]) => [`退出话术 ${k}`, v ?? ''] as [string, string]),
    ...Object.entries(p.quote_reactions).map(([k, v]) => [`报价反应 ${k}`, v ?? ''] as [string, string]),
    ...((p.distractors ?? []) as { code?: string; content?: string }[]).map((d) => [`干扰项 ${d.code ?? ''}`, d.content ?? ''] as [string, string]),
  ];
  // 跟进局的开场询盘里有给业务员看的中文情境说明，只查非情境部分不现实——跟进局开场整段豁免
  return lines
    .filter(([where]) => !(where === '开场询盘' && p.skeleton.session_type === 'followup'))
    .filter(([, text]) => CJK.test(text))
    .map(([where]) => ({ level: '✗' as const, what: `${where} 是买家会说的话，却出现了中文` }));
}

/** 题目产品与产品表对得上：型号在表里的，价格档位必须一模一样 */
export function checkPriceConsistency(p: Persona, catalog: CatalogItem[] | undefined): Problem[] {
  if (!catalog?.length || !p.product.model) return [];
  const item = catalog.find((c) => c.model && c.model === p.product.model);
  if (!item) return [];
  const want = (item.price_tiers ?? []).map((t) => `${t.min_qty}:${t.unit_price}:${t.incoterm}`).sort();
  const got = (p.product.price_tiers ?? []).map((t) => `${t.min_qty ?? ''}:${t.unit_price}:${t.incoterm ?? ''}`).sort();
  if (want.length && JSON.stringify(want) !== JSON.stringify(got)) {
    return [{ level: '✗', what: `产品 ${p.product.model} 的价格档位与产品表不一致（产品表：${want.join('，')}；题目：${got.join('，') || '无'}）` }];
  }
  return [];
}
