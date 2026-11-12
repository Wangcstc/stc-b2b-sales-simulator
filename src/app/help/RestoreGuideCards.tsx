'use client';

import { useState } from 'react';
import { resetGuideCards } from '@/components/Guide';

/**
 * 「把页面上的提示卡放回去」
 *
 * ★ 从版头的 ❓ 弹窗搬到这儿 ★（2026-08-27）
 * 它原来是那个弹窗底部的一个按钮。弹窗整个撤掉之后，这个动作得有个去处——
 * 它本来就属于「帮助」这件事，放帮助中心最下面正合适。
 * 一年用不了一次的按钮，不该占版头的位置。
 */
export default function RestoreGuideCards() {
  const [done, setDone] = useState(false);
  return (
    <>
      <button
        className="small"
        onClick={() => {
          resetGuideCards();
          setDone(true);
        }}
      >
        把页面上的提示卡放回去
      </button>
      {done && (
        <span className="tiny" style={{ color: 'var(--ok)', marginLeft: 8 }}>
          ✓ 刷新后重新出现
        </span>
      )}
    </>
  );
}
