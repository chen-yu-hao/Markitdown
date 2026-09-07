import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/shared/markdown';

describe('Markdown render preferences', () => {
  it('toggles inline math, highlight, subscript and superscript independently', () => {
    const source = '$x^2$ ==mark== H~2~O x^2^ ~~delete~~';
    const enabled = renderMarkdown(source, { settings: { subscript: true, superscript: true } });
    expect(enabled).toContain('class="katex"');
    expect(enabled).toContain('<mark>mark</mark>');
    expect(enabled).toContain('H<sub>2</sub>O');
    expect(enabled).toContain('x<sup>2</sup>');
    expect(enabled).toContain('<s>delete</s>');
    const disabled = renderMarkdown(source, { settings: { inlineMath: false, highlight: false } });
    expect(disabled).not.toMatch(/katex|<mark>|<sup>|<sub>/);
    expect(disabled).toContain('$x^2$ ==mark== H~2~O x^2^');
    expect(renderMarkdown('$$\nx^2\n$$', { settings: { inlineMath: false } })).toContain('math-block');
  });
  it('does not interpret disabled extensions, escapes or extension syntax inside code', () => {
    const html = renderMarkdown('`~sub~ ^sup^ :smile:` \\~sub~ \\^sup^ <sup onclick="x">a</sup>', { settings: { subscript: true, superscript: true } });
    expect(html).toContain('<code>~sub~ ^sup^ :smile:</code>');
    expect(html).not.toMatch(/<(?:sub|sup)>/);
    expect(html).not.toMatch(/<sup onclick/);
  });
  it('keeps autolink settings local to each render and preserves explicit links', () => {
    expect(renderMarkdown('https://example.org')).toContain('<a href=');
    expect(renderMarkdown('https://example.org', { settings: { autoLinks: false } })).not.toContain('<a');
    expect(renderMarkdown('[site](https://example.org)', { settings: { autoLinks: false } })).toContain('<a');
    expect(renderMarkdown('https://example.org')).toContain('<a href=');
  });
  it('enforces CommonMark heading spacing only in strict mode', () => {
    expect(renderMarkdown('#Heading')).not.toContain('<h1');
    expect(renderMarkdown('#Heading', { settings: { strictMarkdown: false } })).toMatch(/<h1 id="heading"[^>]*>Heading<\/h1>/);
    expect(renderMarkdown('    #Heading', { settings: { strictMarkdown: false } })).not.toContain('<h1');
  });
  it('renders supported emoji names and GitHub alerts only when enabled', () => {
    expect(renderMarkdown(':smile:')).toContain('😄');
    expect(renderMarkdown(':smile:', { settings: { emojiAutocomplete: false } })).toContain(':smile:');
    const alert = '> [!WARNING]\n> Careful **here**';
    expect(renderMarkdown(alert)).toContain('markdown-alert-warning');
    expect(renderMarkdown(alert)).toContain('<strong>here</strong>');
    expect(renderMarkdown(alert, { settings: { githubAlerts: false } })).not.toContain('markdown-alert');
    expect(renderMarkdown('> \\[!WARNING]\n> literal')).not.toContain('markdown-alert');
  });
  it('renders typography without altering source, code, URLs or image destinations', () => {
    const source = '"hello" -- ... (c)\n\n`"hello" -- ... (c)`\n\n![image](assets/--.png)';
    const html = renderMarkdown(source, { settings: { smartPunctuation: 'render', smartQuotes: true, smartDashes: true, unicodePunctuation: true } });
    expect(html).toContain('“hello” – … ©');
    expect(html).toContain('<code>&quot;hello&quot; -- ... (c)</code>');
    expect(html).toContain('src="assets/--.png"');
    expect(renderMarkdown(source)).toContain('&quot;hello&quot; -- ... (c)');
    expect(renderMarkdown('"hello **world**" -- ...', { settings: { smartPunctuation: 'render', smartQuotes: true } })).toContain('“hello <strong>world</strong>” -- ...');
  });
  it('adds a separate code number gutter while retaining multiline highlighting and wrapping choices', () => {
    const html = renderMarkdown('```js\n/* one\n two */\nconst x = 1;\n```', { settings: { codeLineNumbers: true, codeWordWrap: false } });
    expect(html).toContain('md-code-nowrap md-code-numbered');
    expect(html).toContain('aria-hidden="true">1\n2\n3</span>');
    expect(html).toContain('<span class="hljs-comment">/* one\n two */</span>');
    expect(renderMarkdown('```js\nx\n```')).not.toContain('md-code-numbers');
  });
  it('explicitly reports the unavailable offline diagram engine while preserving safe source', () => {
    const source = '```mermaid\nflowchart LR\nA["<script>bad</script>"] --> B\n```';
    const html = renderMarkdown(source, { settings: { diagrams: true, language: 'en', diagramTheme: 'dark' } });
    expect(html).toContain('Mermaid rendering is unavailable');
    expect(html).toContain('data-diagram-theme="dark"');
    expect(html).not.toContain('<script>');
    expect(renderMarkdown(source, { settings: { diagrams: false } })).not.toContain('md-diagram-fallback');
  });
});
