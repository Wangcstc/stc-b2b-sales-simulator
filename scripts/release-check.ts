/**
 * 发布检查（`npm run release:check`）。需求文档第十二节、阶段 7.2。对外发布（推到公开仓库、打包给客户）前必须过。
 *
 *   ① 题目：现在的文件和**全部提交历史**里，samples/ 以外不许有一道题、一份背调包
 *   ② 密钥：不许有 .env 之类的文件，不许有像真密钥、带口令外网连接串的串
 *   ③ 客户黑名单：**必须配**（BLACKLIST_FILE 或 DRAWER_MASK_FILE，名单放在仓库外），工作区与全部历史零命中
 *   ④ 版本号：各处一致（等同 npm run check:version）
 *   ⑤ 不该进来的路径：workspace/、构建产物
 *   ⑥ 许可证：LICENSE（AGPL-3.0 全文）、COMMERCIAL.md（商用授权说明，联系方式要填好）
 *
 * 和 `check:blacklist` 的区别：那个是日常提交前的门，没配名单就跳过；这个是发布的门，没配名单直接不过。
 * 任何一项不过就 exit 1。
 */
import 'dotenv/config';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { isForbiddenPath, isQuestionPath, looksLikeQuestion, secretHits } from './release';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const fails: string[] = [];
const ok: string[] = [];
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

// ── 现在的文件 ──
const files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
const questionNow: string[] = [];
const secretNow: string[] = [];
for (const f of files) {
  if (isForbiddenPath(f)) fails.push(`⑤ 不该进发布包的文件：${f}`);
  if (isQuestionPath(f)) questionNow.push(f);
  // 目录的软链接（比如链过来的 node_modules）也会被列出来：只读普通文件
  if (!existsSync(f) || !statSync(f).isFile()) continue;
  const buf = readFileSync(f);
  if (isBinary(buf)) continue;
  const text = buf.toString('utf8');
  if (!isQuestionPath(f) && looksLikeQuestion(f, text)) questionNow.push(f);
  for (const h of secretHits(text)) secretNow.push(`${f}：${h}`);
}
if (questionNow.length) fails.push(`① 现在的文件里有 samples/ 以外的题目：${questionNow.slice(0, 8).join('、')}${questionNow.length > 8 ? ` 等 ${questionNow.length} 个` : ''}`);
else ok.push('① 现在的文件里没有 samples/ 以外的题目');
if (secretNow.length) fails.push(`② 疑似密钥：${secretNow.slice(0, 5).join('；')}`);
else ok.push('② 没有密钥文件和疑似密钥');

// ── 全部历史里出现过的路径 ──
const historyPaths = [...new Set(git('log', '--all', '--name-only', '--format=').split('\n').filter(Boolean))];
const questionHist = historyPaths.filter(isQuestionPath);
const forbiddenHist = historyPaths.filter(isForbiddenPath);
if (questionHist.length) fails.push(`① 提交历史里出现过题目文件 ${questionHist.length} 个（如 ${questionHist.slice(0, 3).join('、')}）：这个仓库不能直接发布，要从干净的树新建发布仓库`);
else ok.push('① 提交历史里没有题目文件');
if (forbiddenHist.length) fails.push(`② 提交历史里出现过不该提交的文件：${forbiddenHist.slice(0, 5).join('、')}`);

// ── 客户黑名单：发布时必须配 ──
const list = process.env.BLACKLIST_FILE || process.env.DRAWER_MASK_FILE;
if (!list || !existsSync(resolve(list))) {
  fails.push('③ 没配客户黑名单（BLACKLIST_FILE）：发布前必须用它扫一遍，名单放在仓库外');
} else {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-blacklist.ts'], { encoding: 'utf8', env: { ...process.env, BLACKLIST_FILE: resolve(list) } });
  if (r.status === 0) ok.push(`③ ${r.stdout.trim().replace(/^✓ /, '')}`);
  else fails.push(`③ 客户黑名单有命中：\n${(r.stderr || r.stdout).trim().split('\n').slice(1, 8).join('\n')}`);
}

// ── 许可证 ──
if (!existsSync('LICENSE') || !/GNU AFFERO GENERAL PUBLIC LICENSE/.test(readFileSync('LICENSE', 'utf8'))) fails.push('⑥ 缺 LICENSE（AGPL-3.0 全文）');
else if (!existsSync('COMMERCIAL.md')) fails.push('⑥ 缺 COMMERCIAL.md（商用授权说明）');
else if (/待填/.test(readFileSync('COMMERCIAL.md', 'utf8'))) fails.push('⑥ COMMERCIAL.md 里商用授权的联系方式还没填');
else ok.push('⑥ 许可证齐全：AGPL-3.0 ＋ 商用授权说明');

// ── 版本号 ──
const v = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-version.ts'], { encoding: 'utf8' });
if (v.status === 0) ok.push(`④ ${v.stdout.trim().split('\n').pop()?.replace(/^✓ /, '')}`);
else fails.push(`④ 版本号不一致：${(v.stdout + v.stderr).trim().split('\n').slice(0, 4).join('；')}`);

for (const o of ok) console.log(`✓ ${o}`);
if (fails.length) {
  console.error(`\n✗ 发布检查不通过（${fails.length} 项）：`);
  for (const f of fails) console.error(`  ${f}`);
  process.exitCode = 1;
} else console.log('\n✓ 发布检查通过，可以发布');
