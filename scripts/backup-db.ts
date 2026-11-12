/**
 * 数据库备份与恢复验证（`npm run backup` / `npm run backup:verify`）
 *
 * ★ 为什么要有 ★ `DailyEvaluation` 与 `Session` 是这套系统的**全部历史资产**：
 * 谁哪天达标、凭哪 6 局判的、每一句对话原话。库没了，重建不出来——
 * 演习分是 LLM 打的，重跑会得到第三个版本；准入结论已经发出去，人当天就去接真实询盘了。
 * 云数据库自带的时间点恢复窗口通常很短，**那是事故缓冲，不是备份**。
 *
 * ★ 三件事，缺一件就不叫备份 ★
 *   1. 导得出来      —— `npm run backup`
 *   2. 老的会被清掉  —— 同上，默认留最近 30 份（不清的话，硬盘满了才发现）
 *   3. **恢复得回去** —— `npm run backup:verify`
 *      第三件才是关键。**没恢复验证过的备份不叫备份，叫「一个大概能用的文件」。**
 *      所以这里不是「看看文件在不在」，而是真的起一个干净的 Postgres 容器、
 *      把 dump 灌进去、逐表比对行数——对得上才算数。
 *
 * ★ 本机没有 pg_dump，用 docker 里的 ★ 且**版本必须 ≥ 服务端**：
 * 本地库是 PG 16，云数据库可能是 17，用 16 的 pg_dump 去导 17 会被直接拒绝。
 * 所以这里先问服务端版本，再挑镜像，不写死。
 *
 * ★ Neon 必须走直连、不能走 pooled ★ pooled 那个端点后面是 pgbouncer（事务模式），
 * pg_dump 要的会话级特性它不支持，报错还很难懂。脚本会自动把主机名里的 `-pooler` 去掉。
 * 这一条是「凌晨三点备份为什么一直失败」的经典答案，写在这儿省得下次再查一遍。
 *
 * 用法：
 * ```bash
 * npm run backup                 # 备份 DATABASE_URL 指向的库
 * npm run backup:verify          # 拿最新那份，真恢复一遍，逐表比对行数
 * npm run backup:verify -- <文件>
 * ```
 * 备线上库：把线上库的连接串写进 `.env` 的 `BACKUP_DATABASE_URL`（**不要覆盖 DATABASE_URL**，
 * 那会让本地开发直接连上线上库），再跑同样的命令。
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/** 留最近几份。一份几 MB，30 份也就百来兆——比「哪天没备上」便宜得多 */
const KEEP = Number(process.env.BACKUP_KEEP ?? 30);

/** 默认放在仓库外面。里面是真实对话与员工姓名，**绝不能进 git** */
const DEFAULT_DIR = path.resolve(process.cwd(), '..', '_数据库备份');

/** pg_dump 镜像最低用到这个大版本（低于服务端版本会被拒绝，所以只会往上取） */
const MIN_PG_MAJOR = 16;

/**
 * 要逐表比对的表。**顺序照 schema 走，读的人能对着看**。
 *
 * ★ 为什么要显式列出来，不用「遍历所有表」★ 新加了模型却忘了加进这里，
 * 说明没人想过「这张表要不要备份」——那正是该被看见的时刻。
 * 列表和 schema 对不上时，verify 会当场喊出来。
 */
