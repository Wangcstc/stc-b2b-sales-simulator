import { describe, expect, it } from 'vitest';
import { findQuestionIds, findViolations, importsOf } from './boundaries';

const f = (path: string, ...imports: string[]) => ({ path, content: imports.map((s) => `import x from '${s}';`).join('\n') });

describe('模块边界', () => {
  it('能认出 import / export from / 动态 import / 副作用 import', () => {
    expect(importsOf(`import a from './a';\nexport { b } from "../b";\nconst c = await import('./c');\nimport './d';`)).toEqual(['./a', '../b', './c', './d']);
  });

  it('合规的依赖方向不报', () => {
    expect(
      findViolations([
        f('standards/index.ts', './syllabus/syllabus-v3.json'),
        f('bank-kit/validate.ts', 'ajv', 'node:fs', '../standards/index', '../standards/schema/persona.schema.json', './io'),
        f('src/lib/x.ts', '../../bank-kit/index', '../../standards/index', '@/lib/y'),
        f('scripts/m.ts', '../bank-kit/index', '../standards/syllabus/syllabus-v3.json'),
        f('drawer/stage.ts', '../bank-kit/index', '../standards/index'),
      ]),
    ).toEqual([]);
  });

  it('标准层引用别人、题库工具包引用柜子、抽屉引用柜子：都报', () => {
    const v = findViolations([
      f('standards/index.ts', '../bank-kit/index'),
      f('standards/x.ts', 'zod'),
      f('bank-kit/io.ts', '../src/lib/db'),
      f('drawer/run.ts', '@/lib/prisma'),
    ]);
    expect(v.map((x) => x.file)).toEqual(['standards/index.ts', 'standards/x.ts', 'bank-kit/io.ts', 'drawer/run.ts']);
  });

  it('绕过公开入口直接引用内部文件：报', () => {
    const v = findViolations([f('src/app/page.tsx', '../../bank-kit/validate'), f('scripts/a.ts', '../drawer/stages/draft')]);
    expect(v).toHaveLength(2);
    expect(v[0]!.rule).toMatch(/公开入口/);
  });

  it('柜子代码里出现具体题目编号（含注释）：报；测试文件与其他模块不报', () => {
    const v = findQuestionIds([
      { path: 'src/lib/a.ts', content: '// 例如 A09-PL-001 这道题' },
      { path: 'src/lib/b.ts', content: "const x = 'P22-EX-001';" },
      { path: 'src/lib/c.test.ts', content: "const id = 'A09-PL-001';" },
      { path: 'bank-kit/x.ts', content: '// A09-PL-001' },
      { path: 'src/lib/d.ts', content: '// 题型 A09 技术尽调型' },
    ]);
    expect(v.map((x) => x.file)).toEqual(['src/lib/a.ts:1', 'src/lib/b.ts:1']);
  });

  it('判定引擎只许依赖标准层，谁都可以用判定引擎', () => {
    expect(findViolations([f('engine/unlock.ts', './types', '../standards/index'), f('src/lib/a.ts', '../../engine/unlock'), f('drawer/qa.ts', '../engine/unlock')])).toEqual([]);
    expect(findViolations([f('engine/x.ts', '../src/lib/db')]).length).toBe(1);
    expect(findViolations([f('engine/x.ts', 'openai')]).length).toBe(1);
  });

  it('测试文件可以用测试框架，但同样不许反向依赖', () => {
    expect(findViolations([f('standards/a.test.ts', 'vitest', './index')])).toEqual([]);
    expect(findViolations([f('standards/a.test.ts', '../src/lib/x')])).toHaveLength(1);
  });
});
