import mermaid from 'mermaid';
import DOMPurify from 'dompurify';

const cache = new Map<string, string>();
let queue = Promise.resolve(), serial = 0;
export async function renderDiagrams(root: ParentNode, measured: () => void = () => {}) {
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-diagram="mermaid"]:not([data-diagram-ready])'));
  await Promise.all(nodes.map(node => {
    node.dataset.diagramReady = 'pending';
    const source = node.querySelector('code')?.textContent || node.dataset.diagramSource || '';
    node.dataset.diagramSource = source;
    const theme = node.dataset.diagramTheme || 'default', key = theme + '\n' + source;
    const task = async () => {
      if (!node.isConnected) return;
      try {
        if (source.length > 100_000) throw new Error('Diagram source exceeds 100 KB.');
        if (/%%\s*\{|^\s*---|\b(?:click|href|img|icon)\b.*(?:https?:|javascript:|data:)/im.test(source)) throw new Error('Diagram configuration and external resources are not allowed.');
        let svg = cache.get(key);
        if (!svg) {
          mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: ['default','neutral','dark','forest'].includes(theme) ? theme as 'default' : 'default', htmlLabels: false, suppressErrorRendering: true, maxTextSize: 100_000, maxEdges: 1500, gantt: { useWidth: 640, fontSize: 14 } });
          const result = await mermaid.render(`markit-diagram-${++serial}`, source);
          svg = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['style'], FORBID_TAGS: ['foreignObject','script','image','a'], FORBID_ATTR: ['href','xlink:href','onload','onclick'] });
          // SVG style blocks must never fetch fonts, images or other network data.
          if (/@import|url\(\s*["']?\s*(?!#)[^)]/i.test(svg)) throw new Error('Diagram contains an external resource.');
          if (cache.size >= 120) cache.delete(cache.keys().next().value!);
          cache.set(key, svg);
        }
        if (node.isConnected) { node.innerHTML = svg; node.dataset.diagramReady = 'true'; measured(); }
      } catch (error) {
        const message = document.createElement('p'); message.className = 'md-diagram-error'; message.textContent = String(error); node.prepend(message); node.dataset.diagramReady = 'error'; measured();
      }
    };
    const next = queue.then(task); queue = next.catch(() => {}); return next;
  }));
}
(globalThis as typeof globalThis & { markitRenderDiagrams: typeof renderDiagrams }).markitRenderDiagrams = renderDiagrams;
