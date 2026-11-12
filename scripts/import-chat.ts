/**
 * 聊天记录导入端口：HTML 导出件 → 脱敏 → 结构化素材
 *
 *   npm run import:chat -- <文件或目录…> [选项]
 *
 * 选项：
 *   --extra "词1,词2=替换词"   额外要抹的词。自家公司名、业务员昵称、客户把名字
 *                              拼错的变体（IVVY=Peter），结构化字段里抽不到的都写这
 *   --out <目录>               输出目录，默认 imports/
 *   --force                    疑似漏网非空时仍然写出（默认拦住，逼你先看一眼）
 *
 * ★ 产出的是素材，不是人设 ★
 * 这一步只到「干净的结构化对话」为止。素材 → 人设还差一步设计：把客户主动说的话
 * 翻转成「问到才给」的暗牌、配解锁条件、补价格阶梯。那一步不能自动化——
 * 人设是评分的标尺，标尺得有人签字。
 *
 * ★ 同一个客户的多份记录必须一次导入 ★
 * 映射表不落盘（王老师裁定），化名只在单次进程内一致。分两次导入，同一个人会拿到
 * 两个化名，两份记录就再也拼不到一起了。
 */

import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChatFile, type RawChat } from '../drawer/index';
import { createRedactor, type RedactResult } from '../drawer/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv: string[]) {
  const files: string[] = [];
  let extra: string[] = [];
  let out = 'imports';
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--extra') extra = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') out = argv[++i] ?? out;
    else if (a === '--force') force = true;
    else if (!a.startsWith('--')) files.push(a);
  }
  return { files, extra, out, force };
}

/** 目录就把里面的 .html 全收了，方便整批业务员目录一次导入 */
function expand(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs)) {
        if (f.toLowerCase().endsWith('.html')) out.push(join(abs, f));
      }
    } else out.push(abs);
  }
  // 「_副本」「(1)」这类重复导出件去掉，同一个客户导两遍没意义
  return out.filter((f) => !/_副本\d*\.html$/i.test(f) && !/ \(\d+\)\.html$/i.test(f));
}

/**
 * 输出目录名。★ 必须唯一 ★ 撞名 = 后一个客户的素材覆盖前一个，且不报错。
 * 化名那边已经保证不重复了，这里再兜一道：slug 化会丢掉中间名的点和空格。
 */
function slugOf(chat: RawChat, i: number, seen: Set<string>): string {
  const name = String(chat.header['客户'] ?? '').trim();
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `import-${String(i + 1).padStart(3, '0')}`;
  let slug = base;
  for (let n = 2; seen.has(slug); n++) slug = `${base}-${n}`;
  seen.add(slug);
  return slug;
}

/** 素材摘要：不看全文也能判断这份值不值得做成人设 */
function digest(chat: RawChat) {
  const client = chat.messages.filter((m) => m.side === 'client');
  const me = chat.messages.filter((m) => m.side === 'me');
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  return {
    消息数: chat.messages.length,
    客户发言: client.length,
    我方发言: me.length,
    客户平均字数: client.length ? Math.round(client.reduce((a, m) => a + words(m.text), 0) / client.length) : 0,
    时间跨度: String(chat.header['时间范围'] ?? ''),
    是否成交: chat.order ? (chat.order.hasOrder ? '已成交' : '未成交') : '未知',
    有客户面板: Boolean(chat.customer),
    有画像: Boolean(chat.profile),
  };
}

async function main() {
  const { files, extra, out, force } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('用法：npm run import:chat -- <文件或目录…> [--extra "词=替换"] [--out 目录] [--force]');
    process.exit(1);
  }

  const targets = expand(files);
  console.log(`\n找到 ${targets.length} 份聊天记录，开始导入。`);
  console.log('★ 映射表不落盘，化名只在这一次进程里一致——同一个客户的多份记录务必一起导。\n');

  // 一个 redactor 跑完全部文件：同一个客户在不同文件里拿到同一个化名
  const redactor = createRedactor({ extraTerms: extra });
  const outDir = resolve(ROOT, out);
  mkdirSync(outDir, { recursive: true });

  const blocked: string[] = [];
  const seenSlugs = new Set<string>();
  const done: { slug: string; suspects: number }[] = [];
  const allSuspects = new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const file = targets[i]!;
    let res: RedactResult;
    try {
      res = redactor.redact(parseChatFile(file));
    } catch (e) {
      console.log(`✗ ${file}\n  解析失败：${(e as Error).message}`);
      continue;
    }

    const slug = slugOf(res.chat, i, seenSlugs);

    // ★ 残留自检不过就是硬失败 ★ --force 也不放行：这说明脱敏本身漏了，不是拿不准
    if (res.residue.length > 0) {
      console.log(`✗ ${slug}　脱敏自检未通过，已跳过：`);
      for (const r of res.residue) console.log(`    ${r}`);
      blocked.push(slug);
      continue;
    }

    for (const s of res.suspects) allSuspects.add(s);

    if (res.suspects.length > 0 && !force) {
      console.log(`⚠ ${slug}　有 ${res.suspects.length} 条疑似漏网，未写出（看下面清单，补 --extra 重跑，或 --force 放行）`);
      blocked.push(slug);
      continue;
    }

    const dir = join(outDir, slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'redacted.json'),
      JSON.stringify(
        {
          _comment:
            '已脱敏的聊天记录素材。真名↔化名映射未保存，不可还原。' +
            '这是做人设的原料，不是人设本身——暗牌、解锁条件、价格阶梯还得人工设计。',
          digest: digest(res.chat),
          audit: res.audit,
          chat: res.chat,
        },
        null,
        2,
      ),
      'utf8',
    );

    const d = digest(res.chat);
    console.log(
      `✓ ${slug.padEnd(28)} ${String(d.消息数).padStart(3)} 条 · 客户 ${String(d.客户发言).padStart(3)} 条 · ${d.是否成交}` +
        `${d.有画像 ? ' · 含画像' : ''}`,
    );
    done.push({ slug, suspects: res.suspects.length });
  }

  console.log(`\n───── 完成 ${done.length} / ${targets.length} ─────`);
  console.log(`输出目录：${outDir}`);

  if (allSuspects.size > 0) {
    console.log(`\n⚠ 疑似漏网（${allSuspects.size} 条）—— 正则抓不全正文里的人名，这份得人眼过：`);
    for (const s of [...allSuspects].slice(0, 60)) console.log(`    • ${s}`);
    console.log('\n  真是人名/公司名的，用 --extra 补上重跑，例如：');
    console.log('    npm run import:chat -- <文件> --extra "示例联系人,示例贸易公司"');
    console.log('  确认全是噪音（贸易术语、城市名、产品词），加 --force 放行。');
  }
  if (blocked.length > 0) console.log(`\n未写出：${blocked.join('、')}`);

  console.log('\n下一步：素材还不是人设。要把客户主动说的话翻转成「问到才给」的暗牌、');
  console.log('配解锁正则、补产品阶梯价，跑通一局验过，才能打包进题库。\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
