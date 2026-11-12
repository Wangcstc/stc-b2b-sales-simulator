import { describe, expect, it } from 'vitest';
import { auditUserLedger, nextFails, type LedgerRow } from './ledger-audit';
import { judgementFingerprint } from './admission-v11';

/**
 * 留档体检的纯函数部分（2026-08-22）
 *
 * ★ 这是 board/settlement 那一层的第一条自动化护栏 ★
 * 在此之前「格子怎么摆、留档对不对得上」全靠改完人工跑一遍取数脚本核对。
 * 这份查的是「库里那堆留档自不自洽」，不连数据库，喂什么查什么。
 */

const U = 'u1';

function row(day: string, passed: boolean | null, consecutiveFails: number): LedgerRow {
  return { userId: U, day, passed, consecutiveFails };
}

/** 默认：全都是工作日，谁也没请假 */
const ALL_WORK = { isWorkday: () => true, onLeave: () => false };

/** 指定哪几天放假 / 哪几天请假，其余照常 */
function cal(opts: { rest?: string[]; leave?: string[] } = {}) {
  const rest = new Set(opts.rest ?? []);
  const leave = new Set(opts.leave ?? []);
  return { isWorkday: (day: string) => !rest.has(day), onLeave: (day: string) => leave.has(day) };
}

describe('连续不达标天数的递推', () => {
  it('不达标 → +1', () => {
    expect(nextFails(2, false)).toBe(3);
  });

  it('达标 → 清零', () => {
    expect(nextFails(2, true)).toBe(0);
  });

  it('★ 不构成判定 → 既不加也不清零 ★「没考够」不是「没考好」', () => {
    expect(nextFails(2, null)).toBe(2);
    expect(nextFails(0, null)).toBe(0);
  });
});

describe('留档体检', () => {
  it('链条自洽、日历也对得上 → 一条都不报', () => {
    const rows = [
      row('2026-08-17', false, 1),
      row('2026-08-18', false, 2),
      row('2026-08-19', true, 0),
      row('2026-08-20', null, 0),
    ];
    expect(auditUserLedger(rows, ALL_WORK)).toEqual([]);
  });

  it('★ 窗口里第一行不查链条 ★ 它的连续天数是从窗口之外继承来的，无从对起', () => {
    // 单看这一行，cf=7 配 passed=false 怎么都对不上「从 0 开始」，但它是继承来的
    expect(auditUserLedger([row('2026-08-19', false, 7)], ALL_WORK)).toEqual([]);
  });

  it('这天现在标着放假，库里却还有留档 → REST_DAY', () => {
    const rows = [row('2026-08-19', false, 1), row('2026-08-20', false, 2)];
    const stale = auditUserLedger(rows, cal({ rest: ['2026-08-20'] }));
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'REST_DAY' }]);
  });

  it('★ 这天他请假，库里却还有留档 → ON_LEAVE ★ 台账上被「请假」挡住看不见，但它还活着', () => {
    const rows = [row('2026-08-19', false, 1), row('2026-08-20', false, 2)];
    const stale = auditUserLedger(rows, cal({ leave: ['2026-08-20'] }));
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'ON_LEAVE' }]);
  });

  it('连续天数和前一天对不上 → CHAIN_BROKEN', () => {
    // 前一天达标（清零），这一天不达标应该是 1，库里却是 5
    const rows = [row('2026-08-19', true, 0), row('2026-08-20', false, 5)];
    const stale = auditUserLedger(rows, ALL_WORK);
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'CHAIN_BROKEN' }]);
  });

  it('★ 断链只报第一处 ★ 一处错之后每天都会跟着错，报一整片人只会当噪音略过去', () => {
    const rows = [
      row('2026-08-17', true, 0),
      row('2026-08-18', false, 5), // ← 断在这儿
      row('2026-08-19', false, 9),
      row('2026-08-20', false, 12),
    ];
    const stale = auditUserLedger(rows, ALL_WORK);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.day).toBe('2026-08-18');
  });

  it('★ 不该存在的行不推进链条 ★ 拿一行本来就要删掉的留档当基准，会把它后面全带偏', () => {
    const rows = [
      row('2026-08-18', false, 1),
      row('2026-08-19', false, 99), // 这天现在标着放假，本来就不该有这一行
      row('2026-08-20', false, 2), // 接的是 08-18 那条：1 + 1 = 2，对的
    ];
    const stale = auditUserLedger(rows, cal({ rest: ['2026-08-19'] }));
    // 只报那条多余的，不该顺带把 08-20 报成断链
    expect(stale).toEqual([{ userId: U, day: '2026-08-19', reason: 'REST_DAY' }]);
  });

  it('中间被插进来一天 → 它之后的连续天数对不上，查得出来', () => {
    // 撤销了 08-19 的请假，catchUpSettlement 把 08-19 补上（不达标），
    // 但 08-20 那条是插入之前算的，还写着 1
    const rows = [
      row('2026-08-18', false, 1),
      row('2026-08-19', false, 2), // 新补进来的
      row('2026-08-20', false, 1), // 旧的：以为前一天是 08-18 之后就没了
    ];
    const stale = auditUserLedger(rows, ALL_WORK);
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'CHAIN_BROKEN' }]);
  });

  it('放假与请假同时命中一天时，只报一次（放假优先）', () => {
    const rows = [row('2026-08-19', false, 1), row('2026-08-20', false, 2)];
    const stale = auditUserLedger(rows, cal({ rest: ['2026-08-20'], leave: ['2026-08-20'] }));
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'REST_DAY' }]);
  });
});


