/**
 * 菜单里的每个页面，必须真的在仓库里。
 *
 * ★ 出过的事 ★ .gitignore 里一行 `coverage/`（本意是忽略测试覆盖率报告）把
 * `src/app/workshop/coverage/` 这个页面也忽略了：页面文件在本机好好的、一切正常，
 * 但从来没进过 git。别人从 GitHub 克隆下来，点「题库工坊 → 覆盖」就是 404；
 * 自己本机永远测不出来。
 *
 * 这份测试查两件事：
 *   1. 题库工坊每个菜单项都有对应的 page.tsx；
 *   2. 这些文件没有被 .gitignore 忽略（不在 git 仓库里，例如压缩包解开的，就只查第 1 条）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const hrefs = [...readFileSync(join(ROOT, 'src/app/workshop/WorkshopShell.tsx'), 'utf8').matchAll(/href:\s*'(\/[^']+)'/g)].map((m) => m[1]!);
const pageFile = (href: string) => `src/app${href}/page.tsx`;

function ignoredByGit(path: string): boolean | null {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    return null;
  }
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT, stdio: 'ignore' });
    return true; // 退出码 0 = 被忽略
  } catch {
    return false;
  }
}

describe('题库工坊菜单的每一页都在仓库里', () => {
  it('读到了菜单项', () => {
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
  });

  for (const href of hrefs) {
    it(`${href} 有页面文件，且没被 .gitignore 忽略`, () => {
      const file = pageFile(href);
      expect(existsSync(join(ROOT, file)), `${file} 不存在`).toBe(true);
      expect(ignoredByGit(file), `${file} 被 .gitignore 忽略了：别人克隆下来会是 404`).not.toBe(true);
    });
  }
});
