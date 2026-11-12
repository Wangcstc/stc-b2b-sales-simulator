/**
 * 抽屉命令行（`npm run drawer -- <命令>`）。逻辑全在 drawer/，这里只解析参数、打印结果。
 *
 *   ingest  <批次> <文件或目录…>        投料：聊天导出件 .html（或已脱敏的 redacted.json）、产品表 .xlsx、公司信息表 .xlsx（批次不存在就新建）
 *           [--variants N] [--budget 元] [--keep-raw]   新建批次时的设置
 *           [--mask "自家公司名,品牌名,业务员昵称"]  本批脱敏词表（只用于脱敏，不进题库包）
 *           [--mask-file <词表文件>]             同上，从文件读（一行一个词）；不写就用 .env 的 DRAWER_MASK_FILE
 *   estimate <批次>                     开工前预估要花多少钱
 *   run     <批次> [--limit N]           加工：归型 → 起草 → 质检校准 → 出确认卡 →（采用后）变体
 *   status  <批次>                       进度
 *   reviews <批次>                       列出还没答的选择题卡
 *   sheet   <批次>                       生成审题单（Markdown，写在批次目录里），确认前先看题
 *   answer  <批次> <卡号> <选项> [意见]   答一张卡；选项写 other 时要带意见
 *   answer  <批次> --all-recommended     演习题的卡全部按推荐处理（考试题必须逐道确认）
 *   retry   <批次> [素材号…]            重做出错的素材（已归型的重新起草，会再花钱）
 *   pack    <批次,批次…> --version 主.次.修 [--bank-id bank-xxxxxxxx] [--base <旧题库包>] [--strip-source]
 *   list                                 列出全部批次
 *
 * 工作区默认在 workspace/drawer/（不进 git），可用环境变量 DRAWER_DIR 改。
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpenAiLlm,
  Store,
  answer,
  answerAllRecommended,
  createBatch,
  estimate,
  ingest,
  readMaskFile,
  pack,
  retry,
  reviewSheet,
  run,
  status,
  type ReviewCard,
} from '../drawer/index';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : '';
};

function printCard(c: ReviewCard) {
  console.log(`\n[${c.id}] ${c.question}`);
  console.log(`    理由：${c.reason}`);
  for (const o of c.options) console.log(`    ${o.recommended ? '★' : ' '} ${o.key.padEnd(10)} ${o.label}${o.effect ? `（${o.effect}）` : ''}`);
  if (c.batchable) console.log('    （演习题：可用 --all-recommended 一起按推荐处理）');
}

async function main() {
  const store = new Store();
  const cmd = argv.shift();
  switch (cmd) {
    case 'ingest': {
      const variants = flag('variants');
      const budget = flag('budget');
      const keepRaw = flag('keep-raw') !== undefined;
      const mask = flag('mask');
      const maskFile = flag('mask-file') ?? (process.env.DRAWER_MASK_FILE || undefined);
      const [batchId, ...paths] = argv;
      if (!batchId || !paths.length) throw new Error('用法：npm run drawer -- ingest <批次> <文件或目录…>');
      createBatch(store, batchId, {
        ...(variants !== undefined ? { variantsPerMother: Number(variants) } : {}),
        ...(budget !== undefined ? { budgetCny: Number(budget) } : {}),
        ...(keepRaw ? { keepRaw } : {}),
      });
      const terms = [
        ...(mask ? mask.split(/[,，]/).map((x) => x.trim()).filter(Boolean) : []),
        ...(maskFile ? readMaskFile(maskFile) : []),
      ];
      if (terms.length) {
        // 本批脱敏词表：只用于脱敏，只存在工作区的批次设置里，不进题库包
        const b = store.getBatch(batchId);
        b.config.maskTerms = [...new Set([...(b.config.maskTerms ?? []), ...terms])];
        store.saveBatch(b);
        console.log(`· 本批脱敏词表 ${b.config.maskTerms.length} 个词${maskFile ? `（含词表文件 ${maskFile}）` : ''}`);
      }
      const r = await ingest(store, batchId, paths);
      console.log(`✓ 投料：聊天 ${r.chats} 份${r.preRedacted ? `（其中已脱敏素材 ${r.preRedacted} 份，只补跑当前脱敏规则）` : ''}（重复 ${r.duplicates} 份已略过）${r.products !== null ? `｜产品 ${r.products} 个` : ''}${r.company ? '｜公司信息' : ''}`);
      if (r.ignored.length) console.log(`  不认识、没收：${r.ignored.join('、')}`);
      if (!(store.getBatch(batchId).config.maskTerms ?? []).length) {
        console.log('  ⚠ 本批没有脱敏词表：自家公司名、品牌名、业务员的英文名和小名、工厂所在城市，正则抓不到。');
        console.log('    下一批投料时用 --mask "词1,词2" 或 --mask-file <词表文件> 带上，或者在 .env 配 DRAWER_MASK_FILE 一劳永逸。');
        console.log('    这一批已经脱敏完了：审题时看到自家名字，就把这一批删掉、带上词表重投');
      }
      const s = status(store, batchId);
      console.log(`  素材状态：${JSON.stringify(s.items)}`);
      if (s.pendingReviews.length) console.log(`  有 ${s.pendingReviews.length} 张卡等你确认：npm run drawer -- reviews ${batchId}`);
      return;
    }
    case 'estimate': {
      const e = estimate(store, argv[0]!);
      console.log(`${e.materials} 份素材 ｜ 约 ${(e.inputTokens / 1e6).toFixed(2)}M 输入 token、${(e.outputTokens / 1e6).toFixed(2)}M 输出 token`);
      console.log(`  其中母题 ${(e.mothers.inputTokens / 1e6).toFixed(2)}M / ${(e.mothers.outputTokens / 1e6).toFixed(2)}M，其余是考试变体（按全部采用估，是上限）`);
      console.log(e.pricesConfigured ? `预估花费约 ${e.costCny} 元（按空闲时段单价、实测每道题平均 2.4 次调用才过闸估）` : '没配单价（PRICE_* 环境变量），只能估 token');
      if (e.pricesConfigured && Number(process.env.PRICE_PEAK_MULTIPLIER) > 1) {
        console.log(`  高峰时段（北京时间工作日 9–12、14–18）单价 ×${process.env.PRICE_PEAK_MULTIPLIER}：晚上或周末跑更省`);
      }
      return;
    }
    case 'run': {
      const limit = flag('limit');
      const r = await run(store, argv[0]!, new OpenAiLlm(), {
        ...(limit ? { limit: Number(limit) } : {}),
        onProgress: (m) => console.log(m),
      });
      console.log(`\n${r.status === 'paused' ? '⏸ 暂停（预算到了）' : '✓ 这一轮做完了'} ｜ 处理 ${r.processed} 份 ｜ 调用 ${r.usage.calls} 次 ｜ 已花 ${r.usage.costCny} 元 ｜ 待确认 ${r.pendingReviews} 张卡`);
      return;
    }
    case 'status': {
      const s = status(store, argv[0]!);
      console.log(`批次 ${s.batch.id}（${s.batch.status}）｜ 已花 ${s.batch.usage.costCny} 元，调用 ${s.batch.usage.calls} 次`);
      console.log(`素材：${JSON.stringify(s.items)}`);
      console.log(`题目：${JSON.stringify(s.questions)}`);
      console.log(`待确认：${s.pendingReviews.length} 张卡`);
      for (const l of s.batch.log.slice(-8)) console.log(`  ${l.at.slice(0, 16)} ${l.msg}`);
      return;
    }
    case 'reviews': {
      const s = status(store, argv[0]!);
      if (!s.pendingReviews.length) console.log('没有待确认的卡');
      s.pendingReviews.forEach(printCard);
      return;
    }
    case 'sheet': {
      const { markdown, count } = reviewSheet(store, argv[0]!);
      const out = join(store.batchDir(argv[0]!), '审题单.md');
      writeFileSync(out, markdown, 'utf8');
      console.log(`✓ 审题单：${count} 道待确认的题\n  ${out}`);
      return;
    }
    case 'answer': {
      const all = flag('all-recommended') !== undefined;
      const [batchId, cardId, option, ...rest] = argv;
      if (all) {
        const done = answerAllRecommended(store, batchId!);
        console.log(`✓ 按推荐处理了 ${done.length} 张演习题的卡`);
      } else {
        const c = answer(store, batchId!, cardId!, option!, rest.join(' ') || undefined);
        console.log(`✓ ${c.id} → ${c.answer!.option}`);
      }
      return;
    }
    case 'retry': {
      const [batchId, ...ids] = argv;
      const done = retry(store, batchId!, ids);
      console.log(done.length ? `✓ 重做：${done.map((x) => `${x.id}（${x.materialId}）`).join('、')}，下一步 npm run drawer -- run ${batchId}` : '没有出错的素材');
      return;
    }
    case 'pack': {
      const version = flag('version');
      const bankId = flag('bank-id');
      const base = flag('base');
      const strip = flag('strip-source') !== undefined;
      if (!version) throw new Error('用法：npm run drawer -- pack <批次,批次…> --version 主.次.修');
      const r = pack(store, argv[0]!.split(','), {
        bankVersion: version,
        ...(bankId ? { bankId } : {}),
        ...(base ? { base } : {}),
        stripSource: strip,
      });
      console.log(`✓ 题库包 ${r.manifest.bank_id} v${r.manifest.bank_version}：共 ${r.manifest.counts.total} 道（本次新增 ${r.added}）`);
      console.log(`  ${r.dir}`);
      if (Object.keys(r.renumbered).length) console.log(`  与旧题撞号、已顺延：${Object.entries(r.renumbered).map(([a, b]) => `${a}→${b}`).join('、')}`);
      if (r.forcedDrill.length) console.log(`  暂不进考试或落不进考试槽位的，已放进演习池：${r.forcedDrill.join('、')}`);
      // 演习不设下限：有几道练几道。考试按槽位提示还差什么，只提示、不拦
      console.log(`  演习：${r.drill} 道，装进柜子就能练。以后有新聊天随时投进来，题越多越不容易撞题`);
      const gaps = r.exam.filter((s) => !s.ready);
      if (!gaps.length) console.log('  考试：三个槽位都凑齐了，可以开考');
      else {
        console.log('  考试：还没凑齐（凑齐前开不了考，演习不受影响），差的是：');
        for (const s of gaps) {
          const lack = [
            ...(s.questions < s.needQuestions ? [`题 ${s.questions}/${s.needQuestions} 道`] : []),
            ...(s.types < s.needTypes ? [`题型 ${s.types}/${s.needTypes} 种`] : []),
          ];
          const names = s.missingTypes.map((t) => t.name);
          const hint = names.length ? `；还没有的题型：${names.slice(0, 6).join('、')}${names.length > 6 ? ' 等' : ''}` : '';
          console.log(`    · ${s.label}：${lack.join('，')}${hint}`);
        }
        console.log('    碰到这几类买家的聊天，下次优先投进来。每道母题会衍生几道考试题，不用凑很多份');
      }
      console.log(`  装进柜子：npm run bank -- load "${r.dir}"`);
      return;
    }
    case 'list': {
      for (const id of store.listBatches()) {
        const s = status(store, id);
        console.log(`${id.padEnd(28)} ${s.batch.status.padEnd(8)} 素材 ${s.batch.items.length} ｜ 待确认 ${s.pendingReviews.length} ｜ 已花 ${s.batch.usage.costCny} 元`);
      }
      return;
    }
    default:
      console.log('用法见 scripts/drawer.ts 文件头，或 docs/操作单/抽屉使用说明.md');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
