import { describe, it, expect } from 'vitest';
import { decideBudget, budgetWarnLine, LLM_BUDGET } from './budget';

const LIMIT = 1_000_000;

describe('decideBudget', () => {
  it('正常用量不告警不拦', () => {
    const d = decideBudget(100_000, LIMIT);
    expect(d.blocked).toBe(false);
    expect(d.warn).toBe(false);
    expect(d.message).toBe('');
  });

  it('到 70% 只告警，不拦人', () => {
    const d = decideBudget(700_000, LIMIT);
    expect(d.warn).toBe(true);
    // ★ 这条是整道闸的重点 ★ 告警线不许拦人。
    // 业务员正在考试，因为「用了七成」被打断，比超支严重得多
    expect(d.blocked).toBe(false);
    expect(d.message).toBe('');
  });

  it('69.9% 还不告警——边界不能提前一格', () => {
    expect(decideBudget(699_999, LIMIT).warn).toBe(false);
  });

  it('到 100% 才拦，且拦的时候一定同时告警', () => {
    const d = decideBudget(LIMIT, LIMIT);
    expect(d.blocked).toBe(true);
    expect(d.warn).toBe(true);
  });

  it('超了也照样拦，ratio 可以大于 1', () => {
    const d = decideBudget(LIMIT * 3, LIMIT);
    expect(d.blocked).toBe(true);
    expect(d.ratio).toBe(3);
  });

  it('拦人的话必须写清「不是你的问题」和「找管理员」', () => {
    // 撞线时业务员看到的是这段话。它要是写成一句技术错误，
    // 他会以为是自己把系统弄坏了，然后不敢再点
    const { message } = decideBudget(LIMIT, LIMIT);
    expect(message).toContain('不是你的问题');
    expect(message).toContain('管理员');
    expect(message).toContain('不受影响');
  });

  it('limit ≤ 0 = 显式关闸，一律放行', () => {
    expect(decideBudget(9_999_999, 0).blocked).toBe(false);
    expect(decideBudget(9_999_999, -1).blocked).toBe(false);
  });

  it('脏配置（NaN）不当成无限额度，也不当成零额度', () => {
    // NaN 走关闸分支放行：宁可漏拦，也不能因为 .env 打错一个字
    // 就把全公司挡在门外
    const d = decideBudget(500_000, Number.NaN);
    expect(d.blocked).toBe(false);
    expect(d.warn).toBe(false);
  });

  it('脏用量（负数 / NaN）按 0 算，不会算出负 ratio', () => {
    expect(decideBudget(-100, LIMIT).ratio).toBe(0);
    expect(decideBudget(Number.NaN, LIMIT).ratio).toBe(0);
  });

  it('默认额度来自 LLM_BUDGET，不传 limit 也能判', () => {
    expect(decideBudget(0).blocked).toBe(false);
    expect(decideBudget(LLM_BUDGET.dailyTokenLimit * 2).blocked).toBe(true);
  });
});

describe('budgetWarnLine', () => {
  it('告警行带得走百分比和两个绝对值', () => {
    const line = budgetWarnLine(decideBudget(700_000, LIMIT), 700_000, LIMIT);
    expect(line).toContain('70%');
    expect(line).toContain('700,000');
    expect(line).toContain('1,000,000');
    expect(line).toContain('跑飞');
  });

  it('撞线那条要说清后果是「一律拒绝」', () => {
    const line = budgetWarnLine(decideBudget(LIMIT, LIMIT), LIMIT, LIMIT);
    expect(line).toContain('拒绝');
  });
});
