/**
 * 题库包的读与写。
 *
 * ★ 题库包是真源，一个版本写出后不再修改 ★ 要改就写一个新版本到新目录。
 * 写入时自动生成 manifest 计数、考纲覆盖和每个文件的校验值，调用方不用自己算。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SYLLABUS_VERSION } from '../standards/index';
import { computeCounts, computeCoverage } from './coverage';
import { BANK_FORMAT_VERSION, type Bank, type BgPackage, type Manifest, type Persona } from './types';

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

/**
 * 读题库包时用的校验值：先把 CRLF 换回 LF 再算。
 * ★ 为什么 ★ 题库包写出时一律 LF；但在 Windows 上经 git、压缩包、编辑器转一手，
 * 换行常被改成 CRLF，内容一字没变却算出另一个值，装入会被当成「打包后被改过」。
 * JSON 里字符串内的回车会被转义成 \r 两个字符，裸的 CRLF 只可能是换行，换回 LF 不改任何内容。
 */
export const contentHash = (buf: Buffer | string) => sha256(String(buf).replace(/\r\n/g, '\n'));

export interface WriteBankInput {
  personas: Persona[];
  bgPackages: BgPackage[];
  company?: Record<string, string>;
  products?: unknown[];
  reviewLog?: unknown[];
  bankId: string;
  bankVersion: string;
  drawerVersion: string;
  generator?: string;
  sourceBatches?: string[];
  createdAt?: string;
}

export function writeBank(dir: string, input: WriteBankInput): Manifest {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`目录不是空的：${dir}。题库包一经写出不再修改，新版本请写到新目录`);
  }
  mkdirSync(join(dir, 'personas'), { recursive: true });
  mkdirSync(join(dir, 'bg-packages'), { recursive: true });

  const files: Record<string, string> = {};
  const put = (rel: string, data: unknown) => {
    const text = json(data);
    writeFileSync(join(dir, rel), text, 'utf8');
    files[rel] = sha256(text);
  };

  for (const p of [...input.personas].sort((a, b) => a.id.localeCompare(b.id))) put(`personas/${p.id}.json`, p);
  for (const b of [...input.bgPackages].sort((a, b) => a.persona_id.localeCompare(b.persona_id))) {
    put(`bg-packages/${b.persona_id}.json`, b);
  }
  if (input.company) put('company.json', input.company);
  if (input.products) put('products.json', input.products);
  if (input.reviewLog) put('review-log.json', input.reviewLog);
  put('coverage.json', computeCoverage(input.personas));

  const manifest: Manifest = {
    format_version: BANK_FORMAT_VERSION,
    syllabus_version: SYLLABUS_VERSION,
    bank_id: input.bankId,
    bank_version: input.bankVersion,
    drawer_version: input.drawerVersion,
    ...(input.generator ? { generator: input.generator } : {}),
    created_at: input.createdAt ?? new Date().toISOString(),
    counts: computeCounts(input.personas, input.bgPackages.length),
    source_batches: input.sourceBatches ?? [],
  };
  put('manifest.json', manifest);
  writeFileSync(join(dir, 'checksums.json'), json(Object.fromEntries(Object.entries(files).sort())), 'utf8');
  return manifest;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** 读题库包。只读不校验；装入前请先调用 validateBank */
export function readBank(dir: string): Bank {
  const opt = <T>(rel: string) => (existsSync(join(dir, rel)) ? readJson<T>(join(dir, rel)) : undefined);
  const list = (sub: string) =>
    existsSync(join(dir, sub))
      ? readdirSync(join(dir, sub))
          .filter((f) => f.endsWith('.json'))
          .sort()
      : [];
  return {
    manifest: readJson(join(dir, 'manifest.json')),
    personas: list('personas').map((f) => readJson<Persona>(join(dir, 'personas', f))),
    bgPackages: list('bg-packages').map((f) => readJson<BgPackage>(join(dir, 'bg-packages', f))),
    company: opt('company.json'),
    products: opt('products.json'),
    coverage: readJson(join(dir, 'coverage.json')),
    reviewLog: opt('review-log.json'),
  };
}

/** 列出题库包里除 checksums.json 以外的所有文件（相对路径） */
export function listBankFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.name.endsWith('.json')) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.filter((f) => f !== 'checksums.json').sort();
}
