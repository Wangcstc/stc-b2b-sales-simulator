import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// 管理留痕要写数据库；这里只测工坊本身，留痕换成记在内存里
const audits: { action: string; after?: string | null }[] = [];
vi.mock('../admin-audit', () => ({ audit: async (x: { action: string; after?: string | null }) => void audits.push(x) }));

import { Store, type Llm } from '../../../drawer/index';
import { createRedactor, parseChatHtml, prepareHtml } from '../../../drawer/browser';
import { workshopMode } from './mode';
import { yuan } from './labels';
import { setLlmFactory, waitIdle } from './runner';
import { answerCard, batchItems, batchRows, decideStart, ingestUpload, pendingCards, setWorkshopStore } from './service';
import type { CurrentUser } from '../current-user';

const SAMPLES = resolve('samples/raw-materials');
const me = { id: 'u-test', code: 'ADMIN', role: 'ADMIN' } as unknown as CurrentUser;
let root: string;

/** 和投料页一样：在「浏览器」里解析、脱敏，只把脱敏后的素材交给服务端 */
function browserSide() {
  const red = createRedactor();
  return readdirSync(join(SAMPLES, 'chats'))
    .sort()
    .map((f, i) => {
      const chat = parseChatHtml(prepareHtml(new Uint8Array(readFileSync(join(SAMPLES, 'chats', f)))), f);
      const r = red.redact(chat);
      return { label: `c${String(i + 1).padStart(3, '0')}-chat`, chat: r.chat, real: String(chat.header['客户'] ?? ''), file: f };
    });
}

const allText = (dir: string): string =>
  readdirSync(dir)
    .map((f) => join(dir, f))
    .map((p) => (statSync(p).isDirectory() ? allText(p) : readFileSync(p, 'utf8')))
    .join('\n');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'workshop-'));
  setWorkshopStore(new Store(join(root, 'drawer')));
  // 加工一开跑就失败：这里不测模型，只测工坊把失败接住、批次还能续跑
  setLlmFactory(() => ({ complete: async () => Promise.reject(new Error('测试里不调模型')) }) as unknown as Llm);
});
afterAll(() => {
  setWorkshopStore(undefined);
  setLlmFactory(undefined);
});

describe('题库工坊开在哪', () => {
  it('托管平台只开题库页；可以显式指定', () => {
    expect(workshopMode({})).toBe('full');
    expect(workshopMode({ VERCEL: '1' })).toBe('bank-only');
    expect(workshopMode({ VERCEL: '1', WORKSHOP_MODE: 'full' })).toBe('full');
    expect(workshopMode({ WORKSHOP_MODE: 'bank-only' })).toBe('bank-only');
  });
  it('花费的说法', () => {
    expect(yuan(0)).toBe('0 元');
    expect(yuan(0.04)).toBe('不到 0.1 元');
    expect(yuan(8.14)).toBe('约 8.1 元');
    expect(yuan(23.6)).toBe('约 24 元');
  });
});

describe('题库工坊：投料到确认', () => {
  let batchId = '';

  it('没有产品表开不了工', async () => {
    const mats = browserSide().slice(0, 2);
    const s = await ingestUpload(me, { materials: mats.map(({ label, chat }) => ({ label, chat })) });
    expect(s.products).toBeNull();
    await expect(decideStart(me, s.batchId, 'all')).rejects.toThrow(/产品表/);
  });

  it('投料：只收脱敏后的素材；服务端工作区里找不到原文件名和客户真名', async () => {
    const mats = browserSide();
    const s = await ingestUpload(me, {
      materials: mats.map(({ label, chat }) => ({ label, chat })),
      products: readFileSync(join(SAMPLES, '产品表-样品.xlsx')),
    });
    batchId = s.batchId;
    expect(s.chats).toBe(8);
    expect(s.products).toBeGreaterThan(0);
    expect(s.firstBatch).toBe(false);
    const disk = allText(root);
    for (const m of mats) {
      expect(disk).not.toContain(m.file.replace(/\.html$/, ''));
      expect(disk).not.toContain(m.file.slice(0, 4)); // 连编号前缀（S01-）都不留
      // 整词比：化名库里有 Hartley，真名里的 Hart 不能因此误报
      for (const part of m.real.split(/\s+/).filter((x) => x.length >= 4)) expect(disk).not.toMatch(new RegExp(`\\b${part}\\b`));
    }
    expect(audits.some((a) => a.action === 'WORKSHOP_INGEST')).toBe(true);
  });

  it('不交产品表就沿用上一批的', async () => {
    const s = await ingestUpload(me, { materials: browserSide().slice(0, 1).map(({ label, chat }) => ({ label, chat })) });
    expect(s.productsInherited).toBe(true);
    expect(s.products).toBeGreaterThan(0);
  });

  it('开工是选择题：「其他」写份数就是开工上限；模型出错时批次接住、能续跑', async () => {
    await expect(decideStart(me, batchId, 'other', '随便写')).rejects.toThrow(/份数|预算/);
    const say = await decideStart(me, batchId, 'other', '3');
    expect(say).toBe('先加工 3 份');
    const st = await waitIdle(batchId);
    expect(st?.error).toMatch(/测试里不调模型/);
    const row = batchRows().find((r) => r.id === batchId)!;
    expect(row.processLimit).toBe(3);
    expect(row.status).toBe('open');
  });

  it('「先不加工，只保存」：之后答卡也不会顺手开工花钱', async () => {
    const s = await ingestUpload(me, { materials: browserSide().slice(0, 3).map(({ label, chat }) => ({ label, chat })) });
    await decideStart(me, s.batchId, 'save');
    let calls = 0;
    setLlmFactory(() => ({ complete: async () => { calls += 1; throw new Error('不该调模型'); } }) as unknown as Llm);
    for (const c of pendingCards(s.batchId)) await answerCard(me, s.batchId, c.card.id, 'pass');
    const { startRun } = await import('./runner');
    startRun((await import('./service')).workshopStore(), s.batchId);
    await waitIdle(s.batchId);
    expect(calls).toBe(0);
    expect(batchRows().find((r) => r.id === s.batchId)!.processLimit).toBe(0);
    setLlmFactory(() => ({ complete: async () => Promise.reject(new Error('测试里不调模型')) }) as unknown as Llm);
  });

  it('加工明细用化名标签，不带原文件名', () => {
    const items = batchItems(batchId);
    expect(items).toHaveLength(8);
    expect(items.every((it) => /^c\d{3}-/.test(it.label))).toBe(true);
  });

  it('确认队列：疑似漏网卡带着是哪一份素材；答卡留痕', async () => {
    const cards = pendingCards(batchId);
    const suspect = cards.find((c) => c.card.kind === 'redact_suspect');
    if (!suspect) return; // 样品里这次没有疑似漏网的词
    expect(suspect.material).toMatch(/^c\d{3}-/);
    await answerCard(me, batchId, suspect.card.id, 'pass');
    await waitIdle(batchId);
    expect(audits.some((a) => a.action === 'WORKSHOP_ANSWER')).toBe(true);
    expect(pendingCards(batchId).some((c) => c.card.id === suspect.card.id)).toBe(false);
  });
});
