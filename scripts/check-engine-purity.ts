/**
 * 纯判定层无菌区核查（技术方案 12.1 / 系统总览 1.4 硬约束②）
 *
 * ★ 无菌区不许 import 数据库 / LLM / Next / React / 文件系统 ★
 * 这条做了，回放工具才成立、调参才做得了——判定必须是「喂什么判什么」的纯函数。
 *
 * ★ 2026-08-25 从 engine/ 扩大到 settlement-decide.ts ★
 * 那天量了一遍全项目，发现一条 1:1 的相关性：**prisma 调用数为 0 的模块全都有测试，
 * 大于 0 的全都没有**。不是巧合——和取数缠在一起的判定逻辑根本没法测。
 * 于是把每晚结算的判定核心从 `settlement.ts` 里拆出来，照 engine/ 这套办。
 * 拆完必须有人守着：下次谁图省事在里面 `await prisma.xxx` 查一把，
 * 它就又变回不可测的样子——那才是真正的倒退，而且不会有任何报错提醒你。
 *
 * ★ 为什么不靠 ESLint（它本来就是这么写的）★
 * `eslint.config.mjs` 里那条 `no-restricted-imports` 一直在，但 2026-08-24 实测
 * **整个 ESLint 跑不起来**：`eslint-config-next` 依赖的 `@rushstack/eslint-patch@1.16.1`
 * 认不出 ESLint 9.39 的内部布局，一上来就抛
 * 「Failed to patch ESLint because the calling module was not recognized」。
 * 更糟的是 `next lint` 把这个错**当成警告打印完就 exit 0**——
 * 也就是说这条守卫已经静默失效了一段时间，而且不会有任何东西报错。
 *
 * 所以把这一条搬成脚本：不依赖任何插件、`npm run verify` 里硬失败。
 * ESLint 哪天修好了，两边同时守着也没有坏处——同一条规则，两个执行者。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 整个目录都是无菌区 */
const PURE_DIRS = [join(ROOT, 'engine')];

/**
 * 单独列名的无菌文件。
 * ★ 新增纯判定模块请加到这里 ★ 判据很简单：这个文件里的函数是不是「同样输入永远同样输出」。
 * 是，就加进来并补上测试；不是，那它属于外壳，不该起 *-decide 这种名字。
 */
const PURE_FILES = [
  join(ROOT, 'src', 'lib', 'settlement-decide.ts'),
  join(ROOT, 'src', 'lib', 'training-decide.ts'),
  join(ROOT, 'src', 'lib', 'turn-decide.ts'),
];

/** 与 eslint.config.mjs 里那条 no-restricted-imports 一一对应，改一处要改两处 */
const RULES: { test: (spec: string) => boolean; why: string }[] = [
  { test: (s) => /^@prisma\//.test(s) || /(^|\/)(db|prisma)$/.test(s), why: '引擎层不许碰数据库' },
  { test: (s) => s === 'openai' || /(^|\/)llm(\/|$)/.test(s), why: '引擎层不许碰 LLM' },
  { test: (s) => /^(next|react|react-dom)(\/|$)/.test(s), why: '引擎层不许碰 Next/React' },
  { test: (s) => /^(node:)?(fs|path|child_process|os)(\/|$)/.test(s), why: '引擎层必须是纯函数，不许碰文件系统' },
];

/**
 * ★ 第二组：客户端可跑 ★（2026-08-28 第四批，D6 选项 A）
 *
 * 脱敏必须在客户那一侧跑——服务端只收脱敏后的 JSON。客户的聊天记录里有客户名单
 * 和真实成交价，那是他最不愿意上传的东西；做成浏览器端跑既是合规底线，
 * 也是这个产品最好卖的一个点。
 *
 * 这一组的规矩和无菌区**不一样**：浏览器里 import React 完全正常，
 * 不正常的是 node 内建——**只要模块顶部有一行 `import 'node:fs'`，
 * 整个模块就打不进浏览器包**，哪怕那行 import 的东西一次都没被调用。
 * 而这件事不会在开发时报错，只会在某天打包时才炸。
 */
const CLIENT_SAFE_FILES = [
  join(ROOT, 'drawer', 'ingest', 'chat-parse-core.ts'),
  join(ROOT, 'drawer', 'ingest', 'chat-redact.ts'),
  join(ROOT, 'drawer', 'browser.ts'),
  join(ROOT, 'drawer', 'types.ts'),
];

/** 客户端可跑的那一组只查这一条：不许碰 node 内建 */
const CLIENT_RULES: { test: (spec: string) => boolean; why: string }[] = [
  {
    test: (s) => /^(node:)?(fs|path|child_process|os|crypto|http|https|net|worker_threads)(\/|$)/.test(s),
    why: '这个文件要能在浏览器里跑，不许 import node 内建（脱敏在客户那一侧跑，见 D6）',
  },
];

/** `import x from 'y'` / `export * from 'y'` / `await import('y')` 三种写法都要抓 */
const SPEC_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

let hits = 0;
let scanned = 0;

function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    // 测试文件本来就要造数据、读夹具，与 eslint 那条的 ignores 保持一致
    if (/\.test\.tsx?$/.test(name)) continue;
    checkFile(p);
  }
}

function checkFile(p: string, rules: typeof RULES = RULES) {
  scanned += 1;
  const rel = p.slice(ROOT.length + 1).replaceAll('\\', '/');
  const text = readFileSync(p, 'utf8');
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
    for (const m of line.matchAll(SPEC_RE)) {
      const spec = m[1]!;
      for (const rule of rules) {
        if (!rule.test(spec)) continue;
        console.log(`✗ ${rel}　import '${spec}'　—— ${rule.why}`);
        hits += 1;
      }
    }
  }
}

for (const dir of PURE_DIRS) walk(dir);
for (const file of PURE_FILES) checkFile(file);
const pureScanned = scanned;
for (const file of CLIENT_SAFE_FILES) checkFile(file, CLIENT_RULES);
console.log(
  hits === 0
    ? `✓ 通过：纯判定层 ${pureScanned} 个源文件没有一条越界 import（数据库 / LLM / Next / 文件系统）
` +
        `✓ 通过：客户端可跑的 ${scanned - pureScanned} 个源文件没有 node 内建 import（脱敏要能在浏览器里跑）`
    : `✗ 被破了 ${hits} 处`,
);
process.exit(hits === 0 ? 0 : 1);
