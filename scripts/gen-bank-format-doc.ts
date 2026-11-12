/**
 * 生成《题库格式规范》（`npm run gen:bank-format-doc`；`--check` 只比对不写，进 `npm run verify`）。
 *
 * ★ 字段清单、必填与否从 `standards/schema/*.schema.json` 读 ★ JSON Schema 是对外契约、是真源，
 * 文档是生成物：Schema 加了字段、文档没跟上，`--check` 就报错。字段的中文说明写在下面的 NOTES 里——
 * Schema 里新加的字段没写说明，生成也会报错，逼着把说明补上。
 * 题目字段到数据库列的对应（需求文档 9.3「字段一一对应」）也写在这里，改装入器时同步改。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', '题库格式规范.md');
const schema = (name: string) => JSON.parse(readFileSync(join(ROOT, 'standards', 'schema', `${name}.schema.json`), 'utf8')) as {
  required?: string[];
  properties: Record<string, { description?: string; type?: string | string[] }>;
};

const NOTES: Record<string, Record<string, string>> = {
  manifest: {
    format_version: '题库格式版本，现在是 1。格式不兼容地变了才升',
    syllabus_version: '出题时用的考纲版本',
    bank_id: '题库编号（`bank-` 加 12 位），同一家公司的题库各版本共用一个',
    bank_version: '题库版本号，主.次.修订，只增不减、不复用',
    drawer_version: '打包时抽屉的版本',
    generator: '谁打的包：drawer（抽屉）／ hand-crafted-sample（样品）／ legacy-migration（旧题库迁移）',
    created_at: '打包时间',
    counts: '题数统计：总数、演习、考试、背调包、各题型、各考试槽位（自动算，不用手填）',
    source_batches: '这一版包含了哪些加工批次',
  },
  persona: {
    id: '题目编号：题型编码-国家两字母-三位序号，如 A09-PL-001。同一题库里唯一，回炉改题编号不变',
    derived_from: '考试变体指向它的母题编号；母题不写',
    version: '题目内容自己的版本号（选填）',
    active: '`false` 表示停用：不进任何题池，打过的局照常能打开',
    skeleton: '题型骨架：题型编码与名称、局型（询盘局 / 跟进局）、默认难度、考点、参与评分的力。装入时以考纲为准',
    difficulty: '这道题自己的难度（简单 / 标准 / 困难），不写就用题型默认难度',
    pool_type: '`drill` 演习池 / `admission_exam` 考试池',
    open_card: '明牌：业务员一开局就能看到的买家信息与开场询盘（姓名、国家、公司、平台数据、询盘原文……）',
    product: '这道题谈的产品：型号、属性、阶梯价、起订量、交期、包装、认证。价格是 AI 买家判断报价的标准答案',
    hidden_card: '暗牌：买家藏着、要业务员问出来的信息。每张写明内容、解锁条件（正则）、泄露信号',
    leak_fallback: '业务员还没问到、买家差点说漏嘴时的兜底说法',
    distractors: '干扰项：买家会抛出、但不是关键的问题',
    customs_capability: '买家对清关、单证的熟悉程度（影响他会不会追问这类细节）',
    init_state: '开局状态：耐心、信任、兴趣（0–100）',
    rules_override: '这道题对通用规则的覆盖（少用）',
    exit_lines: '买家退出时说的话：超轮数、耐心耗尽、聊不动',
    quote_reactions: '买家对报价的反应：报得太早、报得太高、报得合理……',
    followup_reactions: '跟进局里买家对各种跟进动作的反应',
    language_style: '买家说话的风格（用词、句子长短、口头禅）',
    preset_elements: '跟进局的前情：之前已经谈定的六要素代码',
    verify_cases: '每张暗牌的验证用例：哪些话该解锁、哪些话不该解锁。装入前机器逐条验',
    _source: '来源备注：出自哪份脱敏素材、暗牌引的原话。对外导出可以剥掉',
  },
  'bg-package': {
    persona_id: '对应的题目编号',
    version: '背调包内容版本（选填）',
    ai_report: 'AI 背调报告（里面预埋一个错误结论，考业务员会不会核实）',
    website: '官网的样子（留一处矛盾）',
    social: '社交媒体的样子（留一处矛盾）',
    contacts: '联系方式（留一处矛盾）',
  },
  product: {
    model: '型号',
    name: '产品名（必填）',
    attributes: '产品属性：材质、尺寸、颜色……',
    page_price: '平台页面上标的价',
    price_tiers: '阶梯价：数量区间、单价、币种、贸易术语、港口',
    moq: '起订量',
    lead_time: '交期：样品、大货',
    packing: '包装：每箱几件、箱规、毛重净重、体积',
    certifications: '认证：名称与适用市场',
  },
  company: {
    company_type: '工厂 / 贸易公司 / 工贸一体',
    main_categories: '主营品类',
    province: '所在省份（不写城市，不写公司真名）',
    ports: '常用港口',
    capacity: '产能',
    certifications: '工厂认证',
    payment_terms: '接受的付款方式',
    oem_odm: '能不能做贴牌、定制',
    qc_process: '质检流程',
    after_sales: '售后政策',
    not_accepted: '不接的单（太小、太远、某些认证做不了……）',
    notes: '其他补充',
  },
};

const DB_MAP: [string, string][] = [
  ['id', '`PersonaVariant.variantId`'],
  ['skeleton.type_code', '`Persona.code`（题型行按考纲写，题目改不到它）'],
  ['active', '`PersonaVariant.enabledInBank`（当前版本里 `active` = 是当前版本且未停用）'],
  ['pool_type', '`PersonaVariant.poolType`（DRILL / ADMISSION_EXAM）'],
  ['difficulty', '`PersonaVariant.difficulty`'],
  ['open_card', '`PersonaVariant.openCard`'],
  ['hidden_card', '`PersonaVariant.hiddenCard`'],
  ['product', '`PersonaVariant.product`'],
  ['distractors', '`PersonaVariant.distractors`'],
  ['init_state', '`PersonaVariant.initState`'],
  ['exit_lines', '`PersonaVariant.exitLines`'],
  ['quote_reactions', '`PersonaVariant.quoteReactions`'],
  ['language_style', '`PersonaVariant.languageStyle`'],
  ['preset_elements', '`PersonaVariant.presetElements`'],
  ['背调包', '`BgPackage`（按 persona_id 挂到题目上）'],
  ['manifest', '`BankVersion`（题库号、版本、指纹、是不是当前版本）'],
];

const missing: string[] = [];
function table(name: string): string {
  const s = schema(name);
  const req = new Set(s.required ?? []);
  const rows = Object.entries(s.properties).map(([k, v]) => {
    const note = NOTES[name]?.[k] ?? v.description;
    if (!note) missing.push(`${name}.${k}`);
    return `| \`${k}\` | ${req.has(k) ? '必填' : '选填'} | ${(note ?? '').replace(/\|/g, '\\|')} |`;
  });
  return ['| 字段 | | 说明 |', '|---|---|---|', ...rows].join('\n');
}

const doc = `# 题库格式规范 · 格式 v1

> 本文件由 \`npm run gen:bank-format-doc\` 从 \`standards/schema/*.schema.json\` 生成，**不要手改**。字段清单与必填项以 Schema 为准。

题库包是柜子（网站）和抽屉（题库加工）之间唯一的数据契约：抽屉打包、柜子装入，两边都按这一份格式。
题库包是**你们公司自己的数据**，不进代码仓库。

## 一个题库包长什么样

\`\`\`
<题库编号>/<版本号>/
  manifest.json        题库身份：编号、版本、考纲版本、题数统计
  personas/*.json      每道题一个文件，文件名就是题目编号
  bg-packages/*.json   背调包（只有考纲标了「配背调包」的题型才有）
  company.json         公司信息（选填）
  products.json        产品目录（选填）
  coverage.json        考纲覆盖：每型几道、每个考试槽位几道几型（自动算）
  checksums.json       每个文件的校验值（自动算）
\`\`\`

## 规矩

- **一个版本写出后不再修改。** 要改题就打一个新版本到新目录；版本号只增不减、不复用。
- **装入前全量校验**（\`npm run bank -- validate <目录>\`）：清单字段齐全 → 格式版本兼容 → 校验和一致 → 每道题、每份背调包过 Schema → 题型在考纲里 → 背调包与变体的引用都找得到。任何一步不过就不装、不动当前版本。
- **题型由考纲决定**：题目里写了考纲没有的题型编码，装入会被拒绝；题型的名称、考点、七力一律以考纲为准。
- **母题与变体**：变体用 \`derived_from\` 指向母题。母题进演习池，变体进考试池；只进演习的题型、落不进考试槽位的题一律进演习池。
- **来源备注 \`_source\`** 只记脱敏素材编号与原话，不记日期、条数、成交结果；对外导出时可以剥掉（题库工坊「导出」→「剥掉来源备注」）。
- 以下划线开头的字段（\`_source\`、\`_note\`……）都是备注，柜子不读。

## manifest.json

${table('manifest')}

## 一道题（personas/*.json）

${table('persona')}

### 一张暗牌（hidden_card 里的每一项）

| 字段 | | 说明 |
|---|---|---|
| \`value\` | 必填 | 暗牌内容：买家藏着的那条信息 |
| \`unlock\` | 必填 | 什么样的问法能解锁（给人看的一句话） |
| \`unlock_patterns\` | 选填 | 解锁正则（不区分大小写；不写 \`/…/i\`，也不写 \`(?i)\`） |
| \`unlock_patterns_topic\` / \`unlock_patterns_framing\` | 选填 | 两段式解锁：话题要对、问法也要对，两组都命中才解锁 |
| \`requires\` | 选填 | 要先解锁哪几张暗牌，这一张才能解锁 |
| \`leak_signals\` | 必填 | 泄露信号：买家回复里出现这些字面就算说漏了（按字面匹配，不是正则） |

## 背调包（bg-packages/*.json）

${table('bg-package')}

## 产品（products.json 的每一项、题目里的 product）

${table('product')}

## 公司信息（company.json）

${table('company')}

## 装进柜子后存在哪（字段对应）

| 题库包里 | 数据库里 |
|---|---|
${DB_MAP.map(([a, b]) => `| \`${a}\` | ${b} |`).join('\n')}

同一个题库包装两次结果一样（幂等）；旧版本的题保留在库里，历史局和报告照常能打开；切换版本只影响之后新开的局。
`;

if (missing.length) {
  console.error(`✗ 这些字段在 Schema 里有、但没写中文说明（补在 scripts/gen-bank-format-doc.ts 的 NOTES 里）：${missing.join('、')}`);
  process.exit(1);
}
if (process.argv.includes('--check')) {
  const cur = (() => {
    try {
      return readFileSync(OUT, 'utf8');
    } catch {
      return '';
    }
  })();
  if (cur !== doc) {
    console.error('✗ docs/题库格式规范.md 和 Schema 对不上：跑 npm run gen:bank-format-doc 重新生成（不要手改文档）');
    process.exit(1);
  }
  console.log('✓ 题库格式规范与 Schema 一致');
} else {
  writeFileSync(OUT, doc);
  console.log(`✓ 已生成 ${OUT}`);
}
