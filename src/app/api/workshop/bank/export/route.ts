import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { exportZip } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';

/** 导出题库包 zip。strip=1：剥掉来源备注，给外部用 */
export async function GET(req: Request) {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  const url = new URL(req.url);
  try {
    const r = await exportZip(user, url.searchParams.get('id') ?? '', url.searchParams.get('strip') === '1');
    return new Response(new Uint8Array(r.data), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`,
      },
    });
  } catch (e) {
    return fail(e);
  }
}
