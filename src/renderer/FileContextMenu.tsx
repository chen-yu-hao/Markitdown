import { useEffect, useLayoutEffect, useRef } from 'react';
import { ClipboardCopy, FolderOpen } from 'lucide-react';

/** Context actions shared by workspace tree rows and document tabs. */
export default function FileContextMenu({ path, x, y, zh, onClose }: { path: string; x: number; y: number; zh: boolean; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const t = (cn: string, en: string) => zh ? cn : en;
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(6, Math.min(x, innerWidth - r.width - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(y, innerHeight - r.height - 6))}px`;
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', close, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const copy = () => { void window.markedown.copyText(path); onClose(); };
  const reveal = () => { void window.markedown.revealFile(path); onClose(); };
  return <div ref={ref} className="document-tab-menu file-context-menu" role="menu" aria-label={t('文件菜单', 'File menu')} onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" onClick={copy}><ClipboardCopy size={15} /><span>{t('复制路径', 'Copy path')}</span></button>
    <button type="button" role="menuitem" onClick={reveal}><FolderOpen size={15} /><span>{t('在文件夹中显示', 'Show in folder')}</span></button>
  </div>;
}
