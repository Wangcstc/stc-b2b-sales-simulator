import { beforeEach, describe, expect, it, vi } from 'vitest';

const callMock = vi.fn();
vi.mock('./client', () => ({ call: (...a: unknown[]) => callMock(...a) }));

import { toChinese } from './translate';

const reply = (content: string) => callMock.mockResolvedValueOnce({ content, usage: { prompt: 1, completion: 1, cacheHit: 0, reasoning: 0 }, latencyMs: 1 });

beforeEach(() => callMock.mockReset());

describe('英译中', () => {
  it('把英文消息交给模型，返回中文；用的是 translate 用途、低温度', async () => {
    reply('你好，我们对你们的铝制折叠露营椅感兴趣，能发更多资料吗？');
    const r = await toChinese('Hello, we are interested in your aluminium folding camping chair. Could you send us more information?', 's1');
    expect(r.text).toContain('露营椅');
    const arg = callMock.mock.calls[0]![0];
    expect(arg.purpose).toBe('translate');
    expect(arg.sessionId).toBe('s1');
    expect(arg.temperature).toBeLessThanOrEqual(0.3);
    expect(arg.messages[0].content).toContain('忠实');
  });

  it('去掉「译文：」前缀和成对的外层引号', async () => {
    reply('译文：\n“大约 500 件。”');
    expect((await toChinese('About 500 pcs.')).text).toBe('大约 500 件。');
  });

  it('模型把英文原样吐回来（没有汉字）算失败，不悄悄把原文当译文', async () => {
    reply('About 500 pcs.');
    await expect(toChinese('About 500 pcs.')).rejects.toThrow(/没能译成中文/);
  });

  it('输入里一个英文字母都没有，不调模型', async () => {
    await expect(toChinese('12345 ?!')).rejects.toThrow(/没有英文/);
    await expect(toChinese('好的')).rejects.toThrow(/没有英文/);
    expect(callMock).not.toHaveBeenCalled();
  });
});
