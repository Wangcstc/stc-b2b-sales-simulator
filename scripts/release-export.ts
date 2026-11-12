/**
 * 把当前版本导出到干净的发布仓库（`npm run release:export -- <发布仓库目录>`）。需求文档第十二节、阶段 7.4。
 *
 * ★ 为什么不直接发布开发仓库 ★ 开发仓库 v8.2 之前的提交历史里有旧题库（真实客户聊天改编的题），
 * 发布出去等于把题一起送人。发布仓库只收「打过版本号的文件快照」，每个版本一个提交，历史里干干净净。
 *
 * 做的事：
 *   ① 开发仓库必须干净、当前版本的标签就打在当前提交上（先 version:bump、提交、打标签）
 *   ② 发布仓库不存在就新建（git init）；存在就必须是干净的 git 仓库
 *   ③ 用 `git archive` 取出这个版本的文件，整个替换发布仓库里的文件（开发仓库删掉的，发布仓库也删）
 *   ④ 提交「vX.Y.Z」并打同名标签
 * 做完到发布仓库里跑 `npm ci && BLACKLIST_FILE=<名单> npm run release:check`，过了再推。
 * 这个脚本不推送任何东西。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('用法：npm run release:export -- <发布仓库目录>');
  process.exit(1);
}
const dest = resolve(target);
const here = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const there = (...a: string[]) => execFileSync('git', ['-C', dest, ...a], { encoding: 'utf8' }).trim();

const version = String(JSON.parse(readFileSync('package.json', 'utf8')).version);
const tag = `v${version}`;
if (here('status', '--porcelain')) throw new Error('开发仓库还有没提交的修改：先提交');
if (here('rev-parse', `${tag}^{commit}`) !== here('rev-parse', 'HEAD')) throw new Error(`${tag} 的标签不在当前提交上：先 npm run version:bump、提交、打标签`);
if (dest.startsWith(resolve('.') + '/')) throw new Error('发布仓库不能放在开发仓库里面');

if (!existsSync(dest)) {
  mkdirSync(dest, { recursive: true });
  there('init', '-q', '-b', 'main');
  console.log(`· 新建发布仓库 ${dest}`);
} else {
  if (!existsSync(resolve(dest, '.git'))) throw new Error(`${dest} 不是 git 仓库`);
  if (there('status', '--porcelain')) throw new Error('发布仓库里有没提交的修改：先处理');
  if (there('tag', '--list', tag)) throw new Error(`发布仓库里已经有 ${tag}：版本号只增不减、不复用`);
  // 整个替换：开发仓库删掉的文件，发布仓库也要删
  if (there('ls-files')) there('rm', '-r', '-q', '.');
}
// ★ 不用 `sh -c "git archive | tar"` ★ Windows 没有 sh。先写成 tar 文件再解开：
// git 自带 archive，Windows 10 起系统自带 tar.exe，Mac、Linux 都有 tar。
const tmp = mkdtempSync(join(tmpdir(), 'release-export-'));
const tarFile = join(tmp, `${tag}.tar`);
try {
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, tag]);
  execFileSync('tar', ['-xf', tarFile, '-C', dest]);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
there('add', '-A');
// 更新记录里这一版的第一段，做提交说明
const log = readFileSync('CHANGELOG.md', 'utf8').split(/\n## /)[1]?.split('\n').slice(1).join('\n').trim().split('\n\n')[0] ?? '';
execFileSync('git', ['-C', dest, '-c', 'user.name=STC', '-c', 'user.email=stc@example.com', 'commit', '-q', '-m', `${tag}\n\n${log}`]);
there('tag', tag);
console.log(`✓ 已导出 ${tag} 到 ${dest}（${there('rev-parse', '--short', 'HEAD')}）`);
console.log(`  下一步：cd "${dest}" && npm ci && BLACKLIST_FILE=<客户黑名单> npm run release:check`);
