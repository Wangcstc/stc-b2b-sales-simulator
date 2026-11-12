import { NextResponse } from 'next/server';
import { fail, requireWorkshop } from '@/lib/workshop/guard';
import { uploadPackage } from '@/lib/workshop/bank';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 上传一个题库包目录（浏览器的「选目录」）并装入。托管平台上装题库就靠它；
 * 本机用命令行装过、没留存档的版本，再传一次同一个包也能补上存档（数据库不动）。
 */
export async function POST(req: Request) {
  const { user, denied } = await requireWorkshop();
  if (denied) return denied;
  try {
    const form = await req.formData();
    const paths = form.getAll('paths').map(String);
    const files = form.getAll('files');
    if (!files.length || files.length !== paths.length) throw new Error('没有收到题库包文件');
    const list = await Promise.all(files.map(async (f, i) => ({ path: paths[i]!, data: Buffer.from(await (f as File).arrayBuffer()) })));
    const r = await uploadPackage(user, list, form.get('activate') === '1');
    return NextResponse.json(r);
  } catch (e) {
    return fail(e);
  }
}
