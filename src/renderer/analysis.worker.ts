import { analyzeMarkdown } from '../shared/markdown';
import type { Settings } from '../shared/contracts';
self.onmessage = (event: MessageEvent<{ id: number; source: string; settings?: Settings }>) => {
  try { self.postMessage({ id: event.data.id, result: analyzeMarkdown(event.data.source, event.data.settings) }); }
  catch { self.postMessage({ id: event.data.id, result: { headings: [], words: 0, characters: 0, lines: 0, readingMinutes: 0 } }); }
};
