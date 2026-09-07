import { describe, expect, it } from 'vitest';
import { EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { insertBracket } from '@codemirror/autocomplete';
import { defaultSettings } from '../src/shared/contracts';
import { codeLanguage, defaultFenceLanguage, droppedMarkdownLink, formatCodeSelection, isCode, listContinuation, preferenceEnter, preferenceExtensions, preferenceShiftTab, preferenceTab } from '../src/renderer/editor-preferences';
import { headingText, smartText, smartTypedInput } from '../src/shared/markdown-preferences';
import type { EditorView } from '@codemirror/view';

describe('editor preference behavior', () => {
  const settings = { ...defaultSettings, indentWidth: 4 };
  const stateFor = (source: string, overrides = {}) => EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [markdown({ addKeymap: false, codeLanguages: codeLanguage }), preferenceExtensions({ ...settings, ...overrides })] });
  const command = (state: EditorState, action: (view: EditorView) => boolean) => {
    let result = state;
    action({ state, composing: false, dispatch(...specs: Array<Transaction | TransactionSpec>) { result = specs[0] instanceof Transaction ? specs[0].state : state.update(...specs as TransactionSpec[]).state; } } as unknown as EditorView);
    return result;
  };
  it('continues configured ordered, unordered and task lists without changing the previous line', () => {
    expect(listContinuation('  > 7. item', settings)).toBe('  > 8. ');
    expect(listContinuation('7. item', { ...settings, orderedMarker: 'one' })).toBe('1. ');
    expect(listContinuation('- [x] task', { ...settings, bulletMarker: '+' })).toBe('+ [ ] ');
    expect(command(stateFor('- item', { bulletMarker: '*' }), preferenceEnter).doc.toString()).toBe('- item\n* ');
    expect(command(stateFor('1. '), preferenceEnter).doc.toString()).toBe('');
  });
  it('aligns tabs to the configured stop or inserts a full indent', () => {
    expect(command(stateFor('ab'), preferenceTab).doc.toString()).toBe('ab  ');
    expect(command(stateFor('ab', { alignIndent: false }), preferenceTab).doc.toString()).toBe('ab    ');
  });
  it('detects fenced and inline code and honors code auto indent', () => {
    const source = '```js\n  if (ok) {';
    expect(isCode(stateFor(source), source.length)).toBe(true);
    expect(isCode(stateFor('`x`'), 2)).toBe(true);
    expect(command(stateFor(source), preferenceEnter).doc.toString()).toBe(source + '\n      ');
    expect(command(stateFor(source, { codeAutoIndent: false }), preferenceEnter).doc.toString()).toBe(source + '\n');
    expect(isCode(stateFor('plain'), 3)).toBe(false);
  });
  it('uses code indentation independently for Enter, Tab, selections and Shift+Tab', () => {
    const source = '```js\nif (ok) {';
    const code = { indentWidth: 2, codeIndentWidth: 6 };
    expect(command(stateFor(source, code), preferenceEnter).doc.toString()).toBe(source + '\n      ');
    expect(command(stateFor('plain', code), preferenceTab).doc.toString()).toBe('plain ');
    expect(command(stateFor('```js\nab', code), preferenceTab).doc.toString()).toBe('```js\nab    ');
    const selected = stateFor('before\n\n```js\nfirst\nsecond\n```\n\nafter', code).update({ selection: { anchor: 14, head: 26 } }).state;
    expect(command(selected, preferenceTab).doc.toString()).toBe('before\n\n```js\n      first\n      second\n```\n\nafter');
    expect(command(stateFor('```js\n      word', code), preferenceShiftTab).doc.toString()).toBe('```js\nword');
  });
  it('only supplies default fence languages for the selected insertion origin', () => {
    const typed = { ...settings, defaultCodeLanguage: 'typescript', codeLanguageTrigger: 'typed' as const };
    expect(defaultFenceLanguage(typed, 'typed')).toBe('typescript');
    expect(defaultFenceLanguage(typed, 'menu')).toBe('');
    expect(defaultFenceLanguage({ ...typed, codeLanguageTrigger: 'menu' }, 'menu')).toBe('typescript');
    expect(defaultFenceLanguage({ ...typed, codeLanguageTrigger: 'always' }, 'typed')).toBe('typescript');
    expect(defaultFenceLanguage({ ...typed, codeLanguageTrigger: 'never' }, 'menu')).toBe('');
    expect(defaultFenceLanguage({ ...typed, defaultCodeLanguage: 'js\nmalformed' }, 'typed')).toBe('');
    expect(command(stateFor('```', typed), preferenceEnter).doc.toString()).toBe('```typescript\n');
    expect(command(stateFor('```python', typed), preferenceEnter).doc.toString()).toBe('```python\n');
    expect(command(stateFor('```js\ncode\n```', typed), preferenceEnter).doc.toString()).toBe('```js\ncode\n```\n');
    expect(command(stateFor('```', { ...typed, codeLanguageTrigger: 'menu' }), preferenceEnter).doc.toString()).toBe('```\n');
  });
  it('formats selected code with syntax rules and preserves strings and unselected lines', () => {
    const source = 'Outside\n\n```js\nfunction test() {\nconsole.log("{");\nif (ok) {\nreturn 1;\n}\n}\n```\n\nAfter';
    const state = stateFor(source, { codeAutoIndentOnTab: true, codeIndentWidth: 4 }).update({ selection: { anchor: source.indexOf('console'), head: source.lastIndexOf('}\n```') + 1 } }).state;
    expect(command(state, preferenceShiftTab).doc.toString()).toBe('Outside\n\n```js\nfunction test() {\n    console.log("{");\n    if (ok) {\n        return 1;\n    }\n}\n```\n\nAfter');
    const css = '```css\na {\ncolor: red;\n}\n```';
    expect(command(stateFor(css, { codeAutoIndentOnTab: true }).update({ selection: { anchor: css.indexOf('color'), head: css.indexOf('color') + 5 } }).state, preferenceShiftTab).doc.toString()).toContain('    color: red;');
  });
  it('keeps automatic reindent distinct from ordinary unindent and does not run during composition', () => {
    const source = '```js\nfunction x() {\n    return 1;\n}\n```';
    const from = source.indexOf('    return');
    const state = stateFor(source, { codeAutoIndentOnTab: false }).update({ selection: { anchor: from, head: from + 13 } }).state;
    expect(command(state, preferenceShiftTab).doc.toString()).toContain('\nreturn 1;');
    const disabled = { state, composing: true, compositionStarted: true, dispatch: () => { throw new Error('Composition was changed'); } } as unknown as EditorView;
    expect(formatCodeSelection(disabled)).toBe(false);
    expect(preferenceShiftTab(disabled)).toBe(false);
    expect(preferenceEnter(disabled)).toBe(false);
    expect(preferenceTab(disabled)).toBe(false);
  });
  it('toggles native bracket pairing independently of Markdown pairing', () => {
    expect(insertBracket(stateFor(''), '(')?.state.doc.toString()).toBe('()');
    expect(insertBracket(stateFor('', { pairBrackets: false }), '(')).toBeNull();
    expect(insertBracket(stateFor('', { pairMarkdown: false }), '`')).toBeNull();
    expect(insertBracket(stateFor(''), '`')?.state.doc.toString()).toBe('``');
  });
  it('generates ATX and setext headings while removing prior heading syntax', () => {
    expect(headingText('## 中文标题', 1, 'setext')).toBe('中文标题\n====');
    expect(headingText('Title\n=====', 3, 'atx')).toBe('### Title');
    expect(headingText('Title', 3, 'setext')).toBe('### Title');
  });
  it('encodes Windows dropped paths and compares drive and directory aliases case insensitively', () => {
    expect(droppedMarkdownLink('C:\\Notes\\中文 文件.md', 'c:\\notes\\draft.md')).toBe('[中文 文件.md](<%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.md>)');
    expect(droppedMarkdownLink('C:/Other/a[1].md', 'C:/Notes/draft.md')).toBe('[a\\[1\\].md](<../Other/a%5B1%5D.md>)');
    expect(droppedMarkdownLink('D:/A B/test.md', null)).toBe('[test.md](<file:///D:/A%20B/test.md>)');
  });
});

