/**
 * 版本号一致性检查（`npm run check:version`）
 *
 * ★ 唯一真源是 package.json 的 version ★ 其余各处必须和它一模一样：
 *   1. package-lock.json 的根版本号（两处）
 *   2. 页尾：AppShell 必须从 package.json 读，不许手写版本号
 *   3. README 顶部的 `> vX.Y.Z · 日期` 那一行
 *   4. CHANGELOG.md 最上面那一节 `## vX.Y.Z`
 *   5. git 标签：vX.Y.Z 要么还没打（正在开发这一版），要么就打在当前提交上
 * 外加文档里写明「适用系统版本」「对应代码版本」的地方。
 *
 * ★ 每一次修改都要升版本号 ★ 所以下面两种情况也算不通过：
 *   · 当前版本的标签已经打在别的提交上——这个版本号已经发过，不能再用；
 *   · 当前版本的标签打在当前提交上，但工作区还有未提交的修改——改了东西却没升号。
 *   · 当前版本比已有的最高标签还低——版本号只增不减。
 *
 * 任何一项不通过就 exit 1。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const problems: string[] = [];
const notes: string[] = [];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---- 真源 ----
const version = String(JSON.parse(read('package.json')).version ?? '');
if (!SEMVER.test(version)) {
  console.log(`✗ package.json 的 version「${version}」不是 主.次.修订 格式`);
  process.exit(1);
}

// ---- 1. package-lock.json ----
const lock = JSON.parse(read('package-lock.json'));
if (lock.version !== version) problems.push(`package-lock.json 根版本是 ${lock.version}，应为 ${version}`);
if (lock.packages?.['']?.version !== version) {
  problems.push(`package-lock.json 的 packages[""].version 是 ${lock.packages?.['']?.version}，应为 ${version}`);
}

// ---- 2. 页尾 ----
const shell = read('src/components/AppShell.tsx');
if (!/const VERSION = `v\$\{pkg\.version\}`/.test(shell)) {
  problems.push('页尾的 VERSION 没有直接读取 package.json 的完整版本号（应为 `v${pkg.version}`）');
}

// ---- 3. README ----
const readmeVer = read('README.md').match(/^> v(\d+\.\d+\.\d+) · \d{4}-\d{2}-\d{2}$/m)?.[1];
if (!readmeVer) problems.push('README 顶部没有找到 `> vX.Y.Z · YYYY-MM-DD` 那一行');
else if (readmeVer !== version) problems.push(`README 顶部写的是 v${readmeVer}，应为 v${version}`);

// ---- 4. CHANGELOG ----
if (!existsSync(join(ROOT, 'CHANGELOG.md'))) problems.push('缺少 CHANGELOG.md');
else {
  const top = read('CHANGELOG.md').match(/^## v(\d+\.\d+\.\d+)\b/m)?.[1];
  if (!top) problems.push('CHANGELOG.md 里没有找到 `## vX.Y.Z` 小节');
  else if (top !== version) problems.push(`CHANGELOG.md 最上面一节是 v${top}，应为 v${version}（这次改了什么要先写进去）`);
}

// ---- 文档里写明的版本 ----
function walkMd(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}
if (existsSync(join(ROOT, 'docs'))) {
  for (const file of walkMd(join(ROOT, 'docs'))) {
    const rel = relative(ROOT, file);
    // ★ 只看文档开头 20 行 ★ 版本声明都写在开头；正文里的修订记录是历史，
    // 例如「v1.0 成文时对应 drill-system@4.0.0」，那是当时的事实，不能跟着改。
    const text = readFileSync(file, 'utf8').split('\n').slice(0, 20).join('\n');
    for (const m of text.matchAll(/适用系统版本:[^\n]*?v(\d+\.\d+(?:\.\d+)?)/g)) {
      if (m[1] !== version) problems.push(`${rel}：适用系统版本写的是 v${m[1]}，应为 v${version}`);
    }
    for (const m of text.matchAll(/stc-b2b-sales-simulator@(\d+\.\d+\.\d+)/g)) {
      if (m[1] !== version) problems.push(`${rel}：对应代码版本写的是 ${m[1]}，应为 ${version}`);
    }
  }
}

// ---- 5. git 标签 ----
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let inGit = true;
try {
  git('rev-parse', '--is-inside-work-tree');
} catch {
  inGit = false;
  notes.push('不在 git 仓库里（例如从压缩包解出来的），跳过标签检查');
}

if (inGit) {
  const cmp = (a: string, b: string) => {
    const x = a.match(SEMVER)!.slice(1).map(Number);
    const y = b.match(SEMVER)!.slice(1).map(Number);
    for (let i = 0; i < 3; i += 1) {
      const d = (x[i] ?? 0) - (y[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  const tags = git('tag', '--list', 'v*')
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => SEMVER.test(t));
  const highest = tags.sort(cmp).at(-1);

  if (highest && cmp(version, highest) < 0) {
    problems.push(`当前版本 ${version} 比已有的最高标签 v${highest} 还低——版本号只增不减`);
  }

  if (tags.includes(version)) {
    const tagCommit = git('rev-list', '-n', '1', `v${version}`);
    const head = git('rev-parse', 'HEAD');
    if (tagCommit !== head) {
      problems.push(`v${version} 已经发布过（标签在别的提交上）。这次修改要先升版本号`);
    } else {
      let dirty = false;
      try {
        git('diff', '--quiet', 'HEAD');
      } catch {
        dirty = true;
      }
      if (dirty) problems.push(`v${version} 已经打过标签，但工作区还有未提交的修改。改了东西就要升版本号`);
      else notes.push(`v${version} 标签就在当前提交上`);
    }
  } else {
    notes.push(`v${version} 还没打标签（正在开发这一版）`);
  }
}

// ---- 结果 ----
for (const n of notes) console.log(`· ${n}`);
if (problems.length === 0) {
  console.log(`✓ 版本号一致：v${version}`);
  process.exit(0);
}
for (const p of problems) console.log(`✗ ${p}`);
console.log(`\n✗ 版本号检查不通过：${problems.length} 处`);
process.exit(1);
