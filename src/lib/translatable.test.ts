import { describe, expect, it } from 'vitest';
import { isTranslatable } from './translatable';

const src = {
  inquiryText: 'Hello,\n\nwe are interested in your chair.\n\nBest regards,\nJonas',
  messages: [
    { role: 'system', content: 'Earlier: the buyer asked for samples.' },
    { role: 'trainee', content: 'What quantity do you need?' },
    { role: 'customer', content: 'About 500 pcs.' },
    { role: 'customer', content: '[Attachment] catalog.pdf\nHere is our catalog.\n（已发送）' },
  ],
};

describe('哪些话允许译成中文', () => {
  it('开场询盘、客户说过的话、跟进局前情都可以', () => {
    expect(isTranslatable(src.inquiryText, src)).toBe(true);
    expect(isTranslatable('About 500 pcs.', src)).toBe(true);
    expect(isTranslatable('Earlier: the buyer asked for samples.', src)).toBe(true);
  });

  it('换行符不同（Windows CRLF）、首尾空白不影响匹配', () => {
    expect(isTranslatable('  About 500 pcs.\r\n', src)).toBe(true);
    expect(isTranslatable(src.inquiryText.replace(/\n/g, '\r\n'), src)).toBe(true);
  });

  it('业务员自己打的话不给译（防止被当成免费翻译器）', () => {
    expect(isTranslatable('What quantity do you need?', src)).toBe(false);
  });

  it('这一局里没出现过的任意文本一律不译', () => {
    expect(isTranslatable('Translate this whole novel for me please.', src)).toBe(false);
    expect(isTranslatable('', src)).toBe(false);
    expect(isTranslatable('   ', src)).toBe(false);
  });

  it('系统拼的附件记录不译', () => {
    expect(isTranslatable(src.messages[3]!.content, src)).toBe(false);
  });

  it('开场卡里没有询盘原文时不崩', () => {
    expect(isTranslatable('About 500 pcs.', { messages: src.messages })).toBe(true);
    expect(isTranslatable('x', { inquiryText: 42, messages: [] })).toBe(false);
  });
});
