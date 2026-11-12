/**
 * 口令与会话令牌的测试。
 *
 * ★ 为什么补这个 ★ auth.ts 是全项目唯一一处安全边界——口令哈希、等时比较、
 * 会话令牌签名全在这 95 行里，而它此前零测试。它自己的注释写着
 * 「这仍然不是银行级」，那更说明**它承诺的那几件事必须真的成立**：
 * 令牌改一个字节就失效、过期就失效、口令验错就是 false。
 *
 * ★ 这里不测「破解不了」★ 那不是单元测试能证明的。
 * 测的是它对外承诺的行为契约，以及几个容易写错的边界（空串、脏数据、篡改）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPasswordStrength, hashPassword, issueToken, readToken, verifyPassword } from './auth';

// 令牌那半边要 AUTH_SECRET。给一个固定的测试用密钥，别读开发机的 .env
const TEST_SECRET = 'x'.repeat(48);
beforeEach(() => {
  process.env.AUTH_SECRET = TEST_SECRET;
  vi.useRealTimers();
});

describe('hashPassword / verifyPassword', () => {
  it('对的口令验得过', async () => {
    const stored = await hashPassword('stc2026');
    expect(await verifyPassword('stc2026', stored)).toBe(true);
  });

  it('错的口令验不过', async () => {
    const stored = await hashPassword('stc2026');
    expect(await verifyPassword('stc2027', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('STC2026', stored)).toBe(false);
  });

  it('★ 每次加盐，同一个口令两次哈希结果不同 ★ 否则两个用口令一样的人一眼就能看出来', async () => {
    const a = await hashPassword('stc2026');
    const b = await hashPassword('stc2026');
    expect(a).not.toBe(b);
    // 但两份都能验过同一个口令
    expect(await verifyPassword('stc2026', a)).toBe(true);
    expect(await verifyPassword('stc2026', b)).toBe(true);
  });

  it('哈希串格式是 scrypt$盐$密钥', async () => {
    const stored = await hashPassword('stc2026');
    const parts = stored.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(3);
    expect(parts[1]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('★ 没设过口令（null）一律 false，不是"随便什么都能进" ★', async () => {
    expect(await verifyPassword('随便什么', null)).toBe(false);
  });

  it('库里是脏数据时不抛错，返回 false', async () => {
    for (const junk of ['', 'garbage', 'scrypt$', 'scrypt$abc', 'bcrypt$aa$bb', '$$']) {
      expect(await verifyPassword('stc2026', junk)).toBe(false);
    }
  });

  it('长度不匹配的密钥不会让等时比较抛错', async () => {
    expect(await verifyPassword('stc2026', 'scrypt$' + 'aa'.repeat(16) + '$' + 'bb'.repeat(8))).toBe(false);
  });
});

describe('checkPasswordStrength', () => {
  it('合规口令返回 null', () => {
    expect(checkPasswordStrength('stc2026')).toBeNull();
    expect(checkPasswordStrength('abcdef')).toBeNull();
  });

  it('太短要挡', () => {
    expect(checkPasswordStrength('abc12')).toBe('口令至少 6 位');
    expect(checkPasswordStrength('')).toBe('口令至少 6 位');
  });

  it('太长要挡', () => {
    expect(checkPasswordStrength('a'.repeat(65))).toBe('口令最长 64 位');
    expect(checkPasswordStrength('a'.repeat(64))).toBeNull();
  });

  it('纯数字要挡——六位纯数字基本都是生日', () => {
    expect(checkPasswordStrength('123456')).toBe('别用纯数字，加个字母');
    expect(checkPasswordStrength('19900101')).toBe('别用纯数字，加个字母');
    expect(checkPasswordStrength('1234a6')).toBeNull();
  });

  it('边界：正好 6 位过，5 位不过', () => {
    expect(checkPasswordStrength('abcde')).toBe('口令至少 6 位');
    expect(checkPasswordStrength('abcdef')).toBeNull();
  });
});

describe('issueToken / readToken', () => {
  it('自己签的自己认，读回来是原简码与版本号', () => {
    expect(readToken(issueToken('AB', 0))).toEqual({ code: 'AB', tokenVersion: 0 });
    expect(readToken(issueToken('CD', 7))).toEqual({ code: 'CD', tokenVersion: 7 });
  });

  it('★ 改任何一段签名都对不上 ★ 这是整套会话安全的根据', () => {
    const token = issueToken('AB', 3);
    const [code, ver, at, sig] = token.split('.');
    // 换个人
    expect(readToken(`CD.${ver}.${at}.${sig}`)).toBeNull();
    // ★ 改版本号 ★ 这一段是 2026-08-28 加的，同样受签名保护——
    // 否则谁都能把自己令牌里的版本号改成新的，这条修复就白做了
    expect(readToken(`${code}.9.${at}.${sig}`)).toBeNull();
    // 改签发时间
    expect(readToken(`${code}.${ver}.${Number(at) - 1000}.${sig}`)).toBeNull();
    // 改签名
    expect(readToken(`${code}.${ver}.${at}.${'a'.repeat(sig!.length)}`)).toBeNull();
  });

  it('换一把密钥就认不出来了——各部署之间令牌不通用', () => {
    const token = issueToken('AB', 0);
    process.env.AUTH_SECRET = 'y'.repeat(48);
    expect(readToken(token)).toBeNull();
  });

  it('畸形令牌一律 null，不抛错', () => {
    for (const junk of [undefined, '', 'abc', 'a.b', 'a.b.c', 'a.b.c.d.e', '...', 'WC...sig']) {
      expect(readToken(junk as string | undefined)).toBeNull();
    }
  });

  /**
   * ★ 老的三段式令牌一律判无效 ★（N-9，2026-08-28）
   * 不做兼容。兼容意味着「没有版本号的令牌照样放行」——那正好是这次要堵的洞。
   * 代价是升级当天所有人重新登录一次，一次而已。
   */
  it('★ 升级前的三段式旧令牌不再被接受 ★', () => {
    expect(readToken('WC.1756300000000.somesignature')).toBeNull();
  });

  it('签发时间或版本号不是数字 → null', () => {
    expect(readToken('WC.0.notanumber.sig')).toBeNull();
    expect(readToken('WC.notanumber.1756300000000.sig')).toBeNull();
  });

  it('★ 30 天后过期 ★', () => {
    const token = issueToken('AB', 0);
    const MS = 24 * 60 * 60 * 1000;
    vi.useFakeTimers();

    vi.setSystemTime(Date.now() + 29 * MS);
    expect(readToken(token)).toEqual({ code: 'AB', tokenVersion: 0 });

    vi.setSystemTime(Date.now() + 2 * MS); // 累计 31 天
    expect(readToken(token)).toBeNull();
  });

  it('★ 缺少 AUTH_SECRET 或太短一律抛错，不许退化成默认密钥 ★ 有默认值＝所有部署共用一把钥匙', () => {
    delete process.env.AUTH_SECRET;
    expect(() => issueToken('AB', 0)).toThrow(/AUTH_SECRET/);

    process.env.AUTH_SECRET = 'tooshort';
    expect(() => issueToken('AB', 0)).toThrow(/AUTH_SECRET/);
  });
});
