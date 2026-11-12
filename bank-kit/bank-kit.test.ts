import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCoverage,
  examReadiness,
  lintPersona,
  readBank,
  stripNotes,
  validateBank,
  validatePersona,
  writeBank,
  type BgPackage,
  type Persona,
} from './index';

const tmp = () => mkdtempSync(join(tmpdir(), 'bank-kit-'));

function persona(over: Partial<Persona> = {}): Persona {
  const cards = ['H1', 'H2', 'H3', 'H4'];
  return {
    id: 'A09-PL-001',
    skeleton: {
      type_code: 'A09',
      name: '技术尽调型',
      session_type: 'inquiry',
      difficulty: 'standard',
      tests: '规格与合规问题正面接住',
      active_forces: ['insight', 'guidance', 'solution', 'trust', 'closing'],
      na_forces: ['negotiation', 'stability'],
    },
    pool_type: 'admission_exam',
    open_card: { name: 'Tomasz W.', country: 'Poland', company: 'Example Supply', inquiry_text: 'Please send the certificate.' },
    product: { name: 'Safety Shoe', price_tiers: [{ min_qty: 500, unit_price: 12.5, currency: 'USD', incoterm: 'FOB', port: 'Ningbo' }] },
    hidden_card: Object.fromEntries(
      cards.map((c) => [c, { value: `secret ${c}`, unlock: 'ask', unlock_patterns: ['a', 'b'], leak_signals: ['x'] }]),
    ),
    leak_fallback: 'Please just send the offer.',
    init_state: { patience: 80, trust: 55, interest: 70 },
    exit_lines: { maxTurns: 'I will come back to you.', patienceZero: null, stagnant: null },
    quote_reactions: { compliant: 'OK', redline_R1: 'Hmm', qty_mismatch: 'Not this qty', oneline_big_quote: 'Details?' },
    language_style: 'Short and formal.',
    verify_cases: cards.map((c) => ({ card: c, should: ['q1', 'q2', 'q3'], shouldNot: ['n1', 'n2'] })),
    _source: { material_id: 'm-001', quotes: [{ card: 'H1', message_index: 3 }] },
    _comment: '设计说明',
    ...over,
  };
}

const bg = (personaId: string): BgPackage => ({ persona_id: personaId, ai_report: {}, website: {}, social: {}, contacts: {} });

function write(personas: Persona[], bgs: BgPackage[] = []) {
  const dir = tmp();
  writeBank(dir, { personas, bgPackages: bgs, bankId: 'bank-test0001', bankVersion: '1.0.0', drawerVersion: '8.1.0' });
  return dir;
}

