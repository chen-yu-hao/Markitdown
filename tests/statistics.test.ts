import { describe, expect, it } from 'vitest';
import { analyzeMarkdown } from '../src/shared/markdown';

describe('statistics match original Markdown behavior', () => {
  it('counts CJK characters separately and keeps apostrophes within Latin words', () => {
    expect(analyzeMarkdown("中文测试 don't l’esprit 日本語").words).toBe(9);
  });
  it('counts visible text and image alt, excluding link destinations and raw HTML', () => {
    expect(analyzeMarkdown('**hello** [world](https://example.com/path) ![photo](image.png) <b>visible</b>\n\n<script>hidden words</script>').words).toBe(4);
  });
  it('counts code content but not the fenced language marker', () => {
    expect(analyzeMarkdown('```javascript\nconst hello = 42\n```').words).toBe(3);
  });
  it('uses grapheme counts, zero lines for empty text and 200 words per minute', () => {
    expect(analyzeMarkdown('e\u0301👩‍👩‍👧‍👦').characters).toBe(2);
    expect(analyzeMarkdown('').lines).toBe(0);
    expect(analyzeMarkdown('a\nb\n').lines).toBe(3);
    expect(analyzeMarkdown('word '.repeat(201)).readingMinutes).toBe(2);
  });
});
