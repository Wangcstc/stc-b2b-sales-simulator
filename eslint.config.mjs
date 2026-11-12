import next from 'eslint-config-next';

export default [
  ...next(),
  {
    // ★ 引擎层是无菌区（技术方案 12.1）★
    // 不许 import 数据库 / LLM / Next.js 的任何东西。
    // 这条做了，回放工具才成立、调参才做得了——不靠自觉，靠 lint。
    files: ['engine/**/*.ts'],
    ignores: ['engine/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@prisma/*', '**/db', '**/db/*', '**/prisma', '**/prisma/*'], message: '引擎层不许碰数据库' },
            { group: ['openai', '**/llm', '**/llm/*'], message: '引擎层不许碰 LLM' },
            { group: ['next', 'next/*', 'react', 'react/*'], message: '引擎层不许碰 Next/React' },
            { group: ['node:fs', 'node:path', 'fs', 'path'], message: '引擎层必须是纯函数，不许碰文件系统' },
          ],
        },
      ],
    },
  },
];
