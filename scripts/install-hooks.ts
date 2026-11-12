/**
 * 装本机 git 钩子（`npm run hooks:install`）：提交前扫这次要提交的文件，提交说明写完再扫一遍说明。
 * 钩子写在 .git/hooks/，不进仓库，每台机器装一次。已有同名钩子且不是这里装的，不覆盖。
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MARK = '# installed-by: npm run hooks:install';
const dir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim();
const hooks: Record<string, string> = {
  'pre-commit': 'npx tsx scripts/check-blacklist.ts --staged',
  'commit-msg': 'npx tsx scripts/check-blacklist.ts --message "$1"',
};

for (const [name, cmd] of Object.entries(hooks)) {
  const path = join(dir, name);
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(MARK)) {
    console.log(`· ${path} 已有别的钩子，没覆盖；请手工在里面加一行：${cmd}`);
    continue;
  }
  writeFileSync(path, `#!/bin/sh\n${MARK}\n# 客户黑名单扫描，见 scripts/check-blacklist.ts\n${cmd}\n`);
  chmodSync(path, 0o755);
  console.log(`✓ 已装 ${name}`);
}
