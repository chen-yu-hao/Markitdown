import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, FileText, PanelsTopLeft, X } from 'lucide-react';
import type { DocumentSession } from '../shared/contracts';
import './document-tabs.css';

export interface DocumentTabsProps {
  documents: DocumentSession[];
  activeId: string;
  zh: boolean;
  busy: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
  onCloseOthers(id: string): void;
  onDetach(id: string, position?: { x: number; y: number }): void;
}

interface TabMenu { id: string; x: number; y: number }
interface TabDrag {
  id: string;
  pointerId: number;
  element: HTMLDivElement;
  startX: number;
  startY: number;
  started: boolean;
}
interface DragFeedback { id: string; x: number; y: number; detach: boolean }

const dragThreshold = 8;
const detachDistance = 24;

export default function DocumentTabs({ documents, activeId, zh, busy, onSelect, onClose, onCloseOthers, onDetach }: DocumentTabsProps) {
  const tabs = useRef<HTMLDivElement>(null);
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const popup = useRef<HTMLDivElement>(null);
  const drag = useRef<TabDrag | null>(null);
  const suppressClick = useRef(false);
  const [menu, setMenu] = useState<TabMenu | null>(null);
  const [feedback, setFeedback] = useState<DragFeedback | null>(null);
  const t = (cn: string, en: string) => zh ? cn : en;
  const title = (doc: DocumentSession) => !doc.path && doc.title === 'Untitled' ? t('未命名', 'Untitled') : doc.title;

  const finishDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setFeedback(null);
    if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    return current;
  }, []);

  const cancelDrag = useCallback(() => {
    if (drag.current) suppressClick.current = true;
    finishDrag();
  }, [finishDrag]);

  const dismissMenu = useCallback((restoreFocus = false) => {
    if (restoreFocus && menu) tabElements.current.get(menu.id)?.focus({ preventScroll: true });
    setMenu(null);
  }, [menu]);

  useEffect(() => {
    const pointerDown = () => { if (!drag.current) suppressClick.current = false; };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelDrag();
    };
    const visibilityChange = () => { if (document.hidden) cancelDrag(); };
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('visibilitychange', visibilityChange);
    window.addEventListener('blur', cancelDrag);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('visibilitychange', visibilityChange);
      window.removeEventListener('blur', cancelDrag);
      const current = drag.current;
      drag.current = null;
      if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
    };
  }, [cancelDrag]);

  useEffect(() => {
    document.documentElement.classList.toggle('document-tab-dragging', Boolean(feedback));
    return () => document.documentElement.classList.remove('document-tab-dragging');
  }, [Boolean(feedback)]);

  useEffect(() => {
    if (busy || drag.current && !documents.some(doc => doc.id === drag.current!.id)) cancelDrag();
    if (busy || menu && !documents.some(doc => doc.id === menu.id)) setMenu(null);
  }, [busy, documents, menu, cancelDrag]);

  useEffect(() => {
    if (!menu) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) dismissMenu();
    };
    const blur = () => dismissMenu();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('blur', blur); };
  }, [menu, dismissMenu]);

  useLayoutEffect(() => {
    const element = popup.current;
    if (!menu || !element) return;
    const position = () => {
      const rect = element.getBoundingClientRect();
      element.style.left = `${Math.max(6, Math.min(menu.x, window.innerWidth - rect.width - 6))}px`;
      element.style.top = `${Math.max(6, Math.min(menu.y, window.innerHeight - rect.height - 6))}px`;
    };
    position();
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(element);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [menu]);

  function outsideBand(x: number, y: number) {
    const element = tabs.current?.closest('.tab-band') || tabs.current;
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return x < rect.left - detachDistance || x > rect.right + detachDistance || y < rect.top - detachDistance || y > rect.bottom + detachDistance;
  }

  function startPointer(event: PointerEvent<HTMLDivElement>, id: string) {
    if (busy || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest('button')) return;
    if (drag.current) cancelDrag();
    suppressClick.current = false;
    setMenu(null);
    drag.current = { id, pointerId: event.pointerId, element: event.currentTarget, startX: event.clientX, startY: event.clientY, started: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (busy || !(event.buttons & 1)) { cancelDrag(); return; }
    if (!current.started) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < dragThreshold) return;
      current.started = true;
      suppressClick.current = true;
      onSelect(current.id);
      current.element.focus({ preventScroll: true });
    }
    event.preventDefault();
    setFeedback({ id: current.id, x: event.clientX, y: event.clientY, detach: outsideBand(event.clientX, event.clientY) });
  }

  function releasePointer(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const current = finishDrag();
    if (!current?.started) return;
    event.preventDefault();
    suppressClick.current = true;
    if (!busy && event.button === 0 && outsideBand(event.clientX, event.clientY)) onDetach(current.id, { x: event.screenX, y: event.screenY });
  }

  function tabKeyDown(event: KeyboardEvent<HTMLDivElement>, id: string) {
    if (busy || event.target !== event.currentTarget) return;
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ id, x: rect.left + 8, y: rect.bottom });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
    } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = documents.findIndex(doc => doc.id === id);
      const next = documents[event.key === 'Home' ? 0 : event.key === 'End' ? documents.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + documents.length) % documents.length];
      if (next) { onSelect(next.id); tabElements.current.get(next.id)?.focus(); }
    }
  }

  function menuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      dismissMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function menuAction(action: (id: string) => void) {
    if (!menu || busy) return;
    const id = menu.id;
    dismissMenu(true);
    action(id);
  }

  const draggedDocument = feedback && documents.find(doc => doc.id === feedback.id);
  return <>
    <div ref={tabs} className="document-tabs" role="tablist" aria-label={t('文稿', 'Documents')} aria-busy={busy}>
      {documents.map(doc => <div key={doc.id} ref={element => { if (element) tabElements.current.set(doc.id, element); else tabElements.current.delete(doc.id); }} role="tab" tabIndex={busy ? -1 : 0} aria-selected={activeId === doc.id} aria-disabled={busy} aria-haspopup="menu" aria-expanded={menu?.id === doc.id} className={`document-tab ${activeId === doc.id ? 'selected' : ''}${feedback?.id === doc.id ? ' is-dragging' : ''}`} title={doc.path || doc.title} data-testid="document-tab"
        onClick={() => { if (!busy && !suppressClick.current) onSelect(doc.id); }}
        onKeyDown={event => tabKeyDown(event, doc.id)}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (!busy) { cancelDrag(); setMenu({ id: doc.id, x: event.clientX, y: event.clientY }); } }}
        onPointerDown={event => startPointer(event, doc.id)} onPointerMove={movePointer} onPointerUp={releasePointer}
        onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
        onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancelDrag(); }}
        onDragStart={event => event.preventDefault()}>
        <FileText size={14} /><span>{title(doc)}</span>
        {(doc.dirty || doc.recovered) && <i className="dirty-dot" aria-label={t('未保存', 'Unsaved')} />}
        <button type="button" disabled={busy} aria-label={t(`关闭 ${doc.title}`, `Close ${doc.title}`)} title={t('关闭', 'Close')} onClick={event => { event.stopPropagation(); if (!busy) onClose(doc.id); }}><X size={13} /></button>
      </div>)}
    </div>
    {menu && createPortal(<div ref={popup} role="menu" aria-label={t('标签菜单', 'Tab menu')} className="document-tab-menu" data-testid="document-tab-menu" onKeyDown={menuKeyDown} onContextMenu={event => event.preventDefault()}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => menuAction(onDetach)}><ExternalLink size={15} /><span>{t('打开新窗口', 'Open in new window')}</span></button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => menuAction(onClose)}><X size={15} /><span>{t('关闭', 'Close')}</span></button>
      <button type="button" role="menuitem" disabled={busy || documents.length < 2} onClick={() => menuAction(onCloseOthers)}><PanelsTopLeft size={15} /><span>{t('关闭其他标签', 'Close other tabs')}</span></button>
    </div>, document.body)}
    {feedback && draggedDocument && createPortal(<div className={`document-tab-ghost${feedback.detach ? ' is-detaching' : ''}`} aria-hidden="true" style={{ left: Math.max(6, Math.min(feedback.x + 12, window.innerWidth - 226)), top: Math.max(6, Math.min(feedback.y + 14, window.innerHeight - 40)) }}>
      {feedback.detach ? <ExternalLink size={14} /> : <FileText size={14} />}<span>{title(draggedDocument)}</span>
      {(draggedDocument.dirty || draggedDocument.recovered) && <i className="dirty-dot" />}
    </div>, document.body)}
  </>;
}
