/** Browser-only pagination. Keep helpers inside this function for isolated-world export. */
export async function paginatePaper(host: HTMLElement, blocks: Array<{ html: string; from: number; to: number; kind: string }>, cancelled = () => false, prepare?: (root: HTMLElement) => Promise<void>) {
  const doc = host.ownerDocument;
  host.classList.add('paper-pages');
  const staging = doc.createElement('div');
  staging.style.cssText = 'position:absolute;visibility:hidden;width:80mm;pointer-events:none';
  const pending: HTMLElement[] = blocks.map(block => {
    const node = doc.createElement('div');
    node.className = 'paper-block';
    node.dataset.sourceFrom = String(block.from); node.dataset.sourceTo = String(block.to); node.dataset.kind = block.kind;
    node.innerHTML = block.html;
    node.querySelectorAll('table').forEach(table => Array.from(table.rows).forEach((row, index) => { row.dataset.sourceRow = String(index); }));
    staging.append(node); return node;
  });
  host.append(staging);
  await prepare?.(staging);
  await doc.fonts.ready;
  await Promise.all(Array.from(staging.querySelectorAll('img'), image => image.complete ? Promise.resolve() : new Promise<void>(resolve => {
    image.addEventListener('load', () => resolve(), { once: true }); image.addEventListener('error', () => resolve(), { once: true });
  })));
  let pageNumber = 0, columnIndex = 0;
  let columns: HTMLElement[] = [], page: HTMLElement;
  function newPage() {
    if (++pageNumber > 2000) throw new Error('The document exceeds the 2,000 page limit.');
    page = doc.createElement('section'); page.className = 'paper-sheet'; page.dataset.page = String(pageNumber);
    page.setAttribute('aria-label', `Page ${pageNumber}`);
    page.innerHTML = '<div class="paper-body"><div class="paper-lead"></div><div class="paper-columns"><div class="paper-column"></div><div class="paper-column"></div></div></div><footer class="paper-footer"></footer>';
    page.querySelector('.paper-footer')!.textContent = String(pageNumber);
    host.append(page); columns = Array.from(page.querySelectorAll<HTMLElement>('.paper-column')); columnIndex = 0;
  }
  const nextColumn = () => { if (columnIndex === 0) columnIndex = 1; else newPage(); };
  const fits = (column: HTMLElement) => column.scrollHeight <= column.clientHeight + 1;
  // A range split preserves inline elements, formatting and Unicode code points.
  function splitText(node: HTMLElement, column: HTMLElement): HTMLElement | null {
    if (node.querySelector('table,img') || /^h[1-6]$/.test(node.dataset.kind || '')) return null;
    const points: Array<{ node: Text; offset: number }> = [];
    const walker = doc.createTreeWalker(node, 4);
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (text.parentElement?.closest('svg,math,.katex,.md-math,.math-block')) continue;
      for (const match of text.data.matchAll(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)) points.push({ node: text, offset: match.index! + match[0].length });
    }
    if (points.length < 2) return null;
    const candidate = node.cloneNode(false) as HTMLElement;
    node.replaceWith(candidate);
    const range = doc.createRange(); range.selectNodeContents(node);
    let low = 0, high = points.length - 1, best = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      range.setEnd(points[middle].node, points[middle].offset);
      candidate.replaceChildren(range.cloneContents());
      if (fits(column) && candidate.offsetHeight >= 24) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    if (best < 0 || best === points.length - 1) { candidate.replaceWith(node); return null; }
    range.setEnd(points[best].node, points[best].offset); candidate.replaceChildren(range.cloneContents());
    range.selectNodeContents(node); range.setStart(points[best].node, points[best].offset);
    const tail = node.cloneNode(false) as HTMLElement; tail.append(range.cloneContents()); tail.dataset.continuation = 'true';
    return tail;
  }
  function splitTable(node: HTMLElement, column: HTMLElement): HTMLElement | null {
    const table = node.querySelector('table');
    const body = table?.tBodies[0];
    if (!table || !body || body.rows.length < 2) return null;
    const tail = node.cloneNode(true) as HTMLElement;
    const tailBody = tail.querySelector('tbody')!;
    tailBody.replaceChildren(); tail.dataset.continuation = 'true';
    const rows = Array.from(body.rows);
    let low = 1, high = rows.length - 1, best = 0;
    while (low <= high) {
      const middle = (low + high) >> 1; body.replaceChildren(...rows.slice(0, middle));
      if (fits(column)) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    if (!best) { body.replaceChildren(...rows); return null; }
    body.replaceChildren(...rows.slice(0, best)); tailBody.replaceChildren(...rows.slice(best)); return tail;
  }
  function splitBibliography(node: HTMLElement, column: HTMLElement): HTMLElement | null {
    const entries = [...node.querySelectorAll<HTMLElement>('.csl-entry')];
    if (entries.length < 2 || entries.some(entry => entry.parentElement !== entries[0].parentElement)) return null;
    const body = entries[0].parentElement!;
    const children = [...body.childNodes], first = children.indexOf(entries[0]), last = children.indexOf(entries.at(-1)!);
    const before = children.slice(0, first), after = children.slice(last + 1);
    const tail = node.cloneNode(true) as HTMLElement;
    const tailBody = tail.querySelector('.csl-entry')!.parentElement!;
    tail.querySelector('.md-bibliography h2')?.remove(); tail.querySelector('.md-bibliography')?.removeAttribute('id');
    tail.dataset.continuation = 'true'; tailBody.replaceChildren();
    let low = 1, high = entries.length - 1, best = 0;
    while (low <= high) {
      const middle = (low + high) >> 1; body.replaceChildren(...before, ...entries.slice(0, middle));
      if (fits(column)) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    if (!best) { body.replaceChildren(...children); return null; }
    body.replaceChildren(...before, ...entries.slice(0, best)); tailBody.replaceChildren(...entries.slice(best), ...after); return tail;
  }
  newPage();
  // The paper title spans both columns. Other headings stay with the article flow.
  if (pending[0]?.dataset.kind === 'h1') {
    const title = pending.shift()!; page!.querySelector('.paper-lead')!.append(title);
    if (title.offsetHeight > 250) { title.remove(); pending.unshift(title); }
  }
  let yieldedPage = 0;
  while (pending.length) {
    if (cancelled()) { staging.remove(); return 0; }
    if (pageNumber > yieldedPage + 4) { yieldedPage = pageNumber; await new Promise(resolve => setTimeout(resolve, 0)); }
    const node = pending.shift()!;
    let column = columns[columnIndex]; column.append(node);
    if (fits(column)) continue;
    const rest = splitTable(node, column) || splitBibliography(node, column) || splitText(node, column);
    if (rest) { pending.unshift(rest); nextColumn(); continue; }
    const previousHeading = node.previousElementSibling as HTMLElement | null;
    const needsSlices = node.offsetHeight > column.clientHeight || (previousHeading && /^h[1-6]$/.test(previousHeading.dataset.kind || '') && previousHeading.offsetHeight + node.offsetHeight > column.clientHeight);
    if (column.children.length > 1 && !needsSlices) {
      const height = node.offsetHeight; node.remove();
      const previous = column.lastElementChild as HTMLElement | null;
      if (previous && /^h[1-6]$/.test(previous.dataset.kind || '') && previous.offsetHeight + height < column.clientHeight) { previous.remove(); pending.unshift(previous, node); }
      else pending.unshift(node);
      nextColumn(); continue;
    }
    // Oversized figures/tables keep their original scale and continue on the next
    // column instead of being squeezed or losing the lower portion of the content.
    const height = node.offsetHeight;
    node.remove();
    let offset = 0;
    while (offset < height - .5) {
      column = columns[columnIndex];
      const slice = node.cloneNode(false) as HTMLElement;
      slice.dataset.continuation = offset ? 'true' : 'false'; slice.classList.add('paper-slice');
      const rect = column.getBoundingClientRect(), last = column.lastElementChild;
      const used = last ? (last.getBoundingClientRect().bottom - rect.top) / (rect.height / column.clientHeight) : 0;
      const amount = Math.min(height - offset, column.clientHeight - used);
      if (amount < 1) { if (used) { nextColumn(); continue; } throw new Error('The page has no room for article content.'); }
      slice.style.height = `${amount}px`;
      const content = node.cloneNode(true) as HTMLElement;
      content.className = 'paper-block paper-slice-content'; content.removeAttribute('data-source-from'); content.removeAttribute('data-source-to'); content.style.top = `${-offset}px`;
      slice.append(content); column.append(slice); offset += amount;
      if (offset < height - .5) nextColumn();
    }
    if (pending.length) nextColumn();
  }
  staging.remove();
  return pageNumber;
}

export const paperPageCss = `
.paper-pages{position:relative;width:210mm;margin:0 auto;color:#242629;font:var(--paper-font-size,10pt)/1.45 "Times New Roman","Noto Serif CJK SC",SimSun,serif;font-variant-numeric:lining-nums}
.paper-sheet{box-sizing:border-box;position:relative;width:210mm;height:297mm;margin:0 0 26px;background:#fff;color:#242629;box-shadow:0 2px 10px #0002;overflow:hidden;break-after:page}
.paper-body{position:absolute;inset:18mm 18mm 17mm;display:flex;flex-direction:column;min-height:0}
.paper-lead{flex:none}.paper-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:7mm;flex:1;min-height:0}
.paper-column{height:100%;min-width:0;overflow:hidden}.paper-block{display:flow-root;position:relative;overflow-wrap:anywhere;min-width:0}
.paper-block>p{margin:0 0 .8em;text-align:justify;hyphens:auto}.paper-block h1,.paper-block h2,.paper-block h3,.paper-block h4,.paper-block h5,.paper-block h6{font-family:Arial,"Microsoft YaHei",sans-serif;line-height:1.25;text-align:left;break-after:avoid}
.paper-block h1{font-size:23pt;margin:0 0 6mm;font-weight:700}.paper-block h2{font-size:12pt;margin:1em 0 .5em}.paper-block h3{font-size:10.5pt;margin:.8em 0 .4em}
.paper-block img{display:block;width:100%;max-width:100%;height:auto;max-height:none}.paper-block pre{font-size:.85em;white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%;padding:8px}
.paper-block table{width:100%;table-layout:fixed;font-size:.9em}.paper-block th,.paper-block td{overflow-wrap:anywhere;padding:4px 5px}.paper-block .md-equation-body{min-width:0;max-width:100%;overflow-x:auto}
.paper-block .math-block{font-size:.9em}.paper-block .md-bibliography{font-size:.9em;margin:0}.paper-block .md-bibliography h2{margin-top:.8em}
.paper-footer{position:absolute;bottom:8mm;left:18mm;right:18mm;text-align:right;font:9pt Arial,sans-serif;color:#666;border-top:1px solid #ddd;padding-top:2mm}
.paper-slice{overflow:hidden}.paper-slice-content{position:absolute;left:0;right:0;display:flow-root;overflow-wrap:anywhere}.paper-block[data-continuation=true]>p{margin-top:0}
@media print{.paper-pages{margin:0;width:210mm}.paper-sheet{box-shadow:none;margin:0;break-after:page}.paper-sheet:last-child{break-after:auto}@page{size:A4;margin:0}}
`;
