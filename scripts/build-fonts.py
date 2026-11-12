# -*- coding: utf-8 -*-
"""
重新生成 src/app/fonts/ 下的四个 woff2。

    pip install "fonttools[woff]" brotli
    python scripts/build-fonts.py

【什么时候要跑】
  · 界面上新增了大量中文，想把新字并进常用字包（改字集靠 SOURCE_DIRS 自动扫）
  · 要换字体、换字重范围
  · 升级 Noto Sans SC / Inter / JetBrains Mono 版本
平时不用跑。woff2 是产物，但**故意入仓**——构建期不联网是硬要求，
云端构建环境未必能联网拉字体，拉不到就整个 build 失败。

【产物与取舍】
  inter.woff2   34KB  拉丁字母、数字、ID。字号与字距都是照它调的
  mono.woff2    29KB  等宽：简码、演习 ID、日期、题库编号
  sc.woff2     1.7MB  中文常用字＝源码里出现过的字 ∪ GB2312 全部 6763 字 ∪ 标点
  sc-ext.woff2 3.8MB  GBK 减去上面那批，14103 字。犇 喆 昇 这类人名用字在这里
                      ★ 只有页面上真的出现这些字时才会被下载 ★ 靠的是 globals.css
                      里 --font-sc / --font-sc-ext 两个不同家族名的逐字回退，
                      不是 unicode-range（等价的 range 声明要 67KB，而且字集是散的压不动）

【为什么字重轴收到 400–700】
  界面上只用到 400/500/600/700。可变字体一个文件覆盖四档，
  比「静态 400 + 静态 700 两个文件」还小：实测 1732KB vs 1932KB。
"""
import io
import os
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.path.join(ROOT, '_fontwork')
OUT = os.path.join(ROOT, 'src', 'app', 'fonts')

# 上游都取 google/fonts 主干的可变字体原件
SOURCES = {
    'noto.ttf': 'https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    'inter.ttf': 'https://github.com/google/fonts/raw/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf',
    'mono.ttf': 'https://github.com/google/fonts/raw/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
}

# 扫这些目录里的中文，保证界面上写过的字一定在常用字包里
SOURCE_DIRS = ['src', 'prisma', 'p0']

# 拉丁包要覆盖的码位。箭头、勾叉、圈码都在界面上出现过，别删
LATIN = (
    'U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,'
    'U+2000-206F,U+2074,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD,'
    'U+2190-21FF,U+2460-2469,U+25A0-25FF,U+2713,U+2717,U+2705,U+00D7'
)
PUNCT = ('　、。〈〉《》「」『』【】〔〕！？：；，．…—～·¥￥°％‰′″＋－×÷＝≈≠≤≥'
         '←→↑↓★☆✓✗✔✘●○■□▲△▼▽◆◇①②③④⑤⑥⑦⑧⑨⑩')


def run(*args):
    r = subprocess.run([sys.executable, '-m'] + list(args), capture_output=True)
    if r.returncode != 0:
        sys.exit(r.stderr.decode('utf-8', 'replace')[-2000:])


def fetch(name, url):
    dst = os.path.join(WORK, name)
    if os.path.exists(dst) and os.path.getsize(dst) > 100_000:
        print('  已有 %s，跳过下载' % name)
        return dst
    print('  下载 %s ...' % name)
    urllib.request.urlretrieve(url, dst)
    return dst


def source_hanzi():
    cjk = re.compile('[一-鿿㐀-䶿]')
    found = set()
    for base in SOURCE_DIRS:
        d = os.path.join(ROOT, base)
        if not os.path.isdir(d):
            continue
        for root, _, files in os.walk(d):
            for f in files:
                if f.endswith(('.tsx', '.ts', '.json')):
                    try:
                        found.update(cjk.findall(io.open(os.path.join(root, f), encoding='utf-8').read()))
                    except Exception:
                        pass
    return found


def charset_by_codec(codec):
    """把一个中文编码里的汉字全枚举出来（gb2312 → 6763 字，gbk → 20902 字）"""
    cjk = re.compile('[一-鿿]')
    out = set()
    for hi in range(0x81, 0xFF):
        for lo in range(0x40, 0xFF):
            if lo == 0x7F:
                continue
            try:
                ch = bytes([hi, lo]).decode(codec)
            except Exception:
                continue
            if cjk.match(ch):
                out.add(ch)
    return out


def write_text(name, chars):
    p = os.path.join(WORK, name)
    io.open(p, 'w', encoding='utf-8').write(''.join(sorted(chars)))
    return p


def subset(src, out_name, *, text_file=None, unicodes=None, features):
    out = os.path.join(OUT, out_name)
    args = ['fontTools.subset', src, '--output-file=' + out, '--flavor=woff2',
            '--no-hinting', '--desubroutinize', '--layout-features=' + features]
    args.append('--text-file=' + text_file if text_file else '--unicodes=' + unicodes)
    run(*args)
    print('  %-14s %6.0f KB' % (out_name, os.path.getsize(out) / 1024))


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)

    print('① 取上游字体')
    noto = fetch('noto.ttf', SOURCES['noto.ttf'])
    inter = fetch('inter.ttf', SOURCES['inter.ttf'])
    mono = fetch('mono.ttf', SOURCES['mono.ttf'])

    print('② 收窄字重轴到 400–700')
    noto_i = os.path.join(WORK, 'noto-400-700.ttf')
    inter_i = os.path.join(WORK, 'inter-400-700.ttf')
    mono_i = os.path.join(WORK, 'mono-400-700.ttf')
    run('fontTools.varLib.instancer', noto, 'wght=400:700', '-o', noto_i)
    # Inter 还有个 opsz 光学尺寸轴，界面字号集中在 12–25px，定在 16 即可
    run('fontTools.varLib.instancer', inter, 'opsz=16', 'wght=400:700', '-o', inter_i)
    run('fontTools.varLib.instancer', mono, 'wght=400:700', '-o', mono_i)

    print('③ 算字集')
    src = source_hanzi()
    common = src | charset_by_codec('gb2312') | set(chr(c) for c in range(0x20, 0x7F)) | set(PUNCT)
    ext = (src | charset_by_codec('gbk')) - common
    print('  源码汉字 %d ｜ 常用包 %d 字 ｜ 生僻包 %d 字' % (len(src), len(common), len(ext)))

    print('④ 子集化')
    subset(inter_i, 'inter.woff2', unicodes=LATIN, features='kern,liga,clig,calt,tnum,cv01,ss01')
    subset(mono_i, 'mono.woff2', unicodes=LATIN, features='kern,calt,tnum')
    subset(noto_i, 'sc.woff2', text_file=write_text('subset.txt', common),
           features='kern,liga,clig,calt,locl')
    subset(noto_i, 'sc-ext.woff2', text_file=write_text('subset-ext.txt', ext),
           features='kern,liga,clig,calt,locl')

    print('\n完成。_fontwork/ 是中间产物，不入仓（.gitignore 已忽略）。')


if __name__ == '__main__':
    main()
