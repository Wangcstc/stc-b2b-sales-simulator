import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * 口令与会话令牌。
 *
 * ★ 为什么不能只加口令 ★
 * 之前 cookie 里存的是明文简码（drill_user=WC），谁都能在浏览器里改成别人的。
 * 只加口令、不改 cookie，等于门口装了锁、窗户还开着——所以会话必须签名。
 *
 * ★ 为什么不引第三方库 ★
 * scrypt 和 HMAC 都在 node:crypto 里。这套系统十几个人内部用，
 * 多一个依赖就多一处要跟着升级的东西。
 *
 * ★ 这仍然不是银行级 ★
 * 没做登录失败限速、没做二次验证。它挡的是"同事随手点进你的账号"，
 * 不是挡有心攻击。真要往外网开，先补限速和 HTTPS。
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 32;

/** 口令 → scrypt$盐$密钥 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** 逐字节等时比较，别用 === —— 那会从比较耗时里漏出信息 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;

  const key = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEYLEN);
  const expected = Buffer.from(keyHex, 'hex');
  if (key.length !== expected.length) return false;
  return timingSafeEqual(key, expected);
}

/** 口令规则：够短的口令等于没有，但也别苛刻到逼人写在便利贴上 */
export function checkPasswordStrength(password: string): string | null {
  if (password.length < 6) return '口令至少 6 位';
  if (password.length > 64) return '口令最长 64 位';
  if (/^\d+$/.test(password)) return '别用纯数字，加个字母';
  return null;
}

// ───────────────────────── 会话令牌 ─────────────────────────

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天，一个训练周期

function secret(): string {
  const s = process.env.AUTH_SECRET;
  // 不给默认值：有默认值就等于所有部署共用一把钥匙，令牌可以互相伪造
  if (!s || s.length < 32) {
    throw new Error('缺少 AUTH_SECRET（至少 32 位随机串）。在 .env 里加一行再重启。');
  }
  return s;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * 令牌 = 简码.版本号.签发时间.签名 —— 改任何一段，签名都对不上。
 *
 * ★ 版本号是 2026-08-28 加的（漏洞台账 N-9）★
 * 在这之前令牌是「简码.签发时间.签名」，有效期 30 天，**不带版本号**。
 * 后果：主管点「重置口令」之后，那个人手上**已经签发的旧令牌照样能用 30 天**——
 * 主管以为把人挡在外面了，其实没有。停用还有一条兜底（`getCurrentUser` 查 `disabledAt`），
 * 重置口令一条兜底都没有。
 *
 * 现在签发时把 `User.tokenVersion` 写进令牌；重置口令 / 停用 / 恢复三处各 +1，
 * 加一就作废那个人手上所有旧令牌。
 */
export function issueToken(code: string, tokenVersion: number): string {
  const payload = `${code}.${tokenVersion}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export interface TokenClaims {
  code: string;
  /** 令牌里带的版本号。调用方要拿它跟库里的 `User.tokenVersion` 比对 */
  tokenVersion: number;
}

/**
 * 验令牌，返回简码与版本号；被改过、过期、或签名不对一律返回 null。
 *
 * ★ 这里**不**比对版本号 ★ 比对要查库，而这个文件是纯函数（不碰 prisma）。
 * 版本号比对在 `current-user.getCurrentUser` 里做——它本来就要查这个人。
 *
 * ★ 老令牌（三段式）一律判无效 ★ 不做兼容。兼容意味着「没有版本号的令牌照样放行」，
 * 那正好是这次要堵的洞。代价是升级当天所有人要重新登录一次，一次而已。
 */
export function readToken(token: string | undefined): TokenClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [code, version, issuedAt, sig] = parts as [string, string, string, string];
  const payload = `${code}.${version}.${issuedAt}`;

  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  const at = Number(issuedAt);
  if (!Number.isFinite(at) || Date.now() - at > MAX_AGE_MS) return null;

  const tokenVersion = Number(version);
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) return null;

  return { code, tokenVersion };
}
