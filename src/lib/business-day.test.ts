import { describe, expect, it } from 'vitest';
import { businessDay, daysBetween, nextBusinessDay } from './business-day';

describe('Asia/Shanghai 业务日', () => {
  it('UTC 前一日 16:00 后按上海次日计算', () => {
    expect(businessDay(new Date('2026-08-14T15:59:59.999Z'))).toBe('2026-08-14');
    expect(businessDay(new Date('2026-08-14T16:00:00.000Z'))).toBe('2026-08-15');
  });

  it('次工作日跳过周末，日期间隔不受夏令时影响', () => {
    expect(nextBusinessDay('2026-08-14')).toBe('2026-08-17');
    expect(daysBetween('2026-08-14', '2026-08-17')).toBe(3);
  });
});
