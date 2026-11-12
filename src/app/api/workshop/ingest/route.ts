import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { ingestUpload, type UploadedMaterial } from '@/lib/workshop/service';

export const dynamic = 'force-dynamic';

/**
 * 投料。收的是**浏览器里已经脱敏好的**素材（JSON），外加产品表、公司信息表两个 xlsx。
 * 原始聊天导出件从不经过这里。
 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop({ full: true });
  if (denied) return denied;
  try {
    const form = await req.formData();
    const materials = JSON.parse(String(form.get('materials') ?? '[]')) as UploadedMaterial[];
    const file = async (k: string) => {
      const f = form.get(k);
      return f instanceof File && f.size ? Buffer.from(await f.arrayBuffer()) : undefined;
    };
    const products = await file('products');
    const company = await file('company');
    const extra = String(form.get('extraMask') ?? '')
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await ingestUpload(user, { materials, ...(products ? { products } : {}), ...(company ? { company } : {}), extraMask: extra });
    return NextResponse.json(r);
  } catch (e) {
    return fail(e);
  }
}
