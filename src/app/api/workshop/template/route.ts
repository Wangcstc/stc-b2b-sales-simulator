import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail, requireWorkshop } from '@/lib/workshop/guard';

export const dynamic = 'force-dynamic';

/** 下载原材料模板（标准层 standards/templates/ 下的生成物） */
const FILES: Record<string, string> = {
  product: '产品表模板-v1.0.xlsx',
  company: '公司信息模板-v1.0.xlsx',
  guide: '投料说明.md',
};

export async function GET(req: Request) {
  const { denied } = await requireWorkshop();
  if (denied) return denied;
  const name = FILES[new URL(req.url).searchParams.get('kind') ?? ''];
  if (!name) return fail(new Error('没有这个模板'), 404);
  const data = readFileSync(resolve('standards/templates', name));
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type': name.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}
