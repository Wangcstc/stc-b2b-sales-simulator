/**
 * 抽屉的落盘存储。目录结构（默认在 `workspace/drawer/`，可用环境变量 DRAWER_DIR 改）：
 *
 *   batches/<批次号>/batch.json          批次
 *   batches/<批次号>/inbox/              原始导出件（脱敏通过后默认删除）
 *   batches/<批次号>/items/<编号>.json   每份素材的状态与题目草稿
 *   batches/<批次号>/redacted/<素材编号>/redacted.json   脱敏后的素材
 *   batches/<批次号>/reviews/<编号>.json 选择题卡
 *
 * ★ 写入先写临时文件再改名 ★ 中途断电、杀进程都不会留下写了一半的 JSON。
 * ★ workspace/ 整个目录不进 git ★ 里面是客户自己的数据。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Batch, Item, ReviewCard } from './types';

export function drawerRoot(): string {
  return resolve(process.env.DRAWER_DIR ?? 'workspace/drawer');
}

const writeJson = (path: string, data: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
};
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export class Store {
  constructor(readonly root: string = drawerRoot()) {}

  batchDir(batchId: string) {
    return join(this.root, 'batches', batchId);
  }
  inboxDir(batchId: string) {
    return join(this.batchDir(batchId), 'inbox');
  }
  redactedDir(batchId: string) {
    return join(this.batchDir(batchId), 'redacted');
  }

  listBatches(): string[] {
    const dir = join(this.root, 'batches');
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }
  hasBatch(batchId: string) {
    return existsSync(join(this.batchDir(batchId), 'batch.json'));
  }
  getBatch(batchId: string): Batch {
    return readJson(join(this.batchDir(batchId), 'batch.json'));
  }
  saveBatch(b: Batch) {
    writeJson(join(this.batchDir(b.id), 'batch.json'), b);
  }

  getItem(batchId: string, itemId: string): Item {
    return readJson(join(this.batchDir(batchId), 'items', `${itemId}.json`));
  }
  saveItem(batchId: string, item: Item) {
    writeJson(join(this.batchDir(batchId), 'items', `${item.id}.json`), item);
  }

  getReview(batchId: string, id: string): ReviewCard {
    return readJson(join(this.batchDir(batchId), 'reviews', `${id}.json`));
  }
  saveReview(batchId: string, card: ReviewCard) {
    writeJson(join(this.batchDir(batchId), 'reviews', `${card.id}.json`), card);
  }
  listReviews(batchId: string): ReviewCard[] {
    const dir = join(this.batchDir(batchId), 'reviews');
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => readJson<ReviewCard>(join(dir, f)))
      : [];
  }

  saveMaterial(batchId: string, materialId: string, data: unknown) {
    writeJson(join(this.redactedDir(batchId), materialId, 'redacted.json'), data);
  }
  getMaterial<T>(batchId: string, materialId: string): T | null {
    const p = join(this.redactedDir(batchId), materialId, 'redacted.json');
    return existsSync(p) ? readJson<T>(p) : null;
  }

  /** 题目编号的序号：整个抽屉工作区共用一份，不同批次之间不会撞号 */
  nextSeq(key: string): number {
    const p = join(this.root, 'seq.json');
    const all = existsSync(p) ? readJson<Record<string, number>>(p) : {};
    all[key] = (all[key] ?? 0) + 1;
    writeJson(p, all);
    return all[key]!;
  }

  removeFile(path: string) {
    rmSync(path, { force: true });
  }
}
