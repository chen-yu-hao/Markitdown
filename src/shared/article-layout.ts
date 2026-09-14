/** Section-sized column flows keep long papers readable from top to bottom. */
export function articleColumns(html: string): string {
  // The renderer produces balanced HTML. Track nesting so a heading inside a
  // quotation/list never separates its parent element across column flows.
  const sections: string[] = [];
  let depth = 0, start = 0;
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const match of html.matchAll(/<!--[\s\S]*?-->|<\/?([a-z][a-z\d]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase(), closing = match[0].startsWith('</');
    if (!closing && depth === 0 && /^h[12]$/.test(tag) && match.index > start) {
      sections.push(html.slice(start, match.index)); start = match.index;
    }
    if (closing) depth = Math.max(0, depth - 1);
    else if (!voidTags.has(tag) && !match[0].endsWith('/>')) depth++;
  }
  sections.push(html.slice(start));
  return sections.filter(section => section.trim()).map(section => `<section class="article-section">${section}</section>`).join('\n');
}

export const articleColumnCss = `
.article-columns{max-width:none;font-family:"Times New Roman","Noto Serif CJK SC","SimSun",serif;line-height:1.55;font-variant-numeric:lining-nums}
.article-columns .article-section{column-count:2;column-gap:2.2em;column-fill:balance;min-width:0}
.article-columns .article-section>h1,.article-columns .article-section>h2{column-span:all;font-family:"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.3;text-align:left}
.article-columns .article-section>h1{font-size:2em;margin:.2em 0 .7em;font-weight:700}
.article-columns .article-section>h2{font-size:1.3em;margin:1.2em 0 .6em;font-weight:650}
.article-columns p{orphans:3;widows:3;text-align:justify;hyphens:auto;margin:0 0 .8em}
.article-columns h3,.article-columns h4,.article-columns h5,.article-columns h6{break-after:avoid;font-family:"Segoe UI","Microsoft YaHei",sans-serif}
.article-columns img{width:100%;max-width:100%;height:auto;max-height:none}
.article-columns pre,.article-columns .math-block,.article-columns .csl-entry{break-inside:avoid;max-width:100%}
.article-columns pre{white-space:pre-wrap;overflow-wrap:anywhere}
.article-columns table{width:100%;table-layout:fixed;font-size:.9em}
.article-columns th,.article-columns td{overflow-wrap:anywhere;padding:5px 7px}
.article-columns .md-equation-body{min-width:0;max-width:100%}
@media print{.article-columns{font-size:10pt;line-height:1.45}.article-columns .article-section{column-gap:7mm}.article-columns img{max-height:none}}
`;
