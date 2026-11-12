'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { anchorOf, findPage, type HelpPage, type HelpVars } from '@/content/help';
import Icon from './Icon';

/**
 * 第 3 层：页面帮助抽屉（2026-08-27）
 *
 * ★ 补的是原来缺的那一层 ★
 * 在这之前只有两个容器：气泡（440px，装一句话的地方）和全局新人指引
 * （讲「一局怎么打」，不讲某一页怎么用）。中间那层——「这一页的完整口径」——
 * 没有容器，于是全被硬塞进气泡，塞出了八条带滚动条的说明书。
 * 抽屉就是那个缺掉的容器：宽 460px、能滚、有目录、有锚点，
 * 装得下文档，所以气泡终于可以只装一句话。
 *
 * ★ 为什么是抽屉不是新页面 ★
 * 看说明的人正在做事——他要一边对着表格一边读口径。跳走一个页面，
 * 回来时筛选条件、展开的行、翻到第几页全没了。抽屉盖在旁边，关掉就接着干。
 * 真要通读的人有 /help，那是第 4 层。
 *
 * ★ 状态放 Provider，不放各页 ★
 * 气泡里的「看完整说明」要能把抽屉拉开并滚到自己那一节，
 * 而气泡散在页面各处。用 context 传，页面不用管这件事。
 */

interface HelpCtx {
  /** 当前页在帮助注册表里的 id；没注册就是 null，气泡退化成只显示摘要 */
  pageId: string | null;
  vars: HelpVars;
  /** 打开抽屉；给了 sectionId 就滚到那一节 */
  open: (sectionId?: string) => void;
  register: (pageId: string, vars: HelpVars) => void;
}

const Ctx = createContext<HelpCtx | null>(null);

export function useHelp(): HelpCtx | null {
  return useContext(Ctx);
}

export default function HelpProvider({ children }: { children: React.ReactNode }) {
  const [pageId, setPageId] = useState<string | null>(null);
  const [vars, setVars] = useState<HelpVars>({});
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  const register = useCallback((id: string, v: HelpVars) => {
    setPageId(id);
    setVars(v);
  }, []);

  const open = useCallback((sectionId?: string) => {
    setOpenAt(sectionId ?? '');
    setShown(true);
  }, []);

  const close = useCallback(() => {
    setShown(false);
    setOpenAt(null);
  }, []);

  const value = useMemo<HelpCtx>(() => ({ pageId, vars, open, register }), [pageId, vars, open, register]);

  const page = pageId ? findPage(pageId) : undefined;

  return (
    <Ctx.Provider value={value}>
      {children}
      {shown && page && <HelpDrawer page={page} vars={vars} at={openAt} onClose={close} />}
    </Ctx.Provider>
  );
}

/**
 * 抽屉本体。
 *
 * ★ 目录不是装饰 ★ 账号管理有 11 节，没有目录就只能从头滚着找。
 * 点目录跳锚点，和 /help 用的是同一套 anchorOf()。
 */
function HelpDrawer({
  page,
  vars,
  at,
  onClose,
}: {
  page: HelpPage;
  vars: HelpVars;
  at: string | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Esc 关掉。和气泡同一个手势——这一套里所有浮层都认 Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 抽屉盖住了半屏，底下的页面再跟着滚就是两层在动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  /**
   * 从气泡 / 表头小字点进来的，要落在他问的那一节上。
   *
   * ★ 用容器内滚动而不是 scrollIntoView ★ 后者会把整个 <body> 也带着滚，
   * 而 body 这会儿是锁死的，实测在 Chrome 上会让抽屉自己跳半屏。
   *
   * ★ 用 getBoundingClientRect 相减，不用 offsetTop ★（2026-08-27 修）
   * 第一版写的是 `el.offsetTop - box.offsetTop`，实测滚不动、scrollTop 恒为 0：
   * offsetTop 量的是「到最近一个定位祖先的距离」，而 .help-drawer-body
   * 没有 position，两个 offsetTop 各自以别的元素为基准，相减没有意义。
   * rect 相减量的是当前视口内的实际距离，加回 scrollTop 就是要滚到的位置——
   * 不依赖任何一层有没有开定位。
   */
  useEffect(() => {
    panelRef.current?.focus();
    if (!at) return;
    const el = document.getElementById(anchorOf(page.id, at));
    const box = bodyRef.current;
    if (!el || !box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    /* ★ 必须写 'instant'，不能写 'auto' ★（2026-08-27 实测踩到）
       规范里 behavior:'auto' 的意思是「沿用元素计算出来的 scroll-behavior」——
       而 .help-drawer-body 上有 scroll-behavior: smooth（给目录点击用的），
       于是这次跳转也被当成平滑滚动。平滑滚动靠 rAF 推进，页面不在合成状态时
       它一帧都不走，scrollTop 会一直停在 0：抽屉开了，但停在最上面，
       人以为「点了没反应」。
       程序化的「带我去这一节」本来就该是瞬时的——平滑只适合用户自己点目录，
       那种场合他需要看见页面在动。 */
    box.scrollTo({ top: Math.max(0, top - 8), behavior: 'instant' });
    el.classList.add('help-sec-hit');
    const t = window.setTimeout(() => el.classList.remove('help-sec-hit'), 1400);
    return () => window.clearTimeout(t);
  }, [at, page.id]);

  return (
    <div className="help-scrim" onClick={onClose} role="presentation">
      <aside
        className="help-drawer"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${page.title}·使用说明`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="help-drawer-head">
          <div>
            <div className="help-drawer-kicker">使用说明</div>
            <b>{page.title}</b>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="help-drawer-body" ref={bodyRef}>
          <p className="help-drawer-intro">{page.intro}</p>

          {/* 目录：11 节的页面没有它只能从头滚着找 */}
          {page.sections.length > 3 && (
            <nav className="help-toc" aria-label="本页说明目录">
              {page.sections.map((s) => (
                <a key={s.id} href={`#${anchorOf(page.id, s.id)}`}>
                  {s.title}
                </a>
              ))}
            </nav>
          )}

          {page.sections.map((s) => (
            <section key={s.id} id={anchorOf(page.id, s.id)} className="help-sec">
              <h3>{s.title}</h3>
              <div className="help-body">{s.body(vars)}</div>
            </section>
          ))}

          <footer className="help-drawer-foot">
            <a href={`/help#${anchorOf(page.id, page.sections[0]?.id ?? '')}`}>
              在帮助中心看全部说明 →
            </a>
          </footer>
        </div>
      </aside>
    </div>
  );
}
