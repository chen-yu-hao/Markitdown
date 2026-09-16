import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { GFM } from '@lezer/markdown';
import { exportCss, getSafeLinkURL, getEquationIndex, renderPaperBlocks, type MarkdownPaperBlock } from '../shared/markdown';
import { paginatePaper, paperPageCss } from '../shared/paper-pagination';
import type { DocumentSession, Settings, ThemeName } from '../shared/contracts';
import type { CitationRenderData } from '../shared/academic-contracts';
import type { EditorHandle } from './Editor';
import { codeLanguage, editorSourceMode, preferenceExtensions } from './editor-preferences';
import { sameEditorSettings } from './editor-settings-equality';
import katexCss from 'katex/dist/katex.min.css?inline';
import './article-preview.css';
import { closeNodeEditor, hasNodeEditor, openInlineTable, openMathNode, type NodeEditorTarget } from './node-editors';
import { renderDiagrams } from './diagram-runtime';
import { openElementNode, openImageNode, showImageViewer } from './element-editors';

export interface ArticlePreviewHandle { command(name: string): boolean; scrollToHeading(id: string): void }
interface Props { document: DocumentSession; settings: Settings; citations: CitationRenderData; theme: ThemeName; zh: boolean; edit(): void; editor(): EditorHandle | undefined; error(message: string): void }
interface Editing { view: EditorView; overlay: HTMLElement; from: number; originalTo: number; text: string; expected: string }