describe('smart punctuation', () => {
  it('respects individual switches and quote styles', () => {
    expect(smartText('"hello" \'world\' can\'t -- --- ... (c)', { smartQuotes: true, doubleQuoteStyle: 'guillemet', singleQuoteStyle: 'singleGuillemet', smartDashes: true, unicodePunctuation: true })).toBe('«hello» ‹world› can’t – — … ©');
    expect(smartText('"hello" -- ...', {})).toBe('"hello" -- ...');
  });
  it('does not transform pastes, disabled modes, Markdown horizontal rules or list prefixes', () => {
    const settings = { ...defaultSettings, smartPunctuation: 'typing' as const, smartQuotes: true, smartDashes: true, unicodePunctuation: true };
    expect(smartTypedInput('', 'hello...', settings)).toBeNull();
    expect(smartTypedInput('hello..', '.', { ...settings, smartPunctuation: 'render' })).toBeNull();
    expect(smartTypedInput('--', '-', settings)).toBeNull();
    expect(smartTypedInput('hello-', '-', settings)).toEqual({ remove: 1, insert: '–' });
    expect(smartTypedInput('hello..', '.', settings)).toEqual({ remove: 2, insert: '…' });
    expect(smartTypedInput('can', "'", settings)).toEqual({ remove: 0, insert: '’' });
  });
});
