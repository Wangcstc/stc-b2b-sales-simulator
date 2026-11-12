/**
 * 客户黑名单扫描（`npm run check:blacklist`）。匹配口径见 `blacklist.ts`。
 *
 *   不带参数          扫工作区（进 git 的文件和还没 add 的新文件，.gitignore 里的不扫）+ 全部提交历史（含提交说明）。`npm run verify` 里跑这个
 *   --staged          只扫这次要提交的文件（git 提交前钩子用，快）
 *   --message <文件>  扫提交说明（git 提交说明钩子用）
 *
 * 词表路径：环境变量 `BLACKLIST_FILE`，没配就用 `DRAWER_MASK_FILE`。两个都没配（比如别人拿到开源仓库）就跳过、不报错。
 * 本机钩子装法：`npm run hooks:install`（写进 .git/hooks/，不进仓库）。
 * 命中就退出码 1，提交被拦下。
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readMaskFile } from '../drawer/index';
import { compileTerms, findHits } from './blacklist';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
const isBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

function main(): number {
  const file = process.env.BLACKLIST_FILE || process.env.DRAWER_MASK_FILE;
  if (!file || !existsSync(resolve(file))) {
    console.log('· 没配客户黑名单（BLACKLIST_FILE / DRAWER_MASK_FILE），跳过黑名单扫描');
    return 0;
  }
  const terms = compileTerms(readMaskFile(resolve(file)));
  const args = process.argv.slice(2);
  const found: string[] = [];
  const scan = (where: string, text: string) => {
    for (const h of findHits(text, terms)) found.push(`${where}:${h.line}  命中「${h.term}」  ${h.text}`);
  };

  if (args[0] === '--message') {
    const msg = readFileSync(args[1]!, 'utf8').split('\n').filter((l) => !l.startsWith('#')).join('\n');
    scan('提交说明', msg);
  } else if (args[0] === '--staged') {
    for (const path of git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0').filter(Boolean)) {
      const buf = execFileSync('git', ['show', `:${path}`], { maxBuffer: 512 * 1024 * 1024 });
      if (!isBinary(buf)) scan(path, buf.toString('utf8'));
    }
  } else {
    // 还没 add 的新文件也扫：等它进了暂存区才报，人已经写了一整天了
    for (const path of git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean)) {
      if (!existsSync(path) || !statSync(path).isFile()) continue;
      const buf = readFileSync(path);
      if (!isBinary(buf)) scan(path, buf.toString('utf8'));
    }
    // 历史：每个提交的说明 + 改动。工作区干净了不等于历史干净，历史里的东西推出去一样能被翻出来
    let commit = '';
    let lineNo = 0;
    for (const line of git('log', '--all', '-p', '--format=@@COMMIT %h%n%B').split('\n')) {
      if (line.startsWith('@@COMMIT ')) {
        commit = line.slice(9);
        lineNo = 0;
        continue;
      }
      lineNo += 1;
      for (const h of findHits(line, terms)) found.push(`提交 ${commit} 第 ${lineNo} 行  命中「${h.term}」  ${h.text}`);
    }
  }

  if (found.length) {
    console.error(`✗ 客户黑名单命中 ${found.length} 处（词表：${file}）：`);
    for (const f of found.slice(0, 50)) console.error(`  ${f}`);
    if (found.length > 50) console.error(`  …还有 ${found.length - 50} 处`);
    console.error('  测试和注释里一律用虚构的人名、公司名、单号。已经进了历史的，要改写历史并清掉旧对象');
    return 1;
  }
  const scope = args[0] === '--message' ? '提交说明' : args[0] === '--staged' ? '本次提交的文件' : '工作区与全部提交历史';
  console.log(`✓ 客户黑名单（${terms.length} 个词）：${scope}无命中`);
  return 0;
}

process.exitCode = main();
