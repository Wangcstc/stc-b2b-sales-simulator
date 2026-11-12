/**
 * 发布检查的判定（纯函数，读文件、调 git 在 `release-check.ts`）。需求文档第十二节、阶段 7.2。
 *
 * 发布包里只许有：柜子、抽屉、标准层、题库工具包、判定引擎、样品、文档。
 * 题目（哪怕是脱敏过的）一道都不许有——样品除外；密钥一个都不许有；客户的名字一个字都不许有。
 */

/** 题目或背调包的文件路径（题库包目录结构 / v8 之前的旧目录）。样品目录下的是虚构题，允许 */
export function isQuestionPath(path: string): boolean {
  if (path.startsWith('samples/')) return false;
  return /(^|\/)(personas|bg-packages)\/[^/]+\.json$/.test(path) || /^p0\/(personas|bg-packages)\//.test(path);
}

/** 文件内容长得像一道题（人设）或一份背调包。样品目录下的不算 */
export function looksLikeQuestion(path: string, text: string): boolean {
  // 题库格式的 JSON Schema 里也写着 hidden_card、open_card——那是格式定义，不是题
  if (path.startsWith('samples/') || !path.endsWith('.json') || path.endsWith('.schema.json')) return false;
  return (/"hidden_card"\s*:/.test(text) && /"open_card"\s*:/.test(text)) || (/"ai_report"\s*:/.test(text) && /"persona_id"\s*:/.test(text));
}

/** 像真密钥的串。示例文件里的占位（sk-xxxx…）不算 */
export function secretHits(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bsk-[A-Za-z0-9]{20,}\b/g)) if (!/^sk-x+$/i.test(m[0])) out.push(`${m[0].slice(0, 6)}…（疑似模型密钥）`);
  for (const m of text.matchAll(/postgres(?:ql)?:\/\/[^:\s"']+:([^@\s"']+)@([^/\s"']+)/g)) {
    const host = m[2]!;
    // 本机 docker 起的库和文档里的占位不算；连着外网主机又带口令的才算
    if (!/^(localhost|127\.0\.0\.1|db|postgres)(:\d+)?$/.test(host) && !/^<|\*{3}|密码|password$/i.test(m[1]!)) out.push(`数据库连接串带口令（${host}）`);
  }
  return out;
}

/** 不该进发布包的路径：本机数据、密钥文件、构建产物 */
export function isForbiddenPath(path: string): boolean {
  return /^workspace\//.test(path) || /(^|\/)\.env$/.test(path) || /(^|\/)\.env\.(local|production|development)$/.test(path) || /^\.next\//.test(path) || /^node_modules\//.test(path);
}
