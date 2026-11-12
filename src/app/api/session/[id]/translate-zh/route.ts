import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { toChinese } from '@/lib/llm/translate';
import { hasApiKey } from '@/lib/llm/client';
import { guardView } from '@/lib/session-guard';
import { isTranslatable } from '@/lib/translatable';

/**
 * 英译中：把客户那边说的话翻成中文，放在原文下面给新人对照着看（演习与考试都能用）。
 *
 * ★ 用 guardView 不用 guardAct ★ 翻译没有任何副作用：不推轮次、不写消息、不动状态，
 * 所以主管看别人的局时也能点；已经交卷、作废的考试，回头看记录也能点。
 * ★ 只译这一局客户说过的话 ★ 见 lib/translatable.ts，防止被当成免费翻译器。
 * ★ 不入库 ★ 译文只是旁注。评分、抽取、复盘读的永远是英文原文。
 */

/** 同一句话译过就不再花钱：刷新页面、换个窗口、主管再看都命中。进程内小缓存，重启即清 */
const cache = new Map<string, string>();
const CACHE_MAX = 500;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const g = await guardView(id);
  if (!g.ok) return NextResponse.json({ error: g.error }, { status: g.status });

  const { text } = (await req.json().catch(() => ({}))) as { text?: string };
  const input = (text ?? '').trim();
  if (!input) return NextResponse.json({ error: '没有要翻译的内容' }, { status: 400 });
  if (input.length > 4000) return NextResponse.json({ error: '太长了，一次最多 4000 字' }, { status: 400 });

  const s = await prisma.session.findUnique({
    where: { id },
    select: { variant: { select: { openCard: true } }, messages: { select: { role: true, content: true } } },
  });
  if (!s) return NextResponse.json({ error: '找不到这一局' }, { status: 404 });

  const inquiryText = (s.variant.openCard as Record<string, unknown> | null)?.inquiry_text;
  if (!isTranslatable(input, { inquiryText, messages: s.messages })) {
    return NextResponse.json({ error: '只能翻译这一局里客户说的话' }, { status: 400 });
  }

  const key = `${id}\n${input}`;
  const hit = cache.get(key);
  if (hit) return NextResponse.json({ text: hit, cached: true });

  if (!hasApiKey()) return NextResponse.json({ error: '未配置 DEEPSEEK_API_KEY，翻译不可用' }, { status: 503 });

  try {
    const r = await toChinese(input, id);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, r.text);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: `翻译失败：${(e as Error).message}` }, { status: 502 });
  }
}
