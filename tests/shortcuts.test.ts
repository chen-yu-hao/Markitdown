import { describe, expect, it } from 'vitest';
import { shortcutCommand } from '../src/shared/shortcuts';
import { analyzeMarkdown, renderMarkdown } from '../src/shared/markdown';

const key = (value: string, options = {}) => ({ key: value, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...options });
describe('configurable shortcut dispatch', () => {
  it('distinguishes modified commands and replaces a default binding', () => {
    expect(shortcutCommand({}, key('s', { ctrlKey: true }))).toBe('save');
    expect(shortcutCommand({}, key('S', { ctrlKey: true, shiftKey: true }))).toBe('saveAs');
    expect(shortcutCommand({ settings: 'Ctrl+Alt+P' }, key(',', { ctrlKey: true }))).toBeUndefined();
    expect(shortcutCommand({ settings: 'Ctrl+Alt+P' }, key('p', { ctrlKey: true, altKey: true }))).toBe('settings');
    expect(shortcutCommand({ settings: 'Ctrl+Alt+P' }, key('p', { ctrlKey: true }))).toBeUndefined();
    expect(shortcutCommand({}, key('+', { ctrlKey: true, shiftKey: true }))).toBe('zoomIn');
  });
  it('does not invoke commands from ordinary typing or extra modifiers', () => {
    expect(shortcutCommand({}, key('n'))).toBeUndefined();
    expect(shortcutCommand({}, key('n', { ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(shortcutCommand({}, key('F8', { shiftKey: true }))).toBeUndefined();
  });
});
it('outline and render agree on headings when Markdown syntax preferences change', () => {
  const source = '#Heading\n\n## Strict heading\n\n# H~2~O';
  expect(analyzeMarkdown(source).headings).toHaveLength(2);
  const settings = { strictMarkdown: false, subscript: true };
  const headings = analyzeMarkdown(source, settings).headings;
  expect(headings).toHaveLength(3);
  expect(headings[0].offset).toBe(0);
  const html = renderMarkdown(source, { settings });
  for (const heading of headings) expect(html).toContain(`id="${heading.id}"`);
});
