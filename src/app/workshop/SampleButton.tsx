'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { postJson } from './ChoiceCard';

/** 首次引导的「先装样品题库试玩」：装 8 道虚构的露营用品题，装完刷新首页就能打 */
export default function SampleButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="ws-row">
      <button
        className="ghost"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await postJson('/api/workshop/bank/sample', {});
            router.refresh();
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '装入中…' : '装入样品题库'}
      </button>
      {err && <span className="small choice-err">{err}</span>}
    </span>
  );
}