export default forwardRef<ArticlePreviewHandle, Props>(function ArticlePreview(props, ref) {
  const host = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null);
  const current = useRef(props); current.current = props;
  const editing = useRef<Editing | null>(null), blocks = useRef<MarkdownPaperBlock[]>([]);
  const nodeOwner = useRef({});
  const generation = useRef(0), disposed = useRef(false), last = useRef<{ source: string; settings: Settings; citations: CitationRenderData } | null>(null);
  const [pages, setPages] = useState(0), [inEditor, setInEditor] = useState(false);
  const root = () => host.current?.shadowRoot;
  function fitPaper() {
    if (!host.current || !scroller.current) return false;
    const available = scroller.current.clientWidth - 48;
    const zoom = Math.min(1, Math.max(.35, available / (210 * 96 / 25.4))).toFixed(6);
    if (Number(host.current.style.zoom) === Number(zoom)) return false;
    host.current.style.zoom = zoom;
    return true;
  }
  function bookmark() {
    const scroll = scroller.current;
    const nodes = [...(root()?.querySelectorAll<HTMLElement>('main:not([aria-hidden]) .paper-block[data-source-from]') || [])];
    const visible = nodes.find(node => node.getBoundingClientRect().bottom > (scroll?.getBoundingClientRect().top || 0));
    return { from: Number(visible?.dataset.sourceFrom || 0), fragment: Math.max(0, nodes.filter(node => node.dataset.sourceFrom === visible?.dataset.sourceFrom).indexOf(visible!)), y: visible?.getBoundingClientRect().top, top: scroll?.scrollTop || 0 };
  }
  async function render(anchor = bookmark(), resume?: number) {
    const el = host.current; if (!el) return;
    // CSS zoom can change text/border rounding and therefore table row heights.
    // Measure at the final window scale, including on the first layout.
    fitPaper();
    const sequence = ++generation.current, p = current.current;
    const shadow = el.shadowRoot!;
    if (!shadow.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = `${katexCss}\n${exportCss.replaceAll('html[data-table-style', '[data-table-style')}\n${paperPageCss}
        :host{display:block}*{box-sizing:border-box}.paper-block{cursor:text}.paper-block:focus-visible{outline:1px solid #718c99}
        .paper-edit-overlay{position:absolute;z-index:5;background:#fff;color:#242629;border:1px solid #79909c;box-shadow:0 3px 15px #0003;padding:8px;max-height:95mm;overflow:hidden}
        .paper-edit-overlay .cm-editor{font:10pt/1.55 Consolas,"Microsoft YaHei",monospace;max-height:85mm}.paper-edit-overlay .cm-scroller{overflow:auto;max-height:85mm}
        .paper-edit-overlay .cm-content{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0}.paper-edit-overlay .cm-line{padding:0}.paper-edit-overlay .cm-editor.cm-focused{outline:none}
        .paper-edit-overlay .cm-gutters{color:#777;background:#f5f5f5;border:0}.paper-edit-overlay .cm-selectionBackground{background:#b7d6eb!important}
        .paper-edit-caption{font:9px/1.4 Arial,"Microsoft YaHei",sans-serif;color:#66757d;margin-bottom:5px}
      `;
      shadow.append(style);
    }
    const content = document.createElement('main');
    content.className = 'markdown-body article-columns paper-pages'; content.dataset.tableStyle = p.settings.tableStyle;
    content.setAttribute('aria-hidden', 'true');
    content.style.cssText = 'position:absolute;visibility:hidden;top:0;left:0;pointer-events:none';
    content.style.setProperty('--paper-font-size', p.settings.fontSizeMode === 'auto' ? '10pt' : `${p.settings.fontSize * .78}px`);
    const next = renderPaperBlocks(p.document.source, { settings: p.settings, citations: p.citations, purpose: 'editor', imageLoading: 'eager', imageURL: destination => window.markedown.imageURL(p.document.id, destination) });
    if (!next.length) next.push({ from: 0, to: p.document.source.length, kind: 'p', html: `<p>${p.zh ? '点击开始写作' : 'Click to start writing'}</p>` });
    shadow.append(content);
    try {
      const count = await paginatePaper(content, next, () => sequence !== generation.current || disposed.current, renderDiagrams);
      if (sequence !== generation.current || disposed.current) { content.remove(); return; }
      shadow.querySelectorAll('main').forEach(old => { if (old !== content) old.remove(); });
      content.style.position = ''; content.style.visibility = ''; content.style.top = ''; content.style.left = ''; content.style.pointerEvents = '';
      content.removeAttribute('aria-hidden');
      content.querySelectorAll<HTMLElement>('.paper-block').forEach(node => node.tabIndex = 0);
      blocks.current = next; last.current = { source: p.document.source, settings: p.settings, citations: p.citations }; setPages(count);
      if (scroller.current) {
        const matches = [...content.querySelectorAll<HTMLElement>('.paper-block[data-source-from]')].filter(node => Number(node.dataset.sourceFrom) === anchor.from);
        const match = matches[Math.min(anchor.fragment, matches.length - 1)];
        scroller.current.scrollTop = anchor.top;
        if (match && anchor.y !== undefined) scroller.current.scrollTop += match.getBoundingClientRect().top - anchor.y;
      }
      if (resume !== undefined) beginAt(resume);
    } catch (error) { content.remove(); if (sequence === generation.current) p.error(String(error)); }
  }
  function finish(repaint = true) {
    const active = editing.current; if (!active) return;
    editing.current = null; active.view.destroy(); active.overlay.remove(); setInEditor(false);
    if (repaint) void render();
  }
  function masterCommand(name: string) {
    const top = scroller.current?.scrollTop;
    current.current.editor()?.command(name); editing.current?.view.focus();
    if (scroller.current && top !== undefined) scroller.current.scrollTop = top;
  }
  function beginAt(position: number, pointer?: { x: number; y: number }, fragment?: HTMLElement) {
    if (editing.current) return;
    const p = current.current;
    const block = blocks.current.find(block => position >= block.from && position < block.to) || blocks.current.find(block => block.from >= position) || blocks.current.at(-1);
    const content = root()?.querySelector<HTMLElement>('main');
    const node = fragment || (content && [...content.querySelectorAll<HTMLElement>('.paper-block[data-source-from]')].find(node => Number(node.dataset.sourceFrom) === block?.from));
    if (!block || !node || !content) return;
    const overlay = document.createElement('div'); overlay.className = 'paper-edit-overlay';
    const caption = document.createElement('div'); caption.className = 'paper-edit-caption'; caption.textContent = p.zh ? '编辑 Markdown · Ctrl+Enter 完成' : 'Edit Markdown · Ctrl+Enter to finish'; overlay.append(caption);
    const parent = document.createElement('div'); overlay.append(parent);
    const rect = node.getBoundingClientRect(), container = content.getBoundingClientRect(), scale = container.width / content.offsetWidth;
    const visibleTop = scroller.current?.getBoundingClientRect().top || rect.top;
    const editTop = Math.max(rect.top, Math.min(rect.bottom - 20 * scale, pointer ? pointer.y - 22 * scale : visibleTop + 12));
    overlay.style.left = `${(rect.left - container.left) / scale}px`; overlay.style.top = `${(editTop - container.top) / scale}px`; overlay.style.width = `${rect.width / scale}px`;
    content.append(overlay);
    const text = p.document.source.slice(block.from, block.to);
    const selection = { anchor: Math.max(0, Math.min(text.length, p.document.selection.anchor - block.from)), head: Math.max(0, Math.min(text.length, p.document.selection.head - block.from)) };
    const view = new EditorView({ parent, root: root()!, state: EditorState.create({ doc: text, selection, extensions: [
      markdown({ extensions: GFM, codeLanguages: codeLanguage }), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping, drawSelection(),
      preferenceExtensions({ ...p.settings, showLineNumbers: false }), editorSourceMode.of(true),
      keymap.of([
        { key: 'Mod-z', run: () => { masterCommand('undo'); return true; }, shift: () => { masterCommand('redo'); return true; } },
        { key: 'Mod-y', run: () => { masterCommand('redo'); return true; } },
        { key: 'Mod-Enter', run: () => { finish(); return true; } }, { key: 'Escape', run: () => { finish(); return true; } }, ...defaultKeymap]),
      EditorView.domEventHandlers({ paste(event) {
        const files = [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault(); current.current.editor()?.importImages(files); return true;
      }, drop(event) {
        const files = [...(event.dataTransfer?.files || [])].filter(file => file.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault(); current.current.editor()?.importImages(files); return true;
      } }),
      EditorView.updateListener.of(update => {
        const active = editing.current; if (!active || active.view !== update.view) return;
        const range = update.state.selection.main;
        if (update.docChanged) {
          const next = update.state.doc.toString(), previous = active.text;
          active.expected = active.expected.slice(0, active.from) + next + active.expected.slice(active.from + previous.length); active.text = next;
          const event = update.transactions.some(tr => tr.isUserEvent('input.paste')) ? 'input.paste' : 'input.type';
          if (!current.current.editor()?.applyPaperEdit(active.from, previous, next, range, event)) { queueMicrotask(() => finish()); current.current.error(p.zh ? '文稿已更新，请重新选择要编辑的段落。' : 'The document changed. Select the paragraph again.'); }
        } else if (update.selectionSet) current.current.editor()?.selectPaperRange(active.from + range.anchor, active.from + range.head);
      }),
    ] }) });
    editing.current = { view, overlay, from: block.from, originalTo: block.to, text, expected: p.document.source }; setInEditor(true);
    const top = scroller.current?.scrollTop; view.focus(); if (scroller.current && top !== undefined) scroller.current.scrollTop = top;
    if (pointer) { const position = view.posAtCoords(pointer); if (position !== null) view.dispatch({ selection: { anchor: position } }); }
    const range = view.state.selection.main; p.editor()?.selectPaperRange(block.from + range.anchor, block.from + range.head);
  }
  useImperativeHandle(ref, () => ({
    scrollToHeading(id) { root()?.getElementById(id)?.scrollIntoView({ block: 'start' }); },
    command(name) {
      if (['copy', 'cut', 'paste', 'selectAll'].includes(name)) {
        if (!editing.current && name !== 'copy') beginAt(current.current.document.selection.head);
        if (name === 'selectAll') {
          const view = editing.current?.view; if (view) view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        } else { editing.current?.view.focus(); void window.markedown.editCommand(name as 'copy' | 'cut' | 'paste'); } return true;
      }
      if (/^(metadata|toc|footnote|table|comment|underline|diagram:.*|alert:.*)$/.test(name) || ['undo', 'redo', 'bold', 'italic', 'strike', 'mark', 'code', 'codeblock', 'link', 'paragraph', 'quote', 'unorderedList', 'orderedList', 'task', 'math', 'inlineMath', 'hr', 'image', 'bibliography', 'equationLabel'].includes(name) || /^heading[1-6]$/.test(name)) {
        if (!editing.current) beginAt(current.current.document.selection.head);
        masterCommand(name); return true;
      }
      return false;
    },
  }));
  useLayoutEffect(() => {
    const el = host.current!; if (!el.shadowRoot) el.attachShadow({ mode: 'open' }); disposed.current = false;
    const click = (event: Event) => {
      const target = event.target as Element; if (target.closest('.paper-edit-overlay')) return;
      if (event.type === 'markit-image-action' && (event as CustomEvent).detail === 'view') { const img = target.closest('img'); if (img) showImageViewer(img.src, img.alt); return; }
      if (event.type === 'click' && target.closest('img')) { event.preventDefault(); return; }
      if (event.type === 'dblclick') { const img = target.closest('img'); if (img) { event.preventDefault(); showImageViewer(img.src, img.alt); } return; }
      if (event.type === 'contextmenu' && !target.closest('td,th')) return;
      if (target instanceof HTMLElement && (target.scrollWidth > target.clientWidth || target.scrollHeight > target.clientHeight)) {
        const style = getComputedStyle(target);
        if (/auto|scroll/.test(style.overflowX + style.overflowY)) return;
      }
      const selection = (el.shadowRoot as ShadowRoot & { getSelection?(): Selection }).getSelection?.() || document.getSelection();
      if (selection && !selection.isCollapsed) return;
      const link = target.closest('a');
      if (link && link.hasAttribute('data-source-target')) {
        event.preventDefault(); const position = Number(link.dataset.sourceTarget);
        if (Number.isInteger(position)) {
          const node = [...(root()?.querySelectorAll<HTMLElement>('main:not([aria-hidden]) .paper-block[data-source-from]') || [])].find(node => Number(node.dataset.sourceFrom) <= position && Number(node.dataset.sourceTo) > position);
          node?.scrollIntoView({ block: 'center' });
        }
        return;
      }
      if (link && ((event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey)) {
        event.preventDefault(); const href = link.getAttribute('href') || '';
        if (href.startsWith('#')) { try { root()?.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'center' }); } catch { /* Invalid anchor. */ } }
        else { const safe = getSafeLinkURL(href); if (safe && /^(https?:|mailto:)/i.test(safe)) void window.markedown.openExternal(safe); else void window.markedown.openDocumentLink(current.current.document.id, href); } return;
      }
      const block = target.closest<HTMLElement>('.paper-block[data-source-from]'); if (!block) return;
      if (!editing.current) {
        const p = current.current, from = Number(block.dataset.sourceFrom), to = Number(block.dataset.sourceTo);
        const cell = target.closest<HTMLTableCellElement>('td,th');
        const equations = getEquationIndex(p.document.source, p.settings);
        const math = target.closest<HTMLElement>('.math-block[data-equation-from],.md-equation-inline[data-equation-from]');
        const equation = math && equations.equations.find(eq => eq.from === Number(math.dataset.equationFrom));
        const start = equation ? equation.from : from, end = equation ? equation.to : to;
        const node: NodeEditorTarget = {
          owner: nodeOwner.current, source: p.document.source.slice(start, end), documentSource: p.document.source, from: start, anchor: math || block, settings: p.settings, equations, citations: p.citations, imageURL: destination => window.markedown.imageURL(p.document.id, destination),
          apply: (previous, next, event) => !!current.current.editor()?.applyPaperEdit(start, previous, next, { anchor: 0, head: 0 }, event),
          close: () => { if (!disposed.current) void render(); },
        };
        if (cell && openInlineTable(node, cell.closest('table') as HTMLTableElement, Number(cell.parentElement!.dataset.sourceRow || 0), cell.cellIndex)) { event.preventDefault(); return; }
        if (equation && openMathNode(node, equation.block)) { event.preventDefault(); return; }
        if (target.closest('img') && openImageNode(node)) { event.preventDefault(); return; }
        if (openElementNode(node)) { event.preventDefault(); return; }
      }
      event.preventDefault(); let position = Number(block.dataset.sourceFrom); const active = editing.current;
      if (active) { if (position >= active.originalTo) position += active.text.length - (active.originalTo - active.from); finish(false); void render(undefined, position); }
      else beginAt(position, { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY }, block);
    };
    el.shadowRoot!.addEventListener('click', click);
    el.shadowRoot!.addEventListener('contextmenu', click);
    el.shadowRoot!.addEventListener('markit-image-action', click);
    el.shadowRoot!.addEventListener('dblclick', click);
    const keydown = (event: Event) => {
      const key = event as KeyboardEvent, node = event.target as HTMLElement;
      if ((key.key === 'Enter' || key.key === 'F2') && node.matches('.paper-block[data-source-from]')) {
        key.preventDefault();
        const editable = node.querySelector<HTMLElement>('td,th,.math-block,.md-equation-inline');
        if (editable) editable.click(); else { finish(false); beginAt(Number(node.dataset.sourceFrom), undefined, node); }
      }
    };
    el.shadowRoot!.addEventListener('keydown', keydown);
    const resize = new ResizeObserver(() => {
      const anchor = bookmark();
      if (fitPaper() && !editing.current && !hasNodeEditor(nodeOwner.current)) void render(anchor);
    }); resize.observe(scroller.current!);
    return () => { disposed.current = true; generation.current++; closeNodeEditor(nodeOwner.current); editing.current?.view.destroy(); editing.current = null; resize.disconnect(); el.shadowRoot?.removeEventListener('click', click); el.shadowRoot?.removeEventListener('contextmenu', click); el.shadowRoot?.removeEventListener('markit-image-action', click); el.shadowRoot?.removeEventListener('dblclick', click); el.shadowRoot?.removeEventListener('keydown', keydown); };
  }, []);
  useLayoutEffect(() => {
    if (hasNodeEditor(nodeOwner.current)) {
      if (last.current && !sameEditorSettings(last.current.settings, props.settings)) closeNodeEditor(nodeOwner.current);
      return;
    }
    const active = editing.current;
    if (active && active.expected === props.document.source && last.current && sameEditorSettings(last.current.settings, props.settings) && last.current.citations === props.citations) return;
    if (active?.view.composing) return;
    const unchanged = last.current?.source === props.document.source && sameEditorSettings(last.current.settings, props.settings) && last.current.citations === props.citations;
    if (!unchanged || active) { const position = active ? props.document.selection.head : undefined; finish(false); void render(undefined, position); }
  }, [props.document.source, props.settings, props.citations]);
  return <section className="article-preview" aria-label={props.zh ? '双栏论文编辑' : 'Two-column article editor'}>
    <div className="article-preview-tools"><span>{props.zh ? `A4 双栏 · ${pages} 页` : `A4 · Two columns · ${pages} pages`}</span><div>{inEditor && <button type="button" onClick={() => finish()}>{props.zh ? '完成编辑' : 'Finish editing'}</button>}<button type="button" onClick={props.edit}>{props.zh ? '全文源码' : 'Full source'} <kbd>Ctrl+/</kbd></button></div></div>
    <div className="article-preview-scroll" ref={scroller} tabIndex={0} aria-label={props.zh ? '论文内容' : 'Article content'}><div className="article-preview-paper" ref={host} /></div>
  </section>;
});
