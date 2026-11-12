import { describe, expect, it } from 'vitest';
import { countryCode, migrateLegacy, normalizeProduct, validatePersona } from './index';

describe('产品规范化', () => {
  it('价格档位的港口、贸易术语从键名里拆出来；起订量、交期、包装、认证归位；认不出的进 extra', () => {
    const { product, extraKeys } = normalizeProduct({
      model: 'X-1',
      name: 'Food Jar',
      price_tiers_fob_ningbo_11pc: [{ min: 500, max: 999, unit_price: 3.6 }],
      price_tiers_exw: [{ min: 1000, max: null, unit_price: 3.2, grade: 'B' }],
      price_tiers_fob_per_set: [{ min: 100, max: null, unit_price: 2.1 }],
      moq_pcs: 500,
      moq_custom_logo_pcs: 1000,
      lead_time_days: 30,
      carton_qty: 48,
      carton_size_cm: '52x38x30',
      carton_gross_kg: 14.5,
      certifications: ['LFGB'],
      surcharges: { color_box: 0.2 },
      his_spreadsheet: 'note',
      _trap_comment: 'keep',
    });
    expect(product.price_tiers).toEqual([
      { min_qty: 1000, max_qty: null, unit_price: 3.2, currency: 'USD', incoterm: 'EXW', port: null, variant: null, grade: 'B' },
      { min_qty: 500, max_qty: 999, unit_price: 3.6, currency: 'USD', incoterm: 'FOB', port: 'Ningbo', variant: '11pc' },
      { min_qty: 100, max_qty: null, unit_price: 2.1, currency: 'USD', incoterm: 'FOB', port: null, variant: 'per_set' },
    ]);
    expect(product.moq).toEqual({ qty: 500, unit: 'pcs' });
    expect(product.lead_time).toEqual({ bulk_days: 30 });
    expect(product.packing).toEqual({ qty_per_carton: 48, carton_cm: '52x38x30', gross_kg: 14.5 });
    expect(product.certifications).toEqual([{ name: 'LFGB' }]);
    expect(product.extra).toEqual({ moq_custom_logo_pcs: 1000, his_spreadsheet: 'note' });
    expect(extraKeys).toEqual(['moq_custom_logo_pcs', 'his_spreadsheet']);
    expect((product as unknown as Record<string, unknown>)._trap_comment).toBe('keep');
  });

  it('国家名转两位代码，认不出的用 XX', () => {
    expect(countryCode('Poland')).toBe('PL');
    expect(countryCode('Türkiye')).toBe('TR');
    expect(countryCode('Atlantis')).toBe('XX');
  });
});

describe('旧题迁移', () => {
  const legacy = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
    persona_variant_id: id,
    version: 'v1.0',
    skeleton: { code, name: '旧名', difficulty: 'standard', session_type: 'inquiry', tests: 't', active_forces: ['insight'], na_forces: [] },
    open_card: { name: 'A', country: 'Poland', company: 'C', inquiry_text: 'Hi' },
    product: { name: 'P', moq_pcs: 10 },
    hidden_card: {
      H1: { value: 'v', unlock: 'u', unlock_patterns: ['a', 'b'], leak_signals: [], _source: { quote: 'q', message: 4 } },
    },
    leak_fallback: 'bye',
    init_state: { patience: 80, trust: 50, interest: 70 },
    rules_override: {},
    exit_lines: { maxTurns: 'bye', patienceZero: null, stagnant: null },
    quote_reactions: { compliant: 'a', redline_R1: 'b', qty_mismatch: 'c', oneline_big_quote: 'd' },
    language_style: 'formal',
    _verify_cases: [{ card: 'H1', should: ['x'], shouldNot: ['y'] }],
    ...extra,
  });

  it('改编号、改题型、合并题池字段、收拢来源备注，结果通过结构校验', () => {
    const { personas, report } = migrateLegacy(
      [
        legacy('P22-PL-002', 'P22', { _source_comment: '改编自 imports/demo-material（77 条，06-09）' }) as never,
        legacy('P22-EX-001', 'P22', { exam_only: true, _derived_from: 'P22-V1（说明文字）' }) as never,
        legacy('P28-PL-001', 'P28') as never,
      ],
      [],
      { 'P22-V1': 'P22-PL-002' },
    );
    expect(report.idMap).toEqual({ 'P22-EX-001': 'A09-PL-001', 'P22-PL-002': 'A09-PL-002', 'P28-PL-001': 'F04-PL-001' });
    const [exam, base, merged] = personas;
    expect(exam!.pool_type).toBe('admission_exam');
    expect(exam!.derived_from).toBe('A09-PL-002');
    expect(base!.pool_type).toBe('drill');
    expect(base!.skeleton).toMatchObject({ type_code: 'A09', name: '技术尽调型' });
    expect(merged!.skeleton).toMatchObject({ type_code: 'F04', name: '返单博弈型' });
    // F04 默认困难；这道旧题原来是标准档，迁移后难度写在题目上，实际难度不变
    expect(merged!.difficulty).toBe('standard');
    expect(base!.difficulty).toBeUndefined();
    expect(base!._source).toEqual({ material_id: 'demo-material', quotes: [{ card: 'H1', message_index: 4, quote: 'q' }] });
    expect(JSON.stringify(base)).not.toMatch(/_source_comment|77 条/);
    expect(base!.verify_cases).toEqual([{ card: 'H1', should: ['x'], shouldNot: ['y'] }]);
    for (const p of personas) expect(validatePersona(p, p.id)).toEqual([]);
  });

  it('遇到不认识的字段直接报错，不悄悄丢掉', () => {
    expect(() => migrateLegacy([legacy('P1-PL-001', 'P1', { mystery: 1 }) as never], [])).toThrow(/不认识的字段 mystery/);
  });
});
