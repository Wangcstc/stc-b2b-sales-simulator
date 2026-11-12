import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/current-user';
import { createDrillSession } from '@/lib/create-session';

/** 开局并跳转到对话页。首页「接待这个客户」走的就是这里 */
export async function GET(req: Request) {
  const variantId = new URL(req.url).searchParams.get('variantId') ?? undefined;

  // 没身份就别开局。以前这里会兜底建一个 WC，结果所有人的局都记在他名下
  const user = await getCurrentUser();
  if (!user) redirect('/signin');

  const session = await createDrillSession(user, variantId);
  redirect(`/drill/${session.id}`);
}
