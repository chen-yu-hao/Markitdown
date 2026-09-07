import { describe, expect, it } from 'vitest';
import { getSafeLinkURL, renderMarkdown } from '../src/shared/markdown';

describe('editor link destinations', () => {
  it('uses Markdown destination escaping and the renderer URL normalization', () => {
    const source = String.raw`<https://例子.测试/a b\(c\)?x=1&amp;y=2>`;
    const destination = getSafeLinkURL(source);
    expect(destination).toBe('https://xn--fsqu00a.xn--0zwm56d/a%20b(c)?x=1&y=2');
    expect(renderMarkdown(`[site](${source})`)).toContain(`href="${destination!.replace(/&/g, '&amp;')}"`);
    expect(getSafeLinkURL(String.raw`https://example.com/a\(b\)`)).toBe('https://example.com/a(b)');
  });

  it('preserves complete explicit mailto queries and trailing URL punctuation', () => {
    expect(getSafeLinkURL('mailto:name+tag@example.com?subject=Hello&amp;body=Draft')).toBe('mailto:name+tag@example.com?subject=Hello&body=Draft');
    expect(getSafeLinkURL('https://example.com/page.')).toBe('https://example.com/page.');
    expect(getSafeLinkURL('HTTPS://example.com/path')).toBe('HTTPS://example.com/path');
  });

  it('matches CommonMark angle autolinks without unescaping their literal contents', () => {
    for (const [source, expected] of [
      ['https://example.com/a&amp;b', 'https://example.com/a&amp;b'],
      [String.raw`https://example.com/a\(b\)`, 'https://example.com/a%5C(b%5C)'],
      ['https://example.com/path.', 'https://example.com/path.'],
      ['mailto:a@example.com?subject=Hi&amp;body=Text', 'mailto:a@example.com?subject=Hi&amp;body=Text'],
      ['a@localhost', 'mailto:a@localhost'],
      ['a+b@example.com', 'mailto:a+b@example.com'],
    ]) {
      const destination = getSafeLinkURL(source, 'autolink');
      expect(destination).toBe(expected);
      expect(renderMarkdown(`<${source}>`, { settings: { autoLinks: false } })).toContain(`href="${destination!.replace(/&/g, '&amp;')}"`);
    }
  });

  it('requires exactly one permitted CommonMark angle autolink', () => {
    for (const source of ['www.example.com', 'https://example.com/a b', 'https://example.com> text', '<https://example.com>', 'javascript:alert(1)', 'file:///C:/secret.txt', '//example.com', 'a b@example.com', 'https://example.com\n']) expect(getSafeLinkURL(source, 'autolink')).toBeUndefined();
  });

  it('recognizes complete bare web and email links through the existing linkify rules', () => {
    for (const [source, destination] of [
      ['https://example.com/a?x=1', 'https://example.com/a?x=1'],
      ['name+tag@example.com', 'mailto:name+tag@example.com'],
      ['https://例子.测试/路径', 'https://xn--fsqu00a.xn--0zwm56d/%E8%B7%AF%E5%BE%84'],
    ]) {
      expect(getSafeLinkURL(source, true)).toBe(destination);
      expect(renderMarkdown(source)).toContain(`href="${destination}"`);
    }
    for (const source of ['www.example.com/a', 'example.com']) {
      expect(getSafeLinkURL(source, true)).toBeUndefined();
      expect(renderMarkdown(source)).not.toContain('<a ');
    }
  });

  it('requires a whole bare-link match instead of opening a substring', () => {
    for (const source of ['See https://example.com', 'https://example.com after', 'https://example.com.', '(https://example.com)', 'a@example.com b@example.com', ' https://example.com', 'https://example.com\n']) {
      expect(getSafeLinkURL(source, true)).toBeUndefined();
    }
  });

  it('does not reinterpret relative Markdown destinations as automatic links', () => {
    for (const source of ['www.example.com/a', 'example.com', 'name@example.com', 'notes.md', '#heading', '//example.com']) expect(getSafeLinkURL(source)).toBeUndefined();
  });

  it('rejects blocked schemes, malformed addresses and control characters', () => {
    for (const automatic of [false, true]) {
      for (const source of ['javascript:alert(1)', 'javascript:https://example.com', 'data:text/html,test', 'file:///C:/secret.txt', 'ftp://example.com', '//example.com', 'https://', 'https://?query', 'https://example.com\u0000', 'mailto:user@example.com\u007f']) {
        expect(getSafeLinkURL(source, automatic)).toBeUndefined();
      }
    }
    expect(getSafeLinkURL('javascript&#58;alert(1)')).toBeUndefined();
    expect(getSafeLinkURL('<https://example.com/&#10;path>')).toBeUndefined();
    expect(getSafeLinkURL('https://example.com/a b')).toBeUndefined();
  });

  it('keeps automatic-link settings independent of destination parsing', () => {
    const source = 'https://example.com name@example.com';
    expect(renderMarkdown(source, { settings: { autoLinks: false } })).not.toContain('<a ');
    expect(getSafeLinkURL('https://example.com', true)).toBe('https://example.com');
    expect(renderMarkdown('[site](https://example.com)', { settings: { autoLinks: false } })).toContain('href="https://example.com"');
    expect(renderMarkdown(source, { settings: { autoLinks: false } })).not.toContain('<a ');
    expect(renderMarkdown(source)).toContain('href="mailto:name@example.com"');
  });
});
