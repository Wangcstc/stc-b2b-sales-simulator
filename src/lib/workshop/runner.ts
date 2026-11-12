/**
 * 题库工坊的后台加工：页面点「开始加工」后立刻返回，加工在服务端进程里接着跑，页面轮询进度。
 *
 * ★ 状态以抽屉落盘的为准 ★ 这里只记「此刻有没有在跑、跑到哪一步」这种进程内的事。
 * 服务器重启了，这张表就空了——没关系：抽屉每一步都落盘，再点一次「继续加工」从断点接着跑，
 * 已经花过钱的步骤不会再花。
 *
 * ★ 同一批只跑一个 ★ 主管连着答了五张卡，每张都会要求加工；正在跑就只记一笔「跑完再来一轮」，
 * 不会起五个并发去抢同一批的文件。
 */
import { OpenAiLlm, run, type Llm, type RunReport, type Store } from '../../../drawer/index';

export interface RunState {
  running: boolean;
  /** 跑完这一轮还要再来一轮（跑的时候又有人答了卡） */
  again: boolean;
  progress: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  last?: RunReport;
}

const g = globalThis as unknown as { __workshopRuns?: Map<string, RunState>; __workshopLlm?: () => Llm };
const runs = (g.__workshopRuns ??= new Map<string, RunState>());

/** 测试时换成假的模型；正式运行用 OpenAI 兼容协议连 DeepSeek */
export function setLlmFactory(f: (() => Llm) | undefined) {
  g.__workshopLlm = f;
}

export function runState(batchId: string): RunState | undefined {
  return runs.get(batchId);
}

/** 开跑或续跑。已经在跑就只记一笔「跑完再来一轮」 */
export function startRun(store: Store, batchId: string): RunState {
  const cur = runs.get(batchId);
  if (cur?.running) {
    cur.again = true;
    return cur;
  }
  const st: RunState = { running: true, again: false, progress: '准备中', startedAt: new Date().toISOString() };
  runs.set(batchId, st);
  void (async () => {
    try {
      do {
        st.again = false;
        st.last = await run(store, batchId, (g.__workshopLlm ?? (() => new OpenAiLlm()))(), {
          onProgress: (m) => {
            st.progress = m;
          },
        });
      } while (st.again);
      st.error = undefined;
    } catch (e) {
      st.error = (e as Error).message ?? String(e);
    } finally {
      st.running = false;
      st.finishedAt = new Date().toISOString();
      st.progress = st.error ? '停下了' : '这一轮做完了';
    }
  })();
  return st;
}

/** 测试用：等某一批跑完 */
export async function waitIdle(batchId: string, timeoutMs = 30_000): Promise<RunState | undefined> {
  const t0 = Date.now();
  while (runs.get(batchId)?.running) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等加工结束超时');
    await new Promise((r) => setTimeout(r, 20));
  }
  return runs.get(batchId);
}
