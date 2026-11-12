'use client';

import { useRef, useState } from 'react';
import styles from './cooperation.module.css';

const WECHAT_ID = 'Wangcstc';

export default function CopyWechat() {
  const account = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle');

  async function copyWechat() {
    try {
      await navigator.clipboard.writeText(WECHAT_ID);
      setStatus('copied');
    } catch {
      const selection = window.getSelection();
      if (account.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(account.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setStatus('manual');
    }
  }

  return (
    <section className={styles.contact} aria-label="联系方式">
      <div className={styles.contactRow}>
        <div className={styles.wechat}>
          <span>微信</span> <code ref={account}>{WECHAT_ID}</code>
        </div>
        <button type="button" className="primary" onClick={copyWechat}>
          {status === 'copied' ? '已复制' : '复制微信号'}
        </button>
      </div>
      <p>添加时备注「GitHub / 沙盘 + 想聊的业务」。</p>
      <span role="status" className={status === 'manual' ? styles.copyStatus : 'sr-only'}>
        {status === 'copied' && '已复制微信号'}
        {status === 'manual' && '请手动复制微信号。'}
      </span>
    </section>
  );
}
