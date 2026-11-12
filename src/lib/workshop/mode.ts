/**
 * 题库工坊开在哪种部署上（王老师 2026-11-06 定：常驻服务器才开工坊）。
 *
 * ★ 为什么托管平台上只开题库页 ★ 加工一批聊天要连续调大模型很久（单份就可能超过 5 分钟），
 * 中间状态存在服务器硬盘上。Vercel 这类托管平台硬盘是临时的、单次请求最长 5 分钟，
 * 工坊在上面跑到一半就会丢。所以那里只留「题库」页：在本机跑工坊、打出题库包，再回来上传装入。
 *
 *   full       投料、加工、确认、题库、覆盖五页全开（自有服务器、内网电脑、本机）
 *   bank-only  只开题库与覆盖两页（托管平台）
 *
 * 自动判断：有 `VERCEL` 环境变量就是 bank-only。别的托管平台用 `WORKSHOP_MODE=bank-only` 显式指定。
 */
export type WorkshopMode = 'full' | 'bank-only';

export function workshopMode(env: Record<string, string | undefined> = process.env): WorkshopMode {
  const m = env.WORKSHOP_MODE;
  if (m === 'full' || m === 'bank-only') return m;
  return env.VERCEL ? 'bank-only' : 'full';
}

export const BANK_ONLY_NOTICE =
  '这套系统部署在托管平台上，平台的硬盘是临时的，加工题库要在本机或自有服务器上做。做法：在本机装一份本系统，用题库工坊加工、打包，再回到这里的「题库」页上传题库包装入。';
