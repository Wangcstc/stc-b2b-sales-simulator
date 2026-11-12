/**
 * 抽屉端到端：拿样品原材料走一遍全流程，模型换成 FakeLlm（按样品题回放，不花钱、完全确定）。
 *
 * 能证明的：投料、脱敏、选择题卡、归型、起草组装、质检闸门、变体、分池、打包这些代码路径
 * 全部接得上，产出的题库包柜子能直接装。
 * 不能证明的：真模型出的题好不好——那要用真模型跑（需求文档 14.10），这里不花这个钱。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBank, validateBank, type Persona } from '../bank-kit/index';
import {
  Store,
  answer,
  answerAllRecommended,
  createBatch,
  ingest,
  pack,
  readCompanySheet,
  readProductSheet,
  run,
  checkRegex,
  runGates,
  status,
  type Llm,
  type LlmRequest,
  type LlmResponse,
  type RawChat,
} from './index';

const ROOT = resolve(__dirname, '..');
const SAMPLES = join(ROOT, 'samples');
const readJson = <T>(p: string) => JSON.parse(readFileSync(p, 'utf8')) as T;
const samplePersonas = readdirSync(join(SAMPLES, 'src/personas')).map((f) => readJson<Persona>(join(SAMPLES, 'src/personas', f)));
const catalog = readJson<{ sku: string; model: string }[]>(join(SAMPLES, 'src/products.json'));

/** 聊天导出件 S01…S08 ↔ 样品题（样品题的 _source.material_id 是 sample-S0x） */
const personaOfFile = (file: string) => samplePersonas.find((p) => p._source?.material_id === `sample-${file.slice(0, 3)}`)!;

const ALT = [
  { country: 'Netherlands', name: 'Daan Visser', company: 'Visser Buitensport B.V.' },
  { country: 'Italy', name: 'Marco Bellini', company: 'Bellini Outdoor S.r.l.' },
];

class FakeLlm implements Llm {
  calls: Record<string, number> = {};
  constructor(private byMaterial: Map<string, Persona>) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls[req.purpose] = (this.calls[req.purpose] ?? 0) + 1;
    const body = (o: unknown): LlmResponse => ({ text: '```json\n' + JSON.stringify(o) + '\n```', inputTokens: 1000, outputTokens: 500, model: 'fake-pro' });
    if (req.purpose === 'triage' || req.purpose === 'draft') {
      const p = this.byMaterial.get(req.tag!)!;
      if (req.purpose === 'triage') {
        return body({
          type_code: p.skeleton.type_code,
          confidence: 0.9,
          reason: '回放样品题',
          candidates: (p._source?.quotes ?? []).map((q) => ({ fact: q.card, message_index: q.message_index, quote: q.quote })),
          alt_types: [],
        });
      }
      const { id: _i, skeleton, product, _source, pool_type: _p, ...rest } = p as Persona & Record<string, unknown>;
      return body({
        ...rest,
        product_sku: catalog.find((c) => c.model === product.model)!.sku,
        product_surcharges: product.surcharges,
        difficulty: skeleton.difficulty,
        tests: skeleton.tests,
        source_quotes: _source!.quotes,
      });
    }
    if (req.purpose === 'variant') {
      const mother = JSON.parse(req.user.split('## 母题\n')[1]!.split('\n\n字段说明')[0]!) as Record<string, unknown> & { open_card: Record<string, string> & { name: string; inquiry_text: string } };
      const i = Number(/第 (\d+) 个变体/.exec(req.user)![1]) - 1;
      const alt = ALT[i % ALT.length]!;
      const first = mother.open_card.name.split(' ')[0]!;
      return body({
        ...mother,
        open_card: {
          ...mother.open_card,
          ...alt,
          email: `${alt.name.split(' ')[0]!.toLowerCase()}@example.example`,
          inquiry_text: mother.open_card.inquiry_text.split(first).join(alt.name.split(' ')[0]!),
        },
      });
    }
    if (req.purpose === 'bg') {
      const { persona_id: _id, ...bg } = readJson<Record<string, unknown>>(join(SAMPLES, 'src/bg-packages/A03-GB-001.json'));
      // 报告正文里换上这道题的买家名，否则「报告没写到买家」会报提醒
      const name = /"name": "([^"]+)"/.exec(req.user)![1]!;
      return body(JSON.parse(JSON.stringify(bg).replace(/Daniel Hart/g, name)));
    }
    // revise：原样返回（样品题本来就过闸，走到这里说明测试本身有问题）
    const cur = JSON.parse(req.user.split(/## 当前题目[^\n]*\n/)[1]!.split('\n\n字段说明')[0]!) as Record<string, unknown>;
    return body(cur);
  }
}

