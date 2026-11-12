/**
 * 升版本号（`npm run version:bump -- <major|minor|patch> "这次改了什么"`）
 *
 * 一次把所有该改的地方改齐，改完立刻跑 `check:version` 自检：
 *   · package.json / package-lock.json 的版本号
 *   · README 顶部的 `> vX.Y.Z · 日期` 与下一行说明
 *   · CHANGELOG.md 顶部新增一节
 *   · docs/ 下文档开头的「适用系统版本」「对应代码版本」
 *
 * ★ 只替换匹配到的那几处，不碰换行符 ★ 仓库里有一批文件是 CRLF；Node 读写文件
 * 不会转换换行符，只要不整文件重新生成，diff 就只有改到的那几行。
 *
 * git 标签不在这里打：标签打在提交上，要等这一版的改动全部提交之后再打。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [level, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim();

if (!['major', 'minor', 'patch'].includes(level ?? '') || !note) {
  console.log('用法：npm run version:bump -- <major|minor|patch> "这次改了什么"');
  process.exit(1);
}

const pkgPath = join(ROOT, 'package.json');
const current = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version);
const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.log(`✗ 当前版本「${current}」不是 主.次.修订 格式`);
  process.exit(1);
}
let [maj, min, pat] = m.slice(1).map(Number) as [number, number, number];
if (level === 'major') [maj, min, pat] = [maj + 1, 0, 0];
if (level === 'minor') [min, pat] = [min + 1, 0];
if (level === 'patch') pat += 1;
const next = `${maj}.${min}.${pat}`;
const today = new Date().toISOString().slice(0, 10);

/** 只替换匹配到的地方，文件其余部分（包括换行符）原样保留 */
function replaceBytes(
  file: string,
  from: RegExp,
  to: (match: string) => string,
  expectAtLeast = 1,
  limit = Number.POSITIVE_INFINITY,
): number {
  const text = readFileSync(file, 'utf8');
  let count = 0;
  const out = text.replace(from, (s) => {
    if (count >= limit) return s;
    count += 1;
    return to(s);
  });
  if (count < expectAtLeast) {
    console.log(`✗ ${file.slice(ROOT.length + 1)} 里没找到要改的版本号`);
    process.exit(1);
  }
  writeFileSync(file, out, 'utf8');
  return count;
}

const esc = current.replace(/\./g, '\\.');

// package.json：只改第一个 "version"
replaceBytes(pkgPath, new RegExp(`"version": "${esc}"`), () => `"version": "${next}"`);
// package-lock.json：只改根上的两处（文件最前面的两次出现）。
// ★ 不能全局替换 ★ 依赖里恰好也有同版本号的包（比如某个包正好是 8.0.0），全局替换会把它们一起改坏。
replaceBytes(join(ROOT, 'package-lock.json'), new RegExp(`"version": "${esc}"`, 'g'), () => `"version": "${next}"`, 2, 2);

// README：版本行 + 下一行说明
const readme = join(ROOT, 'README.md');
replaceBytes(
  readme,
  /^> v\d+\.\d+\.\d+ · \d{4}-\d{2}-\d{2}(\r?\n)> [^\r\n]*/m,
  (s) => {
    const eol = s.includes('\r\n') ? '\r\n' : '\n';
    return `> v${next} · ${today}${eol}> ${note}`;
  },
);

// CHANGELOG：在第一个 `## v` 小节前插入新一节
const changelog = join(ROOT, 'CHANGELOG.md');
replaceBytes(changelog, /^## v\d+\.\d+\.\d+/m, (s) => `## v${next} · ${today}\n\n${note}\n\n---\n\n${s}`);

// docs：文档开头 20 行里的版本声明
function walkMd(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}
for (const file of walkMd(join(ROOT, 'docs'))) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const head = lines.slice(0, 20).join('\n');
  const fixed = head
    .replace(/(适用系统版本:[^\n]*?v)\d+\.\d+(?:\.\d+)?/g, `$1${next}`)
    .replace(/stc-b2b-sales-simulator@\d+\.\d+\.\d+/g, `stc-b2b-sales-simulator@${next}`);
  if (fixed !== head) {
    writeFileSync(file, [fixed, ...lines.slice(20)].join('\n'), 'utf8');
  }
}

console.log(`✓ 版本号 ${current} → ${next}。CHANGELOG 里已加一节，记得把这一版的改动补全。`);
try {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/check-version.ts'], { cwd: ROOT, stdio: 'inherit' });
} catch {
  process.exit(1);
}
