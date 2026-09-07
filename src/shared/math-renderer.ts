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
        const svg = adaptor.tags(tree, 'svg')[0];
        if (!svg) throw new Error('Formula could not be rendered');
        // All glyphs are paths; copied SVGs do not need a font or external resource.
        adaptor.setAttribute(svg, 'role', 'img');
        adaptor.setAttribute(svg, 'aria-label', source);
        html = adaptor.outerHTML(svg);
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

export function equationLayout(settings: Settings, numbered: boolean) {
  const alignment = settings.mathAlignment === 'center' || settings.mathAlignment === 'right' ? settings.mathAlignment : 'left';
  const numberPosition = settings.mathNumberPosition === 'left' ? 'left' : 'right';
  const leftNumber = numbered && numberPosition === 'left';
  return {
    alignment, numberPosition,
    block: `position:relative;display:grid;grid-template-columns:${numbered ? leftNumber ? 'fit-content(35%) minmax(0,1fr)' : 'minmax(0,1fr) fit-content(35%)' : 'minmax(0,1fr)'};gap:.4em 1em;align-items:center;min-width:0;max-width:100%;padding:.5em 0;white-space:normal;text-indent:0`,
    body: `display:flex;align-items:center;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;grid-row:1;grid-column:${leftNumber ? 2 : 1};padding:.15em 0`,
    content: `display:flow-root;flex:none;width:max-content;max-width:none;margin:0 ${alignment === 'right' ? 0 : 'auto'} 0 ${alignment === 'left' ? 0 : 'auto'}`,
    number: `grid-row:1;grid-column:${leftNumber ? 1 : 2};align-self:center;justify-self:${leftNumber ? 'start' : 'end'};min-width:0;max-width:12em;overflow-wrap:anywhere;white-space:normal;text-align:${numberPosition};font-variant-numeric:tabular-nums;line-height:1.4`,
  };
}

export const equationLayoutCss = `.math-block{position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:.4em 1em;align-items:center;min-width:0;max-width:100%;padding:.5em 0;text-indent:0;white-space:normal}.math-block.md-numbered{grid-template-columns:minmax(0,1fr) fit-content(35%)}.math-block.md-numbered[data-number-position=left]{grid-template-columns:fit-content(35%) minmax(0,1fr)}.math-block>[id]{position:absolute;top:0;left:0}.md-equation-body{display:flex;align-items:center;min-width:0;max-width:100%;overflow-x:auto;overflow-y:hidden;grid-row:1;grid-column:1;padding:.15em 0}.math-block.md-numbered[data-number-position=left]>.md-equation-body{grid-column:2}.md-equation-content{display:flow-root;flex:none;width:max-content;max-width:none;margin:0 auto 0 0}.math-block[data-math-align=center]>.md-equation-body>.md-equation-content{margin-left:auto;margin-right:auto}.math-block[data-math-align=right]>.md-equation-body>.md-equation-content{margin-left:auto;margin-right:0}.md-equation-content>.katex-display,.md-equation-content>.md-math-display{margin:0;overflow:visible}.md-equation-number{grid-row:1;grid-column:2;align-self:center;justify-self:end;min-width:0;max-width:12em;overflow-wrap:anywhere;white-space:normal;text-align:right;font-variant-numeric:tabular-nums;line-height:1.4}.math-block[data-number-position=left]>.md-equation-number{grid-column:1;justify-self:start;text-align:left}.math-block>.md-equation-diagnostic{grid-column:1/-1;grid-row:2}`;

export const mathCss = `.md-math{display:inline-block;max-width:100%;text-indent:0;white-space:normal}.md-math>svg{max-width:100%;overflow:visible}.md-math-display{display:block;text-align:center;margin:1em 0}${equationLayoutCss}.md-equation-inline{white-space:normal;text-indent:0}.md-equation-inline-number{font-size:.85em;font-variant-numeric:tabular-nums;white-space:nowrap}.md-equation-reference{font-variant-numeric:tabular-nums}.md-equation-unresolved,.md-equation-diagnostic{color:#b44;text-decoration:underline dotted}.md-equation-diagnostic{display:block;font:12px/1.5 "Segoe UI",sans-serif;text-align:left}.math-error{color:#b44}.md-line-break{font-size:.72em;opacity:.45;user-select:none;text-indent:0}`;