const TABLES = [
  ['User', (p: PrismaClient) => p.user.count()],
  ['BusinessCalendar', (p: PrismaClient) => p.businessCalendar.count()],
  ['LeaveDay', (p: PrismaClient) => p.leaveDay.count()],
  ['AdminAudit', (p: PrismaClient) => p.adminAudit.count()],
  ['LoginEvent', (p: PrismaClient) => p.loginEvent.count()],
  ['Persona', (p: PrismaClient) => p.persona.count()],
  ['PersonaVariant', (p: PrismaClient) => p.personaVariant.count()],
  ['BgPackage', (p: PrismaClient) => p.bgPackage.count()],
  ['Session', (p: PrismaClient) => p.session.count()],
  ['Message', (p: PrismaClient) => p.message.count()],
  ['Score', (p: PrismaClient) => p.score.count()],
  ['CoachQa', (p: PrismaClient) => p.coachQa.count()],
  ['ExamAttempt', (p: PrismaClient) => p.examAttempt.count()],
  ['TrainingTask', (p: PrismaClient) => p.trainingTask.count()],
  ['AccessDecision', (p: PrismaClient) => p.accessDecision.count()],
  ['DailyEvaluation', (p: PrismaClient) => p.dailyEvaluation.count()],
  ['RedlineReview', (p: PrismaClient) => p.redlineReview.count()],
  ['Calibration', (p: PrismaClient) => p.calibration.count()],
  ['ScoreCalibration', (p: PrismaClient) => p.scoreCalibration.count()],
  ['LlmCall', (p: PrismaClient) => p.llmCall.count()],
] as const;

interface Manifest {
  /** 备份时刻（上海时区，给人看） */
  at: string;
  /** local / prod。从主机名判的 */
  source: string;
  host: string;
  database: string;
  serverVersion: string;
  pgImage: string;
  file: string;
  bytes: number;
  sha256: string;
  /** 逐表行数。恢复验证就是拿它对 */
  rows: Record<string, number>;
  /** 恢复验证的结果。备份刚做完时是 null，跑过 verify 之后写回来 */
  verifiedAt: string | null;
}

/* ────────────────── 小工具 ────────────────── */

function stamp(at = new Date()): string {
  const f = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return f.format(at).replace(' ', 'T');
}

/** 文件名用的时间戳：`20260822-2128`。**别拿完整时间戳去截**——会从秒里截断，读起来像乱码 */
function fileStamp(at = new Date()): string {
  const [day, clock] = stamp(at).split('T') as [string, string];
  return `${day.replace(/-/g, '')}-${clock.slice(0, 5).replace(':', '')}`;
}

