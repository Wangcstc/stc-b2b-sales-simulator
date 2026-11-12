/**
 * 哪些话允许被「译成中文」。
 *
 * ★ 为什么不是「前端传什么就译什么」 ★ 译文要花模型钱。如果接口接受任意文本，
 * 任何登录的人都能把它当成免费翻译器用，一个循环脚本就能烧掉当天预算。
 * 所以只认**这一局里客户那一边说过的话**：开场询盘（或跟进局的前情），
 * 以及库里存着的非业务员消息。业务员自己打的话不给译（那是中译英的事）。
 */
export interface TranslatableSource {
  /** 开场卡里的询盘原文（跟进局是前情） */
  inquiryText?: unknown;
  messages: { role: string; content: string }[];
}

const norm = (s: string) => s.replace(/\r\n/g, '\n').trim();

export function isTranslatable(text: string, src: TranslatableSource): boolean {
  const t = norm(text);
  if (!t) return false;
  if (typeof src.inquiryText === 'string' && norm(src.inquiryText) === t) return true;
  return src.messages.some((m) => m.role !== 'trainee' && !m.content.startsWith('[Attachment] ') && norm(m.content) === t);
}
