/**
 * 本批脱敏词表文件：一行一个词（也可以一行写几个，用逗号隔开），`#` 后面是注释，可写「原词=替换词」。
 *
 * ★ 为什么要有文件 ★ 自家公司名、品牌、业务员的英文名和小名、工厂所在城市，正则一个都抓不到，
 * 只能显式列出来。每批都在命令行里敲一遍迟早漏一个——写成文件放在**不进仓库**的地方，
 * 投料时用 `--mask-file` 指过去，或者在 `.env` 里配 `DRAWER_MASK_FILE` 一劳永逸。
 * 词表只用于脱敏，只存在工作区的批次设置里，永远不进题库包。
 */
import { readFileSync } from 'node:fs';

export function readMaskFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ''))
    .flatMap((line) => line.split(/[,，]/))
    .map((x) => x.trim())
    .filter(Boolean);
}
