import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * ★ 2026-08-28 把 scripts/import 也纳进来 ★
     * 解析 → 脱敏这条链是题库生产的第一段，也是产品化之后**唯一在客户机器上跑**的一段
     *（D6：脱敏在客户那一侧，服务端只收脱敏后的 JSON）。它出错泄漏的是客户的真实
     * 客户名单与成交价，而服务端不可能发现——收到的本来就是"已经脱敏"的东西。
     * 这么一段代码在这之前一条测试都没有，只因为它住在 scripts/ 而不是 src/。
     */
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'standards/**/*.test.ts', 'bank-kit/**/*.test.ts', 'engine/**/*.test.ts', 'drawer/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['engine/**/*.ts'],
      exclude: ['**/*.test.ts'],
      // 技术方案 13 章：引擎层覆盖率必须 ≥90%
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});
