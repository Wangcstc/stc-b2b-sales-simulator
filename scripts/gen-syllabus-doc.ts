/**
 * 从 `standards/syllabus/syllabus-v3.json` 生成考纲文档 `standards/syllabus/README.md`。
 *
 * ★ JSON 是真源，文档是生成物 ★ 改考纲只改 JSON，再跑 `npm run gen:syllabus-doc`。
 * `npm run check:syllabus-doc` 会比对两者，不一致就报错——防止有人手改了文档却没改 JSON。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORCES, REDLINES, SYLLABUS } from '../standards/index';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'standards/syllabus/README.md');
const label = new Map(FORCES.map((f) => [f.key, f.label]));
const forces = (keys: string[]) => (keys.length ? keys.map((k) => label.get(k as never) ?? k).join('、') : '—');

const s = SYLLABUS;
const lines: string[] = [];
lines.push(`# ${s.name} · 考纲 v${s.syllabus_version}`, '');
lines.push('> 本文件由 `npm run gen:syllabus-doc` 从 `syllabus-v3.json` 生成，**不要手改**。', '');
lines.push('## 通用规范', '');
lines.push(`- **命名**：${s.naming_rule}。`);
lines.push(`- **编码**：${s.code_rule}。`);
lines.push(`- **审批**：${s.governance}`);
lines.push('', '### 七个阶段', '', '| 字母 | 阶段 |', '|---|---|');
for (const st of s.stages) lines.push(`| ${st.letter} | ${st.name} |`);
lines.push('', '### 局型与难度', '');
lines.push(`- 局型：${Object.values(s.session_types).join(' / ')}`);
lines.push(`- 难度：${Object.values(s.difficulties).join(' / ')}（简单档不进考试）`);
lines.push('', '### 考试槽位', '', '| 槽位 | 局型 | 难度 |', '|---|---|---|');
for (const slot of s.exam_slots) {
  lines.push(`| ${slot.label} | ${s.session_types[slot.session_type]} | ${slot.difficulty ? s.difficulties[slot.difficulty] : '不限'} |`);
}
lines.push('', '### 七力', '', '| 力 | 看什么 |', '|---|---|');
for (const f of FORCES) lines.push(`| ${f.label} | ${f.meaning} |`);
lines.push('', '### 四条红线', '', '| 编号 | 红线 | 判定方式 |', '|---|---|---|');
for (const r of REDLINES) lines.push(`| ${r.code} | ${r.label} | ${r.judged_by === 'code' ? '代码判定' : '模型判定'}，${r.effect} |`);

lines.push('', `## 题型总表（共 ${s.types.length} 型）`, '');
lines.push('| 编码 | 题型 | 局型 | 默认难度 | 进考试 | 主考力 | 不考力 |', '|---|---|---|---|---|---|---|');
for (const st of s.stages) {
  lines.push(`| **${st.letter}** | **${st.name}** | | | | | |`);
  for (const t of s.types.filter((x) => x.stage === st.letter)) {
    lines.push(
      `| ${t.code} | ${t.name} | ${s.session_types[t.session_type]} | ${s.difficulties[t.default_difficulty]} | ${t.exam_eligible ? '是' : '暂不'} | ${forces(t.key_forces)} | ${forces(t.na_forces)} |`,
    );
  }
}

lines.push('', '## 各题型规范', '');
for (const st of s.stages) {
  lines.push(`### ${st.letter} ${st.name}`, '');
  for (const t of s.types.filter((x) => x.stage === st.letter)) {
    const diff = [t.default_difficulty, ...t.also_difficulties].map((d) => s.difficulties[d]).join(' / ');
    lines.push(`#### ${t.code} ${t.name}`);
    lines.push(`- **局型 / 难度**：${s.session_types[t.session_type]} / ${diff}${t.exam_eligible ? '' : '（暂不进考试）'}${t.needs_bg_package ? ' ｜ 配背调包' : ''}`);
    lines.push(`- **买家画像**：${t.buyer_profile}`);
    lines.push(`- **考点**：${t.tests}`);
    lines.push(`- **主考力**：${forces(t.key_forces)} ｜ **不考力**：${forces(t.na_forces)}`);
    lines.push(`- **满分动作**：${t.full_marks}`);
    lines.push(`- **典型失分**：${t.typical_mistakes}`);
    lines.push(`- **素材识别特征**：${t.material_signals}`);
    lines.push(`- **暗牌设计要点**：${t.hidden_card_tips}`);
    if (t.note) lines.push(`- **说明**：${t.note}`);
    lines.push('');
  }
}

const text = lines.join('\n');
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* 文件不存在也算不一致 */
  }
  if (current !== text) {
    console.log('✗ standards/syllabus/README.md 与 syllabus-v3.json 不一致。改考纲只改 JSON，然后运行 npm run gen:syllabus-doc');
    process.exit(1);
  }
  console.log('✓ 考纲文档与 JSON 一致');
} else {
  writeFileSync(OUT, text, 'utf8');
  console.log(`✓ 已生成 standards/syllabus/README.md（${s.types.length} 型）`);
}
