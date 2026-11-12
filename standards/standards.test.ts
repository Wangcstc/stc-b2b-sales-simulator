import { describe, expect, it } from 'vitest';
import { FORCES, REDLINES, SYLLABUS, syllabusType, typeFromLegacyCode } from './index';

const ALL_FORCES = FORCES.map((f) => f.key);

describe('考纲 v3', () => {
  const types = SYLLABUS.types;

  it('共 55 型，编码唯一且按「阶段字母 + 两位序号」', () => {
    expect(types).toHaveLength(55);
    expect(new Set(types.map((t) => t.code)).size).toBe(55);
    for (const t of types) expect(t.code).toMatch(/^[A-G]\d{2}$/);
  });

  it('题型名一律五个字、以「型」结尾、不重名', () => {
    for (const t of types) {
      expect([...t.name]).toHaveLength(5);
      expect(t.name.endsWith('型')).toBe(true);
    }
    expect(new Set(types.map((t) => t.name)).size).toBe(55);
  });

  it('阶段字母与编码首字母一致', () => {
    for (const t of types) expect(t.stage).toBe(t.code[0]);
  });

  it('主考力 ⊆ 参与评分的力；参与 ∪ 不考 = 七力，且不重叠', () => {
    for (const t of types) {
      for (const k of t.key_forces) expect(t.active_forces).toContain(k);
      expect(t.active_forces.filter((f) => t.na_forces.includes(f))).toEqual([]);
      expect([...t.active_forces, ...t.na_forces].sort()).toEqual([...ALL_FORCES].sort());
    }
  });

  it('能进考试 ⇔ 不是风险识别型（G），而且落得进考试槽位（考纲 v3 起简单档询盘局只进演习）', () => {
    for (const t of types) {
      const diffs = [t.default_difficulty, ...t.also_difficulties];
      const slotable = t.session_type === 'followup' || diffs.some((d) => d === 'standard' || d === 'hard');
      expect(t.exam_eligible, t.code).toBe(t.stage !== 'G' && slotable);
    }
  });

  it('考纲 v1 的 P1–P32 每个都恰好映射到一个新题型，P10 与 P28 合并为 F04', () => {
    const all = types.flatMap((t) => t.legacy_codes);
    expect(all.sort()).toEqual(Array.from({ length: 32 }, (_, i) => `P${i + 1}`).sort());
    expect(typeFromLegacyCode('P10')?.code).toBe('F04');
    expect(typeFromLegacyCode('P28')?.code).toBe('F04');
    expect(typeFromLegacyCode('P22')?.name).toBe('技术尽调型');
  });

  it('每一型的规范八项都有内容', () => {
    for (const t of types) {
      for (const k of ['buyer_profile', 'tests', 'full_marks', 'typical_mistakes', 'material_signals', 'hidden_card_tips'] as const) {
        expect(t[k].length, `${t.code}.${k}`).toBeGreaterThan(4);
      }
    }
  });

  it('按编码能取到题型，取不存在的返回 undefined', () => {
    expect(syllabusType('A01')?.name).toBe('配合探需型');
    expect(syllabusType('Z99')).toBeUndefined();
  });
});

describe('七力与红线', () => {
  it('七力七个、红线四条', () => {
    expect(FORCES).toHaveLength(7);
    expect(REDLINES.map((r) => r.code)).toEqual(['R1', 'R2', 'R3', 'R4']);
  });
});