describe('写出与校验', () => {
  it('合格的题库包能通过校验，并能原样读回', () => {
    const dir = write([persona(), persona({ id: 'A09-PL-002', derived_from: 'A09-PL-001', pool_type: 'drill' })], [bg('A09-PL-001')]);
    const r = validateBank(dir);
    expect(r.errors).toEqual([]);
    const bank = readBank(dir);
    expect(bank.personas.map((p) => p.id)).toEqual(['A09-PL-001', 'A09-PL-002']);
    expect(bank.manifest.counts).toMatchObject({ total: 2, drill: 1, admission_exam: 1, bg_packages: 1 });
  });

  it('题库包一经写出不再修改：往非空目录写会被拒绝', () => {
    const dir = write([persona()]);
    expect(() => writeBank(dir, { personas: [persona()], bgPackages: [], bankId: 'bank-test0001', bankVersion: '1.0.1', drawerVersion: '8.1.0' })).toThrow(/不是空的/);
  });

  it('换行被 Windows 改成 CRLF（内容没变）照样通过校验', () => {
    const dir = write([persona()], [bg('A09-PL-001')]);
    for (const rel of ['personas/A09-PL-001.json', 'bg-packages/A09-PL-001.json', 'manifest.json', 'checksums.json']) {
      const f = join(dir, rel);
      writeFileSync(f, readFileSync(f, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toContain('\r\n');
    expect(validateBank(dir).errors).toEqual([]);
  });

  it('打包后改过任何文件，校验和对不上', () => {
    const dir = write([persona()]);
    const f = join(dir, 'personas/A09-PL-001.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace('Short and formal.', 'Changed.'));
    expect(validateBank(dir).errors.some((e) => e.message.includes('校验和'))).toBe(true);
  });

  it('题型编码不在考纲里、题型名写错，都不通过', () => {
    const p = persona({ skeleton: { ...persona().skeleton, type_code: 'Z99' } });
    expect(validateBank(write([p])).errors.some((e) => e.message.includes('不在考纲'))).toBe(true);
    const q = persona({ skeleton: { ...persona().skeleton, name: '技术型' } });
    expect(validateBank(write([q])).errors.some((e) => e.message.includes('题型名应为'))).toBe(true);
  });

  it('风险识别型放进考试池，不通过', () => {
    const p = persona({ id: 'G01-NG-001', skeleton: { ...persona().skeleton, type_code: 'G01', name: '诈骗钓鱼型' } });
    expect(validateBank(write([p])).errors.some((e) => e.message.includes('暂不进考试'))).toBe(true);
  });

  it('母题、背调包、暗牌前置牌、验证用例的引用断了，不通过', () => {
    const p = persona({ derived_from: 'A09-PL-999' });
    p.verify_cases = [...p.verify_cases, { card: 'H9', should: [], shouldNot: [] }];
    (p.hidden_card.H2 as { requires?: string[] }).requires = ['H8'];
    const msgs = validateBank(write([p], [bg('A09-PL-777')])).errors.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/母题 A09-PL-999/);
    expect(msgs).toMatch(/对应的题 A09-PL-777/);
    expect(msgs).toMatch(/前置牌 H8/);
    expect(msgs).toMatch(/验证用例指向的暗牌 H9/);
  });

  it('编号格式不对、缺必填字段，结构校验不通过', () => {
    expect(validatePersona({ ...persona(), id: 'P22-EX-001' }).length).toBeGreaterThan(0);
    const { language_style: _drop, ...noStyle } = persona();
    expect(validatePersona(noStyle).some((e) => e.message.includes('language_style'))).toBe(true);
  });

  it('更新的格式主版本拒绝装入', () => {
    const dir = write([persona()]);
    const m = join(dir, 'manifest.json');
    writeFileSync(m, readFileSync(m, 'utf8').replace('"format_version": 1', '"format_version": 2'));
    expect(validateBank(dir).errors[0]?.message).toMatch(/请先升级柜子/);
  });
});

describe('考纲覆盖', () => {
  it('只有考试池、且题型允许进考试的题计入考试槽位', () => {
    const cov = computeCoverage([
      persona(),
      persona({ id: 'A09-PL-002', difficulty: 'hard' }),
      persona({ id: 'A09-PL-003', pool_type: 'drill' }),
      persona({ id: 'B03-US-001', skeleton: { ...persona().skeleton, type_code: 'B03', name: '报价沉默型', session_type: 'followup' } }),
    ]);
    expect(cov.slots).toEqual({
      STANDARD_INQUIRY: { types: 1, questions: 1 },
      HARD_INQUIRY: { types: 1, questions: 1 },
      FOLLOWUP: { types: 1, questions: 1 },
    });
    expect(cov.by_type.A09).toEqual({ total: 3, drill: 1, admission_exam: 2 });
    expect(cov.missing_types).toHaveLength(53);
  });

  it('考试按槽位提示还差多少题、多少题型，并列出这个槽里还没有的题型', () => {
    const r = examReadiness([persona(), persona({ id: 'A09-PL-002', difficulty: 'hard' })], { questions: 1, types: 1 });
    expect(r.map((s) => [s.slot, s.questions, s.ready])).toEqual([
      ['STANDARD_INQUIRY', 1, true],
      ['HARD_INQUIRY', 1, true],
      ['FOLLOWUP', 0, false],
    ]);
    const hard = r.find((s) => s.slot === 'HARD_INQUIRY')!;
    // 身份存疑型默认就是困难档，还没有 → 列出来；已有的 A09 不列
    expect(hard.missingTypes.map((t) => t.code)).toContain('A03');
    expect(hard.missingTypes.map((t) => t.code)).not.toContain('A09');
    // 只进演习的题型（A01 配合探需型）不出现在任何槽的缺口里
    expect(r.flatMap((s) => s.missingTypes.map((t) => t.code))).not.toContain('A01');
    // 不传门槛就用标准层的默认值
    expect(examReadiness([])[0]!.needQuestions).toBe(14);
  });
});

describe('导出剥注与质量提醒', () => {
  it('不带来源备注：所有下划线字段递归剥掉，其余不动', () => {
    const p = persona();
    (p.hidden_card.H1 as Record<string, unknown>)._unlock_note = 'note';
    const s = stripNotes(p);
    expect(JSON.stringify(s)).not.toMatch(/"_/);
    expect(s.hidden_card.H1).toMatchObject({ value: 'secret H1' });
    expect(validatePersona(s)).toEqual([]);
  });

  it('质量门槛不达标只出提醒', () => {
    const p = persona();
    p.verify_cases[0] = { card: 'H1', should: ['only one'], shouldNot: [] };
    const warns = lintPersona(p);
    expect(warns.some((w) => w.includes('应解锁'))).toBe(true);
    expect(warns.some((w) => w.includes('不应解锁'))).toBe(true);
  });
});