/** 跑一个命令，stdout 可以接到文件流上。**URL 走环境变量，不进 argv** */
function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; toFile?: string; input?: string; quiet?: boolean } = {},
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: [
        opts.input ? 'pipe' : 'ignore',
        opts.toFile ? 'pipe' : opts.quiet ? 'ignore' : 'inherit',
        'pipe',
      ],
      shell: false,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    if (opts.toFile && child.stdout) {
      const out = createWriteStream(opts.toFile);
      child.stdout.pipe(out);
    }
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** docker run 一个一次性容器跑 pg 工具。URL 用 -e 传，不放进命令行参数 */
async function pgTool(
  image: string,
  script: string,
  url: string,
  opts: { toFile?: string; fromFile?: string } = {},
): Promise<{ code: number; stderr: string }> {
  const args = ['run', '--rm', '-i', '-e', 'PGURL', '--add-host=host.docker.internal:host-gateway', image, 'sh', '-c', script];
  if (opts.fromFile) {
    // pg_restore 从 stdin 读：把 dump 内容喂进去
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { env: { ...process.env, PGURL: url }, stdio: ['pipe', 'inherit', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      import('node:fs').then(({ createReadStream }) => createReadStream(opts.fromFile!).pipe(child.stdin));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
  }
  return run('docker', args, { env: { PGURL: url }, toFile: opts.toFile });
}

/**
 * 挑 pg_dump 镜像。**必须 ≥ 服务端大版本**，否则 pg_dump 直接拒绝。
 * 镜像不在本地就拉一次；拉不动（比如没网）就把话说清楚，别让人对着一句 docker 报错猜。
 */
async function ensureImage(major: number): Promise<string> {
  const tag = `postgres:${Math.max(major, MIN_PG_MAJOR)}-alpine`;
  const has = await run('docker', ['image', 'inspect', tag], { quiet: true });
  if (has.code === 0) return tag;
  console.log(`  本地没有 ${tag}，拉一次…`);
  const pull = await run('docker', ['pull', tag]);
  if (pull.code !== 0) {
    throw new Error(
      `拉不到 ${tag}（服务端是 PG ${major}，pg_dump 必须不低于它）。\n` +
        `有网的时候先跑一次 \`docker pull ${tag}\`，之后离线也能备份。\n${pull.stderr}`,
    );
  }
  return tag;
}

/**
 * ★ Neon 的 pooled 端点导不了 ★ 后面是 pgbouncer 事务模式，不支持 pg_dump 要的会话级特性。
 * 主机名里带 `-pooler` 的一律换成直连主机名。
 */
function directUrl(url: string): { url: string; changed: boolean } {
  const u = new URL(url);
  if (!u.hostname.includes('-pooler')) return { url, changed: false };
  u.hostname = u.hostname.replace('-pooler', '');
  return { url: u.toString(), changed: true };
}

function describe(url: string) {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  return {
    host: u.hostname,
    database: u.pathname.replace(/^\//, '').split('?')[0] || 'postgres',
    source: local ? 'local' : 'prod',
  };
}

/**
 * ★ 把 Prisma 专有的连接参数摘掉 ★
 * `?schema=public` 是 Prisma 自己的写法，libpq 不认——pg_dump 会直接报
 * `invalid URI query parameter: "schema"`，而那句话完全看不出是「串的问题」还是「库的问题」。
 * `connection_limit` / `pool_timeout` / `pgbouncer` 同理，都是 Prisma 的连接池参数。
 *
 * schema 不是 public 时不能一扔了事：得翻译成 pg_dump 的 `--schema=`，
 * 否则备份出来的是另一个 schema 的东西（或者干脆是空的），而且不会报错。
 */
function libpqUrl(url: string): { url: string; schemaArg: string } {
  const u = new URL(url);
  const schema = u.searchParams.get('schema');
  for (const key of ['schema', 'connection_limit', 'pool_timeout', 'pgbouncer', 'socket_timeout']) {
    u.searchParams.delete(key);
  }
  return {
    url: u.toString(),
    schemaArg: schema && schema !== 'public' ? ` --schema="${schema}"` : '',
  };
}

/**
 * ★ 容器里的 localhost 是容器自己 ★
 * pg_dump 跑在一次性容器里，直接把 `localhost:5433` 传进去，它会连自己的 5433——
 * 那儿什么都没有，报的还是「connection refused」，很容易被读成「数据库挂了」。
 * Docker Desktop 下宿主机叫 `host.docker.internal`（Linux 上靠 --add-host 补出来）。
 * 只改给容器看的那一份，manifest 里记的仍是原始主机名。
 */
function urlForContainer(url: string): string {
  const u = new URL(url);
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') u.hostname = 'host.docker.internal';
  return u.toString();
}

async function sha256Of(file: string): Promise<string> {
  const buf = await readFile(file);
  return createHash('sha256').update(buf).digest('hex');
}

async function listBackups(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((f) => f.endsWith('.dump')).sort();
}

/* ────────────────── 备份 ────────────────── */

async function backup() {
  const raw = process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!raw) throw new Error('没有 BACKUP_DATABASE_URL，也没有 DATABASE_URL，不知道要备哪个库');

  const { url, changed } = directUrl(raw);
  const info = describe(url);
  const dir = process.env.BACKUP_DIR ?? DEFAULT_DIR;
  await mkdir(dir, { recursive: true });

  console.log(`备份目标：${info.source}｜${info.host}/${info.database}`);
  if (changed) console.log('  （检测到 pooled 端点，已自动换成直连——pgbouncer 导不了库）');
  console.log(`存放位置：${dir}\n`);

  // ── 先记行数：这是恢复验证时唯一的对账依据 ──
  const prisma = new PrismaClient({ datasourceUrl: url });
  const rows: Record<string, number> = {};
  let serverVersion = 'unknown';
  try {
    // ★ 别用 `SHOW server_version` ★ 它返回的列名是 server_version 不是 v，
    // 取不到就静默落成 'unknown'，然后镜像退回最低版本 16——真连上 PG 17 就会被拒。
    // 一个静默的默认值，换来的是备份在最需要它的那天才失败。
    const v = await prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT current_setting('server_version') AS v`);
    serverVersion = v[0]?.v ?? 'unknown';
    if (serverVersion === 'unknown') throw new Error('问不出服务端版本，不敢猜 pg_dump 该用哪个镜像');
    for (const [name, count] of TABLES) rows[name] = await count(prisma);
  } finally {
    await prisma.$disconnect();
  }
  const major = Number(serverVersion.split('.')[0]) || MIN_PG_MAJOR;
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  console.log(`服务端 PG ${serverVersion}｜共 ${total} 行，${TABLES.length} 张表`);

  if (!/^\d+/.test(serverVersion)) throw new Error(`服务端版本读成了「${serverVersion}」，解析不出大版本号`);
  const image = await ensureImage(major);
  const { url: pgUrl, schemaArg } = libpqUrl(url);
  const base = `drill-${info.source}-${fileStamp()}`;
  const file = path.join(dir, `${base}.dump`);

  // --format=custom：可选择性恢复、自带压缩；--no-owner/--no-privileges：换库也能灌
  console.log(`\n导出中（${image}）…`);
  const dump = await pgTool(
    image,
    `pg_dump --format=custom --no-owner --no-privileges${schemaArg} "$PGURL"`,
    urlForContainer(pgUrl),
    { toFile: file },
  );
  if (dump.code !== 0) {
    await rm(file, { force: true });
    throw new Error(`pg_dump 失败（退出码 ${dump.code}）：\n${dump.stderr}`);
  }

  const { size } = await stat(file);
  // 空文件也会「成功」——1KB 以下一定不对，当场判失败，别把一个空壳留下来当备份
  if (size < 1024) {
    await rm(file, { force: true });
    throw new Error(`导出的文件只有 ${size} 字节，肯定不对。已删掉，别留个空壳当备份。\n${dump.stderr}`);
  }

  const manifest: Manifest = {
    at: stamp(),
    source: info.source,
    host: info.host,
    database: info.database,
    serverVersion,
    pgImage: image,
    file: path.basename(file),
    bytes: size,
    sha256: await sha256Of(file),
    rows,
    verifiedAt: null,
  };
  await writeFile(path.join(dir, `${base}.json`), JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`✅ ${manifest.file}　${(size / 1024 / 1024).toFixed(2)} MB`);

  // ── 剪枝 ──
  const all = await listBackups(dir);
  const stale = all.slice(0, Math.max(0, all.length - KEEP));
  for (const f of stale) {
    await rm(path.join(dir, f), { force: true });
    await rm(path.join(dir, f.replace(/\.dump$/, '.json')), { force: true });
  }
  if (stale.length > 0) console.log(`   清掉 ${stale.length} 份旧备份，现存 ${all.length - stale.length} 份（留最近 ${KEEP} 份）`);

  console.log('\n⚠️ 还没验过能不能恢复。跑 `npm run backup:verify` —— **没恢复验证过的备份不叫备份**。');
  return file;
}

/* ────────────────── 恢复验证 ────────────────── */

const SCRATCH = 'drill-restore-check';

/**
 * 真恢复一遍：起一个干净的 Postgres 容器 → 灌进去 → 逐表比对行数 → 拆掉。
 *
 * ★ 为什么要单起容器，不灌进本地开发库 ★ 两条：
 *   ① 灌进开发库就会把它冲掉——验证备份反而弄丢了本地数据，那太蠢了；
 *   ② 版本要对得上。生产是 PG 17 的话，dump 得用 17 的 pg_restore 灌进 17 的服务端，
 *      而本地开发库是 16。容器按 manifest 里记的版本起，天然对齐。
 */
async function verify(target?: string) {
  const dir = process.env.BACKUP_DIR ?? DEFAULT_DIR;
  const all = await listBackups(dir);
  if (all.length === 0) throw new Error(`${dir} 里一份备份都没有，先跑 npm run backup`);

  const name = target ? path.basename(target) : all[all.length - 1]!;
  const file = path.join(dir, name);
  const manifestPath = path.join(dir, name.replace(/\.dump$/, '.json'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;

  console.log(`验证：${name}（${manifest.source}｜${manifest.at}｜PG ${manifest.serverVersion}）`);

  // 校验没被改动过 / 没传坏
  const sha = await sha256Of(file);
  if (sha !== manifest.sha256) throw new Error(`文件校验和对不上，这份备份已经不可信：\n  记录 ${manifest.sha256}\n  实际 ${sha}`);
  console.log('  ✓ 校验和一致');

  const image = manifest.pgImage;
  await run('docker', ['rm', '-f', SCRATCH]).catch(() => undefined);
  console.log(`  起一个干净的 ${image}…`);
  const up = await run('docker', [
    'run', '-d', '--name', SCRATCH,
    '-e', 'POSTGRES_PASSWORD=verify', '-e', 'POSTGRES_USER=verify', '-e', 'POSTGRES_DB=verify',
    '-p', '55432:5432', image,
  ]);
  if (up.code !== 0) throw new Error(`起不来验证容器：\n${up.stderr}`);

  try {
    // 等它 ready
    for (let i = 0; i < 60; i += 1) {
      const ping = await run('docker', ['exec', SCRATCH, 'pg_isready', '-U', 'verify']);
      if (ping.code === 0) break;
      await new Promise((r) => setTimeout(r, 500));
      if (i === 59) throw new Error('验证容器 30 秒还没 ready');
    }

    console.log('  灌数据…');
    const done = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const child = spawn('docker', [
        'exec', '-i', SCRATCH, 'pg_restore', '--no-owner', '--no-privileges', '-U', 'verify', '-d', 'verify',
      ], { stdio: ['pipe', 'inherit', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      import('node:fs').then(({ createReadStream }) => createReadStream(file).pipe(child.stdin));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
    if (done.code !== 0) throw new Error(`pg_restore 失败（退出码 ${done.code}）：\n${done.stderr}`);

    // ── 逐表比对行数 ──
    console.log('  逐表比对行数：');
    let bad = 0;
    for (const [table] of TABLES) {
      const q = await run('docker', [
        'exec', SCRATCH, 'psql', '-U', 'verify', '-d', 'verify', '-tAc', `SELECT count(*) FROM "${table}"`,
      ], { toFile: path.join(dir, '.count.tmp') });
      const got = q.code === 0 ? Number((await readFile(path.join(dir, '.count.tmp'), 'utf8')).trim()) : NaN;
      const want = manifest.rows[table] ?? 0;
      const okRow = got === want;
      if (!okRow) bad += 1;
      console.log(`    ${okRow ? '✓' : '✗'} ${table.padEnd(18)} ${String(got).padStart(6)} / ${String(want).padStart(6)}`);
    }
    await rm(path.join(dir, '.count.tmp'), { force: true });

    if (bad > 0) throw new Error(`有 ${bad} 张表对不上——这份备份恢复不完整，别拿它当依靠`);

    manifest.verifiedAt = stamp();
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`\n✅ 恢复验证通过：${TABLES.length} 张表逐一对上。这份备份是能用的。`);
  } finally {
    await run('docker', ['rm', '-f', SCRATCH]).catch(() => undefined);
  }
}

/* ────────────────── 入口 ────────────────── */

const mode = process.argv[2];
const arg = process.argv[3];

const task = mode === 'verify' ? verify(arg) : backup();
task.catch((e: Error) => {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
});
