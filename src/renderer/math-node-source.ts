/** Retain a formula's original delimiters, whitespace and external label. */
export function mathNodeParts(source: string): { prefix: string; tex: string; suffix: string } | null {
  const opening = /^(\s*)(\${1,2}|\\\[|\\\(|`{3,}math[^\n]*\n|~{3,}math[^\n]*\n)/.exec(source);
  if (!opening) return null;
  const delimiter = opening[2];
  const closer = delimiter === '\\[' ? '\\]' : delimiter === '\\(' ? '\\)' : /^[`~]/.test(delimiter) ? delimiter.match(/^[`~]+/)![0] : delimiter;
  const end = source.lastIndexOf(closer);
  if (end < opening[0].length) return null;
  const body = source.slice(opening[0].length, end);
  const leading = /^\s*/.exec(body)![0].length, trailing = /\s*$/.exec(body)![0].length;
  const from = opening[0].length + leading, to = Math.max(from, end - trailing);
  return { prefix: source.slice(0, from), tex: source.slice(from, to), suffix: source.slice(to) };
}
