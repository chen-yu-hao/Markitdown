import katex from 'katex';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { SerializedMmlVisitor } from 'mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js';
import { STATE } from 'mathjax-full/js/core/MathItem.js';
import { SafeHandler } from 'mathjax-full/js/ui/safe/SafeHandler.js';
import { length2em } from 'mathjax-full/js/util/lengths.js';
import type { MmlNode } from 'mathjax-full/js/core/MmlTree/MmlNode.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js';
import type { Settings } from './contracts';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const adaptor = liteAdaptor();
SafeHandler(RegisterHTMLHandler(adaptor));
const visitor = new SerializedMmlVisitor();
// Explicit offline packages: document text cannot load extensions, URLs or HTML.
function makeEngine(physics: boolean) {
  const input = new TeX({ packages: ['base', 'ams', 'newcommand', ...(physics ? ['physics'] : [])], tags: 'none', maxBuffer: 20_000, maxMacros: 1000 });
  input.postFilters.add(() => {
    input.parseOptions.root.walkTree(treeNode => {
      const node = treeNode as MmlNode;
      if (!node.attributes) return;
      const attributes = node.attributes.getAllAttributes();
      for (const [name, value] of Object.entries(attributes)) {
        if (/^(?:href|style|id|class|on\w+)$/i.test(name)) delete attributes[name];
        else if (/^(?:mathcolor|mathbackground|color|background)$/i.test(name) && !/^(?:#[a-f\d]{3,8}|[a-z]+)$/i.test(String(value))) delete attributes[name];
        else if (/^(?:mathsize|width|height|depth|lspace|rspace|voffset|minsize|maxsize|linethickness|rowspacing|columnspacing)$/.test(name)) {
          attributes[name] = String(value).split(/\s+/).map(part => {
            const length = length2em(part);
            return Number.isFinite(length) && Math.abs(length) <= 20 ? part : `${Math.sign(length) * 20 || 0}em`;
          }).join(' ');
        }
      }
    });
  }, -5.25);
  return mathjax.document('', { InputJax: input, OutputJax: new SVG({ fontCache: 'none' }), safeOptions: { allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' } } });
}
const cache = new Map<string, string>();
let cacheCharacters = 0;
const maxCacheCharacters = 4 * 1024 * 1024;

export function renderMath(source: string, display: boolean, settings: Settings, output: 'normal' | 'svg' | 'mathml' = 'normal'): string {
  const key = JSON.stringify([source, display, settings.mathPhysics, output]);
  const cached = cache.get(key);
  if (cached) return cached;
  let html: string;
  try {
    if (source.length > 20_000) throw new Error('Formula exceeds 20,000 characters');
    if (output === 'normal' && !settings.mathPhysics) {
      html = katex.renderToString(source, { displayMode: display, throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml', maxExpand: 1000, maxSize: 20 });
    } else {
      // TeX user macros mutate package maps; each formula gets an isolated input jax.
      const engine = makeEngine(settings.mathPhysics);
      if (output === 'mathml') {
        const tree = engine.convert(source, { display, end: STATE.CONVERT });
        html = visitor.visitTree(tree);
      } else {
        const tree = engine.convert(source, { display });
        const container = adaptor.outerHTML(tree);
        const svg = container.match(/<svg\b[\s\S]*<\/svg>/)?.[0];
        if (!svg) throw new Error('Formula could not be rendered');
        // All glyphs are paths; copied SVGs do not need a font or external resource.
        html = svg.replace('<svg ', `<svg role="img" aria-label="${escape(source)}" `);
      }
      html = `<span class="md-math${display ? ' md-math-display' : ''}" data-latex="${escape(source)}">${html}</span>`;
    }
    if (html.length > 1024 * 1024) throw new Error('Rendered formula exceeds the size limit');
  } catch (error) {
    html = `<span class="math-error" title="${escape(error instanceof Error ? error.message : String(error))}">${escape(source)}</span>`;
  }
  while (cache.size && (cache.size >= 256 || cacheCharacters + key.length + html.length > maxCacheCharacters)) {
    const oldest = cache.keys().next().value!;
    cacheCharacters -= oldest.length + cache.get(oldest)!.length;
    cache.delete(oldest);
  }
  cache.set(key, html);
  cacheCharacters += key.length + html.length;
  return html;
}

export const mathCss = `.md-math{display:inline-block;max-width:100%;text-indent:0;white-space:normal}.md-math>svg{max-width:100%;overflow:visible}.md-math-display{display:block;text-align:center;margin:1em 0}.math-block{position:relative;text-indent:0;white-space:normal}.math-block.md-numbered{padding-right:3.5em}.md-equation-number{position:absolute;right:.5em;top:50%;transform:translateY(-50%);font-variant-numeric:tabular-nums}.md-equation-inline{white-space:normal;text-indent:0}.md-equation-inline-number{font-size:.85em;font-variant-numeric:tabular-nums;white-space:nowrap}.md-equation-reference{font-variant-numeric:tabular-nums}.md-equation-unresolved,.md-equation-diagnostic{color:#b44;text-decoration:underline dotted}.md-equation-diagnostic{display:block;font:12px/1.5 "Segoe UI",sans-serif;text-align:left}.math-error{color:#b44}.md-line-break{font-size:.72em;opacity:.45;user-select:none;text-indent:0}`;
