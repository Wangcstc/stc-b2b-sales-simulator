/**
 * 修订前后改了哪里（需求文档 8.1 第 4 条：「改完自动重新质检，再回到确认队列，并标出改了哪里」）。
 * 只比到第二层：主管要的是「暗牌 H2 改了、开场询盘改了」，不是逐字 diff。
 */
import type { Persona } from '../bank-kit/index';

const LABEL: Record<string, string> = {
  open_card: '明牌',
  hidden_card: '暗牌',
  product: '产品',
  distractors: '干扰项',
  init_state: '开局状态',
  exit_lines: '退出台词',
  quote_reactions: '报价反应',
  followup_reactions: '跟进反应',
  preset_elements: '前情',
  verify_cases: '验证用例',
  skeleton: '骨架',
  language_style: '语言风格',
  difficulty: '难度',
  pool_type: '题池',
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function personaChanges(before: Persona, after: Persona): string[] {
  const a = before as unknown as Record<string, unknown>;
  const b = after as unknown as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])]) {
    if (k.startsWith('_') || same(a[k], b[k])) continue;
    const name = LABEL[k] ?? k;
    const x = a[k];
    const y = b[k];
    if (isObj(x) && isObj(y)) {
      const sub = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((s) => !s.startsWith('_') && !same(x[s], y[s]));
      const how = (s: string) => (!(s in x) ? `新增 ${s}` : !(s in y) ? `删掉 ${s}` : s);
      out.push(sub.length ? `${name}：${sub.slice(0, 6).map(how).join('、')}${sub.length > 6 ? ` 等 ${sub.length} 处` : ''}` : name);
    } else out.push(`${name}改了`);
  }
  return out;
}
