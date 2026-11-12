/**
 * 第一次安装时生成 .env（`npm run setup`）
 *
 * ★ 为什么要有这一步 ★ 原来的说明是「cp .env.example .env，再自己生成一串随机数填进 AUTH_SECRET」。
 * Windows 的命令提示符没有 cp，生成随机串的命令又长，新手卡在这里的最多。
 * 这个脚本在 Windows、Mac、Linux 上都一样：复制模板、自动填好 AUTH_SECRET，
 * 只剩 DeepSeek 密钥要人自己填。
 *
 * 已经有 .env 就什么都不改，只检查还缺什么——反复跑不会覆盖已经填好的东西。
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = join(ROOT, '.env');
const EXAMPLE = join(ROOT, '.env.example');

const value = (text: string, key: string) => {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
};

let created = false;
if (!existsSync(ENV)) {
  copyFileSync(EXAMPLE, ENV);
  created = true;
}

let text = readFileSync(ENV, 'utf8');
if (value(text, 'AUTH_SECRET').length < 32) {
  const secret = randomBytes(48).toString('base64url');
  text = /^AUTH_SECRET=/m.test(text)
    ? text.replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET="${secret}"`)
    : `${text.trimEnd()}\nAUTH_SECRET="${secret}"\n`;
  writeFileSync(ENV, text, 'utf8');
  console.log('✓ 已自动生成登录用的密钥 AUTH_SECRET（以后不要改，改了全员要重新登录）');
}

console.log(created ? '✓ 已从 .env.example 生成 .env' : '· .env 已经存在，没有覆盖');

const key = value(text, 'DEEPSEEK_API_KEY');
const todo: string[] = [];
if (!key || /x{6,}/.test(key)) todo.push('DEEPSEEK_API_KEY：填你自己的 DeepSeek 密钥（platform.deepseek.com 申请，sk- 开头）');
if (!value(text, 'DATABASE_URL')) todo.push('DATABASE_URL：数据库连接串，见 docs/部署/安装说明.md 第三步');

if (todo.length) {
  console.log('\n还要你手工填（用记事本或任何文本编辑器打开项目根目录的 .env 文件）：');
  for (const t of todo) console.log(`  · ${t}`);
  console.log('\n填好后接着做：npx prisma migrate deploy → npm run seed → npm run bank -- load samples/bank → npm run dev');
} else {
  console.log('\n✓ .env 已就绪。接着做：npx prisma migrate deploy → npm run seed → npm run bank -- load samples/bank → npm run dev');
}