// ───────────────── 改了判定口径而没重算 ─────────────────

/**
 * ★ 这是台账上最后一个黑洞 ★（老漏洞 J，2026-08-22 收口）
 * 历史行的结论读留档，左边 6 个格子是现算的。改了阈值不重算，
 * 就会出现「格子按新规则摆、结论按老规则给」——两边都长得很正常，没有任何提示。
 * 日历那半边早有三向体检，这半边此前完全靠「改完记得重算」这条人肉流程。
 */
describe('判定口径变了：留档要认得出来', () => {
  const NOW = judgementFingerprint();
  const OLD = 'gates=score|score>=45|window=2x3|precise>=4|insight>=3|answer>=1|redlineDays=2|failsToSuspend=2';

  const withPrint = (day: string, print: string | null): LedgerRow => ({
    userId: U,
    day,
    passed: false,
    consecutiveFails: 1,
    ruleFingerprint: print,
  });

  it('指纹和当前口径不一致 → 报 RULE_CHANGED', () => {
    const stale = auditUserLedger([withPrint('2026-08-20', OLD)], ALL_WORK, NOW);
    expect(stale).toEqual([{ userId: U, day: '2026-08-20', reason: 'RULE_CHANGED' }]);
  });

  it('指纹一致 → 不报', () => {
    expect(auditUserLedger([withPrint('2026-08-20', NOW)], ALL_WORK, NOW)).toEqual([]);
  });

  it('★ 老留档没有指纹 → 一律不报 ★ 全报出来就是三千行红字，人只会略过去', () => {
    expect(auditUserLedger([withPrint('2026-08-20', null)], ALL_WORK, NOW)).toEqual([]);
    expect(auditUserLedger([row('2026-08-20', false, 1)], ALL_WORK, NOW)).toEqual([]);
  });

  it('口径变了照样推进链条，不会把它之后的日子误报成断链', () => {
    const stale = auditUserLedger(
      [
        { userId: U, day: '2026-08-19', passed: false, consecutiveFails: 1, ruleFingerprint: OLD },
        { userId: U, day: '2026-08-20', passed: false, consecutiveFails: 2, ruleFingerprint: OLD },
      ],
      ALL_WORK,
      NOW,
    );
    expect(stale.map((item) => item.reason)).toEqual(['RULE_CHANGED', 'RULE_CHANGED']);
  });

  it('不该存在的行（放假日）先被摘掉，不再重复报口径', () => {
    const stale = auditUserLedger([withPrint('2026-08-22', OLD)], cal({ rest: ['2026-08-22'] }), NOW);
    expect(stale).toEqual([{ userId: U, day: '2026-08-22', reason: 'REST_DAY' }]);
  });

  it('指纹本身要随阈值变化——同样的配置算两次必须一样', () => {
    expect(judgementFingerprint()).toBe(NOW);
    expect(NOW).not.toBe(OLD);
  });
});
