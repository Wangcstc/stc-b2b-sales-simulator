/**
 * ★ 改了 prisma/schema.prisma 之后，dev server 必须重启 ★
 *
 * `@prisma/client` 是**外置依赖**（Next 15 默认不把它打进 webpack 包），
 * 进程启动时 require 一次就一直用那份。所以：
 *   · 跑了 `prisma migrate deploy` —— 数据库有新表了
 *   · 跑了 `prisma generate` —— 磁盘上的客户端有新表了
 *   · **但正在跑的 dev server 手里还是旧客户端** —— 新模型在它眼里是 undefined
 * 表现就是 `Cannot read properties of undefined (reading 'findMany')`，
 * 而同一份代码用 `npx tsx` 跑（全新进程）却完全正常，很容易误判成代码问题。
 *
 * 附带一条：dev server 跑着的时候 `prisma generate` 会 EPERM ——
 * 它占着 query engine 的 dll。TypeScript 客户端其实已经写进去了，
 * 只有引擎二进制没换成，而引擎是版本通用的，不影响使用。
 *
 * 生产不会有这个问题：`npm run build` 是 `prisma generate && next build`，
 * 每次部署都是全新进程。
 */

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  /**
   * ★ 把人设 JSON 与建表 SQL 打进函数产物 ★
   * Next 的依赖追踪只跟 import 走，`readFileSync(...)` 读的文件它看不见，
   * 不显式声明的话 /api/admin/bootstrap 上线后会 ENOENT——本地却一切正常，
   * 因为本地根本没打包这一步。
   *
   * 只给这一个路由加，不做全局包含：其余 25 条路由用不到这些文件，
   * 白白塞进每个函数只会拖慢冷启动。
   */
  /**
   * ★ 抽屉、引擎按 Node 的写法引用 `./x.js`（磁盘上是 x.ts）★
   * tsx 和 vitest 认这种写法，webpack 不认；题库工坊在柜子里直接调抽屉，就得告诉它 .js 也可以是 .ts。
   */
  webpack(config) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], ...(config.resolve.extensionAlias ?? {}) };
    return config;
  },

  outputFileTracingIncludes: {
    '/api/admin/bootstrap': ['./prisma/init.sql', './banks/**', './samples/bank/**'],
    // 题库工坊：模板下载、样品题库在托管平台上也要能用（读的是文件，依赖追踪看不见）
    '/api/workshop/template': ['./standards/templates/**'],
    '/api/workshop/bank/sample': ['./samples/bank/**'],
  },
};