let dir: string;
let store: Store;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'drawer-'));
  store = new Store(join(dir, 'drawer'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('原材料表', () => {
  it('样品产品表、公司信息表读出来与真源一致', async () => {
    expect(await readProductSheet(join(SAMPLES, 'raw-materials/产品表-样品.xlsx'))).toEqual(readJson(join(SAMPLES, 'src/products.json')));
    expect(await readCompanySheet(join(SAMPLES, 'raw-materials/公司信息-样品.xlsx'))).toEqual(readJson(join(SAMPLES, 'src/company.json')));
  });
});

describe('质检闸门', () => {
  it('8 道样品题全部过闸（新题的硬门槛对样品同样成立）', () => {
    const products = readJson<never[]>(join(SAMPLES, 'src/products.json'));
    for (const p of samplePersonas) {
      const id = p._source!.material_id!;
      const m = readJson<{ chat: { messages: { text: string; textCn?: string }[] } }>(join(SAMPLES, 'redacted', id, 'redacted.json'));
      const g = runGates(p, { text: m.chat.messages.map((x) => x.text), textCn: m.chat.messages.map((x) => x.textCn ?? '') }, products);
      expect(g.problems.filter((x) => x.level === '✗'), p.id).toEqual([]);
      expect(g.index).not.toBeNull();
    }
  });
});

describe('抽屉全流程（FakeLlm）', () => {
  const batchId = 'test-batch';
  let llm: FakeLlm;

  it('投料：8 份聊天 + 两张表；疑似漏网的人名出选择题卡，原始件暂留', async () => {
    createBatch(store, batchId, { variantsPerMother: 1 });
    const r = await ingest(store, batchId, [join(SAMPLES, 'raw-materials/chats'), join(SAMPLES, 'raw-materials/产品表-样品.xlsx'), join(SAMPLES, 'raw-materials/公司信息-样品.xlsx')]);
    expect(r).toMatchObject({ chats: 8, products: 3, company: true });
    const s = status(store, batchId);
    const cards = s.pendingReviews.filter((c) => c.kind === 'redact_suspect');
    // 每张卡都是 3 个选项 + 其他，推荐项排第一
    for (const c of cards) {
      expect(c.options).toHaveLength(4);
      expect(c.options[0]!.recommended).toBe(true);
      expect(c.options[3]!.key).toBe('other');
      // 样品里的疑似词全是认证缩写和型号前缀（FCC、MSDS、LT-），推荐放行
      expect(c.options[0]!.key).toBe('pass');
    }
    expect(cards.length).toBeGreaterThan(0);
    expect((s.items.blocked ?? 0) + (s.items.redacted ?? 0)).toBe(8);
  });

  it('疑似漏网确认为噪音 → 放行；脱敏后原始件从收件箱删除', () => {
    for (const c of status(store, batchId).pendingReviews) answer(store, batchId, c.id, 'pass');
    const s = status(store, batchId);
    expect(s.items).toEqual({ redacted: 8 });
    expect(readdirSync(store.inboxDir(batchId))).toEqual([]);
    // 公开素材有独立的样品编号。核对发送人映射后，比对其余结构和对话。
    const b = store.getBatch(batchId);
    const files = b.items.map((id) => store.getItem(batchId, id));
    for (const it of files) {
      const { chat } = store.getMaterial<{ chat: RawChat }>(batchId, it.materialId)!;
      const { chat: sample } = readJson<{ chat: RawChat }>(join(SAMPLES, 'redacted', `sample-${it.file.slice(0, 3)}`, 'redacted.json'));
      const messages = chat.messages.map((message) => {
        const field = message.side === 'client' ? '客户' : '负责人';
        expect(message.sender).toBe(chat.header[field]);
        return { ...message, sender: sample.header[field] };
      });
      expect({
        ...chat,
        source: { ...chat.source, file: sample.source.file },
        header: { ...chat.header, 客户: sample.header['客户'], 负责人: sample.header['负责人'] },
        customer: chat.customer && {
          ...chat.customer,
          fields: { ...chat.customer.fields, 公司名称: sample.customer?.fields['公司名称'] },
        },
        messages,
      }, it.file).toEqual(sample);
    }
    llm = new FakeLlm(new Map(files.map((it) => [it.materialId, personaOfFile(it.file)])));
  });

  it('加工可以分段跑：先跑 3 份，再跑剩下的，不重复调用', async () => {
    const r1 = await run(store, batchId, llm, { limit: 3 });
    expect(r1.processed).toBe(3);
    expect(llm.calls).toEqual({ triage: 3, draft: 3 });
    await run(store, batchId, llm);
    expect(llm.calls).toEqual({ triage: 8, draft: 8, bg: 1 }); // 只有身份存疑型配背调包
    const s = status(store, batchId);
    expect(s.items).toEqual({ drafted: 8 });
    expect(s.questions).toEqual({ awaiting_review: 8 });
  });

  it('审题单：每道待确认的题一节，带确认卡号和复查结果', async () => {
    const { reviewSheet } = await import('./index');
    const pendingBefore = status(store, batchId).pendingReviews.length;
    const { markdown, count } = reviewSheet(store, batchId);
    expect(count).toBe(status(store, batchId).questions.awaiting_review ?? 0);
    expect(count).toBe(8);
    expect(markdown).toContain('### 暗牌');
    expect(markdown).toContain('机器看不出来、请你看');
    expect(markdown.match(/\| ✓ \|/g)).toHaveLength(8);
    expect(status(store, batchId).pendingReviews.length).toBe(pendingBefore); // 只读，不改状态
  });

  it('母题按推荐采用后衍生考试变体；考试题的卡不能批量处理', async () => {
    const done = answerAllRecommended(store, batchId);
    expect(done).toHaveLength(8); // 母题都在演习池，可以批量
    await run(store, batchId, llm);
    const s = status(store, batchId);
    const exam = s.pendingReviews.filter((c) => c.kind === 'use_question');
    expect(exam.length).toBeGreaterThan(0);
    expect(exam.every((c) => !c.batchable)).toBe(true);
    expect(answerAllRecommended(store, batchId)).toHaveLength(0);
    // 简单档询盘局（配合探需型）落不进任何考试槽位：不衍生变体
    const a01 = store.getBatch(batchId).items.map((id) => store.getItem(batchId, id)).find((it) => it.questions[0]?.persona.skeleton.type_code === 'A01')!;
    expect(a01.questions).toHaveLength(1);
    for (const c of exam) answer(store, batchId, c.id, 'accept');
    expect(status(store, batchId).items).toEqual({ done: 8 });
  });

  it('打包：题库包校验通过；母题进演习、变体进考试；在旧题库上加题时撞号顺延；版本号不许复用', () => {
    const r = pack(store, [batchId], { bankVersion: '1.0.0', bankId: 'bank-test0001', outRoot: join(dir, 'banks') });
    expect(validateBank(r.dir).ok).toBe(true);
    const bank = readBank(r.dir);
    expect(bank.manifest.generator).toBe('drawer');
    expect(bank.personas.filter((p) => p.pool_type === 'drill')).toHaveLength(8);
    expect(bank.personas.filter((p) => p.pool_type === 'admission_exam').every((p) => p.derived_from)).toBe(true);
    expect(bank.products).toEqual(readJson(join(SAMPLES, 'src/products.json')));
    // 身份存疑型（考纲标了配背调包）：母题和变体各一份，编号跟着题走
    const a03 = bank.personas.filter((p) => p.skeleton.type_code === 'A03').map((p) => p.id).sort();
    expect(bank.bgPackages.map((g) => g.persona_id).sort()).toEqual(a03);
    expect(a03.length).toBe(2);
    // 演习不设下限，有几道算几道；考试按槽位提示（样品只有 8 道母题，三个槽位都凑不齐，但照常打包）
    expect(r.drill).toBe(8);
    expect(r.exam.map((s) => s.slot)).toEqual(['STANDARD_INQUIRY', 'HARD_INQUIRY', 'FOLLOWUP']);
    expect(r.exam.every((s) => !s.ready && s.needQuestions === 14)).toBe(true);

    const r2 = pack(store, [batchId], { bankVersion: '1.1.0', base: join(SAMPLES, 'bank'), outRoot: join(dir, 'banks') });
    expect(validateBank(r2.dir).ok).toBe(true);
    expect(Object.keys(r2.renumbered).length).toBeGreaterThan(0);
    expect(r2.manifest.counts.total).toBe(8 + bank.personas.length);
    expect(() => pack(store, [batchId], { bankVersion: '1.1.0', base: join(SAMPLES, 'bank'), outRoot: join(dir, 'banks') })).toThrow(/只增不减/);
  });

  it('预算到了就暂停并出卡；追加预算后从断点接着跑', async () => {
    process.env.PRICE_PRO_IN_MISS = '1000';
    process.env.PRICE_PRO_OUT = '1000';
    process.env.DRAWER_MODEL_DRAFT = 'fake-pro';
    try {
      const id = 'test-budget';
      createBatch(store, id, { variantsPerMother: 0, budgetCny: 1 });
      await ingest(store, id, [join(SAMPLES, 'raw-materials/chats/S01-jonas-weber.html'), join(SAMPLES, 'raw-materials/chats/S02-mark-ellison.html'), join(SAMPLES, 'raw-materials/产品表-样品.xlsx')]);
      for (const c of status(store, id).pendingReviews) answer(store, id, c.id, 'pass');
      const items = store.getBatch(id).items.map((x) => store.getItem(id, x));
      const fake = new FakeLlm(new Map(items.map((it) => [it.materialId, personaOfFile(it.file)])));
      const r = await run(store, id, fake);
      expect(r.status).toBe('paused');
      const card = status(store, id).pendingReviews.find((c) => c.kind === 'budget')!;
      expect(card.options[0]!.key).toBe('raise');
      answer(store, id, card.id, 'other', '100');
      const r2 = await run(store, id, fake);
      expect(r2.status).toBe('open');
      expect(status(store, id).questions).toEqual({ awaiting_review: 2 });
    } finally {
      delete process.env.PRICE_PRO_IN_MISS;
      delete process.env.PRICE_PRO_OUT;
      delete process.env.DRAWER_MODEL_DRAFT;
    }
  });
});

describe('模型输出的正则规范化', () => {
  it('JS 字面量 /…/i 剥成纯字符串；说明字段与其他内容不动', async () => {
    const { normalizePatterns } = await import('./index');
    const out = normalizePatterns({
      _note: '/keep/',
      H1: { value: 'v', unlock: 'u', unlock_patterns: ['/\\bhow many\\b/i', 'plain', ' /a|b/ '], leak_signals: ['/x/'] },
    }) as Record<string, { unlock_patterns: string[]; leak_signals: string[] }>;
    expect(out.H1!.unlock_patterns).toEqual(['\\bhow many\\b', 'plain', 'a|b']);
    expect(out.H1!.leak_signals).toEqual(['/x/']);
    // 内联标志 (?i) 去掉；泄露信号里的转义反斜杠去掉（按字面匹配）
    const more = normalizePatterns({ H2: { unlock_patterns: ['(?i)\\bhow many (sets|pieces)\\b'], leak_signals: ['50\\+50', 'products \\+ shipping', 'U.S.'] } }) as Record<string, { unlock_patterns: string[]; leak_signals: string[] }>;
    expect(more.H2!.unlock_patterns).toEqual(['\\bhow many (sets|pieces)\\b']);
    expect(more.H2!.leak_signals).toEqual(['50+50', 'products + shipping', 'U.S.']);
    expect(out._note).toBe('/keep/');
  });
});

describe('给模型的素材正文', () => {
  it('日期变了插分隔行并写明隔了几天', async () => {
    const { parseChatFile } = await import('./index');
    const { materialText } = await import('./prompt-build');
    const t = materialText(parseChatFile(join(SAMPLES, 'raw-materials/chats/S07-ryan-cole.html')));
    expect(t).toContain('—— 2026-01-05 ——');
    expect(t).toContain('—— 2026-01-14（距上一条消息 6 天） ——');
    expect(t).toMatch(/\[0\] 买家：Please send 2 samples/);
  });
});

describe('跟进局前情规范化', () => {
  it('「quantity: 300 pcs」剥成六要素代码，认不出的留给质检报错', async () => {
    const { normalizePreset } = await import('./pipeline');
    expect(normalizePreset(['quantity: 300 pcs', 'address', 'Address：UK', 'Price USD 11.60'])).toEqual(['quantity', 'address', 'Price USD 11.60']);
  });
});

describe('变体对母题的检查', () => {
  it('编号与依赖一致即可，键名后缀可以跟内容改；几乎没改写的给提醒', async () => {
    const { checkVariant } = await import('./index');
    const mother = structuredClone(samplePersonas.find((p) => p.id === 'A01-DE-001')!);
    const same = structuredClone(mother);
    expect(checkVariant(mother, same).map((x) => x.level)).toEqual(['⚠']);
    const renamed = structuredClone(mother);
    const cards = renamed.hidden_card as Record<string, { value: string }>;
    cards.H1_use_hire = { ...cards.H1_use_rental!, value: '他们给婚礼活动公司供货，椅子一次用一个周末就收回仓库，外观比承重更重要' };
    delete cards.H1_use_rental;
    for (const v of renamed.verify_cases) if (v.card === 'H1_use_rental') v.card = 'H1_use_hire';
    for (const [k, c] of Object.entries(cards)) if (k !== 'H1_use_hire') c.value = `完全不同的内容 ${k} ${'新'.repeat(20)}`;
    expect(checkVariant(mother, renamed)).toEqual([]);
    const fewer = structuredClone(mother);
    delete (fewer.hidden_card as Record<string, unknown>).H5_forwarder;
    expect(checkVariant(mother, fewer)[0]!.level).toBe('✗');
  });
});

describe('投料：已脱敏的素材', () => {
  it('公开样品的身份字段和发送人只用样品编号', () => {
    for (const persona of samplePersonas) {
      const materialId = persona._source?.material_id;
      if (!materialId) throw new Error(`样品 ${persona.id} 缺少来源编号`);
      const sampleId = materialId.replace(/^sample-/, '');
      const { chat } = readJson<{ chat: RawChat }>(join(SAMPLES, 'redacted', materialId, 'redacted.json'));
      const buyer = `示例买家 ${sampleId}`;
      expect(chat.header['客户']).toBe(buyer);
      expect(chat.header['负责人']).toBe('示例业务员');
      expect(chat.customer?.fields['公司名称']).toBe(`示例买家公司 ${sampleId}`);
      expect(chat.source.file).toBe(`${materialId}.html`);
      for (const message of chat.messages) {
        expect(message.sender).toBe(message.side === 'client' ? buyer : '示例业务员');
      }
    }
  });

  it('目录里有 redacted.json 就当已脱敏素材：名字不再换，只补跑模式规则与本批词表；疑似漏网照样出卡', async () => {
    const id = 'test-pre';
    createBatch(store, id, { maskTerms: ['Bavaria'] });
    const r = await ingest(store, id, [join(SAMPLES, 'redacted/sample-S01'), join(SAMPLES, 'redacted/sample-S02/redacted.json')]);
    expect(r).toMatchObject({ chats: 2, preRedacted: 2 });
    // S02 里有 FCC（认证缩写）→ 疑似漏网卡，推荐放行
    const cards = status(store, id).pendingReviews;
    expect(cards.map((c) => c.options[0]!.key)).toEqual(['pass']);
    for (const c of cards) answer(store, id, c.id, 'pass');
    expect(status(store, id).items).toEqual({ redacted: 2 });
    const s01 = store.getMaterial<{ chat: { messages: { text: string }[]; header: Record<string, string> } }>(id, 'test-pre-m001')!.chat;
    // 名字没被再换一遍；本批词表里的词抹掉了
    expect(s01.header['客户']).toBe(readJson<{ chat: { header: Record<string, string> } }>(join(SAMPLES, 'redacted/sample-S01/redacted.json')).chat.header['客户']);
    expect(s01.messages.map((m) => m.text).join(' ')).not.toContain('Bavaria');
    expect(s01.messages.map((m) => m.text).join(' ')).toContain('[已脱敏]');
    expect(readdirSync(store.inboxDir(id))).toEqual([]);
    expect((await ingest(store, id, [join(SAMPLES, 'redacted/sample-S01')])).duplicates).toBe(1);
  });
});

describe('模型调用失败', () => {
  it('余额不足：批次回到可续跑状态，原因写进日志，已完成的不丢', async () => {
    const id = 'test-402';
    createBatch(store, id);
    await ingest(store, id, [join(SAMPLES, 'redacted/sample-S01'), join(SAMPLES, 'raw-materials/产品表-样品.xlsx')]);
    const broke: Llm = { complete: async () => { throw new Error('402 Insufficient Balance'); } };
    await expect(run(store, id, broke)).rejects.toThrow(/余额不足/);
    const b = store.getBatch(id);
    expect(b.status).toBe('open');
    expect(b.log.at(-1)!.msg).toMatch(/余额不足/);
    expect(status(store, id).items).toEqual({ redacted: 1 });
  });
});

describe('质检闸门遇到编译不过的正则', () => {
  it('报硬问题，不抛异常（一道题不能打断整批加工）', () => {
    const p = structuredClone(samplePersonas.find((x) => x.id === 'A01-DE-001')!);
    (p.hidden_card as Record<string, { unlock_patterns: string[] }>).H1_use_rental!.unlock_patterns.push('(?i)broken(');
    const g = runGates(p, null, undefined);
    expect(g.problems.some((x) => x.level === '✗' && /编译不过/.test(x.what))).toBe(true);
  });
});

describe('泄露信号卫生', () => {
  it('正常文字里的 + ? ( ) 不算正则；\\b、|、.* 这类才报', () => {
    const p = structuredClone(samplePersonas.find((x) => x.id === 'A01-DE-001')!);
    const c = (p.hidden_card as Record<string, { leak_signals: string[] }>).H2_quantity_split!;
    c.leak_signals = ['400 black', '50+50 split', 'really?', '(FOB)'];
    expect(checkRegex(p).filter((x) => /泄露信号/.test(x.what) && x.level === '✗')).toEqual([]);
    c.leak_signals = ['\\b400\\b', 'black|green', 'black.*green'];
    expect(checkRegex(p).filter((x) => /泄露信号/.test(x.what) && x.level === '✗')).toHaveLength(3);
  });
});

describe('脱敏：货件号与运单号', () => {
  it('FBA 货件号、字母数字混排的运单号抹掉；产品型号、认证号不误伤', async () => {
    const { createRedactor } = await import('./index');
    const chat = {
      source: { file: 'x.html', exporterVersion: null },
      header: { 客户: 'Ann Lee', 地区: 'United States' },
      customer: null, okki: null, profile: null, buying: null, order: null,
      messages: [{ date: null, side: 'client' as const, sender: 'Ann Lee', time: '', kind: 'text' as const, attachments: [],
        text: 'Shipment FBA15TEST0001 ready, tracking 1Z999AA10123456784 and LY123456789CN. Model HD-4500, SKU-001, EN 581-1, ISO 9001, IPX4.' }],
    };
    const out = createRedactor().redact(chat).chat.messages[0]!.text;
    expect(out).not.toMatch(/FBA15TEST0001|1Z999AA10123456784|LY123456789CN/);
    expect(out).toContain('[单号已脱敏]');
    for (const keep of ['HD-4500', 'SKU-001', 'EN 581-1', 'ISO 9001', 'IPX4']) expect(out).toContain(keep);
  });
});

describe('国家名', () => {
  it('简写与别名统一成标准国名，题目编号不再出现 XX', async () => {
    const { canonicalCountry, countryCode } = await import('../bank-kit/index');
    expect(canonicalCountry('USA')).toBe('United States');
    expect(countryCode('USA')).toBe('US');
    expect(countryCode('uk')).toBe('XX'); // 别名只认常见写法，大小写不同的简写不猜
    expect(countryCode('UK')).toBe('GB');
    expect(countryCode('China')).toBe('CN');
    expect(countryCode('germany')).toBe('DE');
  });
});

describe('脱敏推演：真实导出件里容易漏的几类（虚构数据）', () => {
  type Msg = { date: null; side: 'me' | 'client'; sender: string; time: string; kind: 'text'; attachments: string[]; text: string; textCn?: string };
  const msg = (side: 'me' | 'client', sender: string, text: string, textCn?: string): Msg => ({
    date: null, side, sender, time: '', kind: 'text', attachments: [], text, ...(textCn ? { textCn } : {}),
  });
  const chatOf = (header: Record<string, string>, messages: Msg[], fields: Record<string, string> = {}) => ({
    source: { file: 'x.html', exporterVersion: 'alibaba-chat-export v6.0' },
    header, customer: { fields, behavior90d: {} }, okki: null, profile: null, buying: null, order: null, messages,
  });

  it('替班同事、买家换人说话、三个字母的姓、域名里的品牌、各种电话与通讯账号、中文公司名与地址都抹掉', async () => {
    const { createRedactor } = await import('./index');
    const chat = chatOf(
      { 客户: 'Daniel Brooks', 地区: 'United States', 负责人: 'Nadia Wu', 询价单号: '12345678901' },
      [
        msg('client', 'Daniel Brooks', 'Hi Nadia, see www.brooksoutdoor.example or our BrooksOutdoor store. Call +1 (202) 555-0107 or 202.555.0108.'),
        msg('client', 'Megan Hart', "I'm Megan from purchasing. WhatsApp: +1 202 555 0109 22, WeChat: meganhart88"),
        msg('me', 'Me (Olga Lin)', 'Hi Daniel, Olga LIN here, covering for Ms. Wu. Mobile +1 202 555 0110.'),
        msg('me', 'Me (Nadia Wu)', '样品请寄到江苏省示例市文化路 88 号 3 栋，抬头写示例工贸有限公司。'),
      ],
      { 公司名称: 'Brooks Outdoor LLC', 邮箱: 'dan@brooksoutdoor.example' },
    );
    const r = createRedactor().redact(chat);
    expect(r.residue).toEqual([]);
    const all = JSON.stringify(r.chat);
    for (const leak of ['Brooks', 'brooksoutdoor', 'BrooksOutdoor', 'Megan', 'Hart', 'meganhart88', 'Olga', 'LIN', 'Ms. Wu', 'Nadia',
      '555-0107', '0108', '0109', '0110', 'dan@', '文化路', '示例工贸', '3 栋', '12345678901']) expect(all).not.toContain(leak);
    // 判断项照样留着：国家、「请寄到」这类前文、发送人仍看得出是同一边的不同人
    expect(all).toContain('United States');
    expect(r.chat.messages[3]!.text.startsWith('样品请寄到')).toBe(true);
    expect(r.chat.messages[1]!.sender).not.toBe(r.chat.messages[0]!.sender);
    expect(r.chat.messages[2]!.sender).not.toBe(r.chat.messages[3]!.sender);
  });

  it('中文名的业务员：两三个字也照抹', async () => {
    const { createRedactor } = await import('./index');
    const chat = chatOf({ 客户: 'Laura Smith', 地区: 'Germany', 负责人: '王小明' },
      [msg('me', 'Me (王小明)', 'Hello Laura, this is our offer.', '你好，我是王小明，这是报价。')]);
    const r = createRedactor().redact(chat);
    expect(JSON.stringify(r.chat)).not.toContain('王小明');
    expect(r.residue).toEqual([]);
  });

  it('不误伤：数量、日期、价格、文件名、型号、含姓氏字母的普通词', async () => {
    const { createRedactor } = await import('./index');
    const text = 'Need 500/1000/2000 pcs by 2026-01-05, price 3.85, see quotation.pdf, model HD-4500, made in U.S.; sleeve size, ship to Leeds.';
    const chat = chatOf({ 客户: 'Tom Lee', 地区: 'United Kingdom' }, [msg('client', 'Tom Lee', text)]);
    const out = createRedactor().redact(chat).chat.messages[0]!.text;
    for (const keep of ['500/1000/2000 pcs', '2026-01-05', '3.85', 'quotation.pdf', 'HD-4500', 'U.S.', 'sleeve', 'Leeds']) expect(out).toContain(keep);
  });
});

describe('本批脱敏词表', () => {
  it('词表文件：一行一个或逗号隔开，# 后是注释；中文两个字、英文两个字母的词也认（两个字母只按整词）', async () => {
    const { createRedactor, readMaskFile } = await import('./index');
    const f = join(mkdtempSync(join(tmpdir(), 'mask-')), '词表.txt');
    writeFileSync(f, '# 自家的名字\nNorthpeak Gear, 北峰\n小周   # 业务员小名\nNP\n\n');
    const terms = readMaskFile(f);
    expect(terms).toEqual(['Northpeak Gear', '北峰', '小周', 'NP']);
    const chat = {
      source: { file: 'x.html', exporterVersion: null },
      header: { 客户: 'Ann Lee', 地区: 'United States' },
      customer: null, okki: null, profile: null, buying: null, order: null,
      messages: [{ date: null, side: 'me' as const, sender: 'Me (Sales)', time: '', kind: 'text' as const, attachments: [],
        text: 'This is Northpeak Gear, model NP-200. INPUT voltage ok.', textCn: '我是北峰的小周。' }],
    };
    const m = createRedactor({ extraTerms: terms }).redact(chat).chat.messages[0]!;
    expect(m.text).not.toMatch(/Northpeak|NP-200/);
    expect(m.text).toContain('INPUT'); // 两个字母的词只按整词抹，INPUT 里的 NP 不动
    expect(m.textCn).not.toMatch(/北峰|小周/);
  });
});

describe('修订后标出改了哪里', () => {
  it('比到第二层：哪张暗牌、明牌哪个字段；来源备注不算', async () => {
    const { personaChanges } = await import('./diff');
    const a = structuredClone(samplePersonas.find((x) => x.id === 'A01-DE-001')!);
    const b = structuredClone(a);
    const key = Object.keys(b.hidden_card).find((k) => !k.startsWith('_'))!;
    (b.hidden_card as Record<string, { value: string }>)[key]!.value += ' (改)';
    (b.open_card as Record<string, unknown>).inquiry_text = 'changed';
    (b as unknown as Record<string, unknown>)._source = { material_id: 'x' };
    const c = personaChanges(a, b);
    expect(c).toContain(`暗牌：${key}`);
    expect(c).toContain('明牌：inquiry_text');
    expect(c).toHaveLength(2);
    expect(personaChanges(a, structuredClone(a))).toEqual([]);
  });
});

describe('题库工坊用到的批次开关', () => {
  it('开工上限：只开工前几份，其余停在已脱敏；放开后接着做', async () => {
    const { createBatch: cb, ingest: ing, run: rn, status: st, answer: ans } = await import('./index');
    const s2 = new Store(mkdtempSync(join(tmpdir(), 'drawer-limit-')));
    cb(s2, 'lim', { variantsPerMother: 0, processLimit: 2 });
    const chats = readdirSync(join(SAMPLES, 'raw-materials/chats')).slice(0, 4).map((f) => join(SAMPLES, 'raw-materials/chats', f));
    await ing(s2, 'lim', [...chats, join(SAMPLES, 'raw-materials/产品表-样品.xlsx')]);
    for (const c of st(s2, 'lim').pendingReviews) ans(s2, 'lim', c.id, 'pass');
    const items = s2.getBatch('lim').items.map((x) => s2.getItem('lim', x));
    const fake = new FakeLlm(new Map(items.map((it) => [it.materialId, personaOfFile(it.file)])));
    await rn(s2, 'lim', fake);
    expect(st(s2, 'lim').items.redacted).toBe(2);
    const b = s2.getBatch('lim');
    delete b.config.processLimit;
    s2.saveBatch(b);
    await rn(s2, 'lim', fake);
    expect(st(s2, 'lim').items.redacted).toBeUndefined();
  });

  it('分两次打包：打过的题不再打；后来采用的接着打进新版本', async () => {
    const { pack: pk, markPacked: mark, status: st, answer: ans } = await import('./index');
    const s2 = new Store(mkdtempSync(join(tmpdir(), 'drawer-pack2-')));
    const { createBatch: cb, ingest: ing, run: rn } = await import('./index');
    cb(s2, 'pack-two', { variantsPerMother: 0 });
    const chats = readdirSync(join(SAMPLES, 'raw-materials/chats')).slice(0, 3).map((f) => join(SAMPLES, 'raw-materials/chats', f));
    await ing(s2, 'pack-two', [...chats, join(SAMPLES, 'raw-materials/产品表-样品.xlsx')]);
    for (const c of st(s2, 'pack-two').pendingReviews) ans(s2, 'pack-two', c.id, 'pass');
    const items = s2.getBatch('pack-two').items.map((x) => s2.getItem('pack-two', x));
    await rn(s2, 'pack-two', new FakeLlm(new Map(items.map((it) => [it.materialId, personaOfFile(it.file)]))));
    const cards = st(s2, 'pack-two').pendingReviews.filter((c) => c.kind === 'use_question');
    ans(s2, 'pack-two', cards[0]!.id, 'accept');
    const out = join(s2.root, 'banks-out');
    const r1 = pk(s2, ['pack-two'], { bankVersion: '1.0.0', bankId: 'bank-test0002', outRoot: out });
    expect(r1.added).toBe(1);
    mark(s2, r1);
    expect(() => pk(s2, ['pack-two'], { bankVersion: '1.0.1', base: r1.dir, outRoot: out })).toThrow(/没有还没打包/);
    for (const c of cards.slice(1)) ans(s2, 'pack-two', c.id, 'accept');
    const r2 = pk(s2, ['pack-two'], { bankVersion: '1.1.0', base: r1.dir, outRoot: out });
    expect(r2.added).toBe(cards.length - 1);
    expect(r2.manifest.counts.total).toBe(cards.length);
    expect(validateBank(r2.dir).ok).toBe(true);
  });
});

describe('开工前预估', () => {
  it('等主管确认脱敏的素材也算进去（确认完多半照样加工）', async () => {
    const { createBatch: cb, ingest: ing, estimate: est, status: st } = await import('./index');
    const s2 = new Store(mkdtempSync(join(tmpdir(), 'drawer-est-')));
    cb(s2, 'est', { variantsPerMother: 3 });
    const chats = readdirSync(join(SAMPLES, 'raw-materials/chats')).map((f) => join(SAMPLES, 'raw-materials/chats', f));
    await ing(s2, 'est', chats);
    expect(st(s2, 'est').items.blocked ?? 0).toBeGreaterThan(0);
    expect(est(s2, 'est').materials).toBe(8);
  });
});

describe('回流：回炉与带过状态', () => {
  it('回炉的题改完后顶替题库里同编号的旧题；停用、降为演习的状态打新版本时带过去', async () => {
    const { createBatch: cb, ingest: ing, run: rn, status: st, answer: ans, pack: pk, markPacked: mark, rework: rw, canRework: can } = await import('./index');
    const s2 = new Store(mkdtempSync(join(tmpdir(), 'drawer-rework-')));
    cb(s2, 'rew', { variantsPerMother: 0 });
    const chats = readdirSync(join(SAMPLES, 'raw-materials/chats')).slice(0, 3).map((f) => join(SAMPLES, 'raw-materials/chats', f));
    await ing(s2, 'rew', [...chats, join(SAMPLES, 'raw-materials/产品表-样品.xlsx')]);
    for (const c of st(s2, 'rew').pendingReviews) ans(s2, 'rew', c.id, 'pass');
    const items = s2.getBatch('rew').items.map((x) => s2.getItem('rew', x));
    const fake = new FakeLlm(new Map(items.map((it) => [it.materialId, personaOfFile(it.file)])));
    await rn(s2, 'rew', fake);
    for (const c of st(s2, 'rew').pendingReviews) ans(s2, 'rew', c.id, 'accept');
    const out = join(s2.root, 'banks-out');
    const r1 = pk(s2, ['rew'], { bankVersion: '1.0.0', bankId: 'bank-test0003', outRoot: out });
    mark(s2, r1);
    const [first, second] = r1.refs;

    // 回炉第一道
    expect(can(s2, 'bank-test0003', first!.id)).toBe(true);
    expect(can(s2, 'bank-other00', first!.id)).toBe(false);
    expect(rw(s2, 'bank-test0003', first!.id, '实战 12 局过了 11 局，太容易：加一张干扰暗牌')).not.toBeNull();
    expect(rw(s2, 'bank-test0003', 'Z99-XX-999', '没有这道题')).toBeNull();
    await rn(s2, 'rew', fake);
    const card = st(s2, 'rew').pendingReviews.find((c) => c.kind === 'use_question')!;
    expect(card.question).toContain(`回炉题（替换题库里的 ${first!.id}）`);
    expect(card.changes).toBeDefined();
    ans(s2, 'rew', card.id, 'accept');

    // 第二道在柜子里被停用了：打新版本时带过去
    const r2 = pk(s2, ['rew'], { bankVersion: '1.1.0', base: r1.dir, outRoot: out, baseOverrides: { [second!.id]: { active: false } } });
    expect(r2.replaced).toEqual([first!.id]);
    expect(r2.added).toBe(0);
    const bank = readBank(r2.dir);
    expect(bank.personas).toHaveLength(r1.manifest.counts.total);
    expect(bank.personas.filter((p) => p.id === first!.id)).toHaveLength(1);
    expect(bank.personas.find((p) => p.id === second!.id)!.active).toBe(false);
    expect(validateBank(r2.dir).ok).toBe(true);
    mark(s2, r2);
    expect(s2.getItem('rew', first!.itemId).questions.find((q) => q.qid === first!.qid)!.replaces).toBeUndefined();
  });
});
