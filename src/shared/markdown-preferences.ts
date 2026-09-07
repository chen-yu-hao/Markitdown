import type { Settings } from './contracts';

export const emojiNames: Record<string, string> = {
  smile: '😄', smiling_face: '☺️', grinning: '😀', joy: '😂', heart: '❤️', heart_eyes: '😍',
  thumbsup: '👍', thumbsdown: '👎', '+1': '👍', '-1': '👎', clap: '👏', pray: '🙏',
  tada: '🎉', sparkles: '✨', fire: '🔥', rocket: '🚀', star: '⭐', warning: '⚠️',
  check: '✅', white_check_mark: '✅', x: '❌', question: '❓', bulb: '💡', memo: '📝',
  book: '📖', books: '📚', link: '🔗', computer: '💻', bug: '🐛', eyes: '👀',
  thinking: '🤔', sob: '😭', laugh: '😆', wink: '😉', coffee: '☕', wave: '👋',
};

export function smartText(text: string, settings: Partial<Settings>): string {
  if (settings.smartQuotes) {
    const double = settings.doubleQuoteStyle === 'guillemet' ? ['«', '»'] : ['“', '”'];
    const single = settings.singleQuoteStyle === 'singleGuillemet' ? ['‹', '›'] : ['‘', '’'];
    text = text.replace(/"([^"\n]+)"/g, (_all, content: string) => double[0] + content + double[1])
      .replace(/(^|[\s([{])'([^'\n]+)'/g, (_all, prefix: string, content: string) => prefix + single[0] + content + single[1])
      .replace(/([\p{L}\p{N}])'(?=[\p{L}\p{N}])/gu, '$1’');
  }
  if (settings.smartDashes) text = text.replace(/---/g, '—').replace(/--/g, '–');
  if (settings.unicodePunctuation) text = text.replace(/\.\.\./g, '…').replace(/\(c\)/gi, '©').replace(/\(r\)/gi, '®').replace(/\(tm\)/gi, '™').replace(/\+\/-/g, '±');
  return text;
}

/** A single normal typing event only; callers must exclude composition and code. */
export function smartTypedInput(before: string, input: string, settings: Partial<Settings>): { remove: number; insert: string } | null {
  if (settings.smartPunctuation !== 'typing' || input.length !== 1) return null;
  if (settings.smartQuotes && (input === '"' || input === "'")) {
    const opening = !before || /[\s([{—–]$/.test(before);
    const quotes = input === '"'
      ? (settings.doubleQuoteStyle === 'guillemet' ? ['«', '»'] : ['“', '”'])
      : (settings.singleQuoteStyle === 'singleGuillemet' ? ['‹', '›'] : ['‘', '’']);
    return { remove: 0, insert: input === "'" && /[\p{L}\p{N}]$/u.test(before) ? '’' : quotes[opening ? 0 : 1] };
  }
  if (settings.smartDashes && input === '-' && /[-–]$/.test(before) && !/^\s*[-–]+$/.test(before)) return { remove: 1, insert: before.endsWith('–') ? '—' : '–' };
  if (settings.unicodePunctuation) {
    const tail = before.slice(-5) + input;
    for (const [pattern, replacement] of [[/\.\.\.$/, '…'], [/\(c\)$/i, '©'], [/\(r\)$/i, '®'], [/\(tm\)$/i, '™']] as const) {
      const match = tail.match(pattern);
      if (match) return { remove: match[0].length - 1, insert: replacement };
    }
  }
  return null;
}

export function headingText(text: string, level: number, style: Settings['headingStyle']): string {
  const clean = text.replace(/^#{1,6}\s*/, '').replace(/\n[=-]+\s*$/, '');
  return style === 'setext' && level <= 2 ? `${clean}\n${(level === 1 ? '=' : '-').repeat(Math.max(3, Math.min(60, [...clean].length)))}` : `${'#'.repeat(level)} ${clean}`;
}
