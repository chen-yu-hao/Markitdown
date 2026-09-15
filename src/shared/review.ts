/** Review ranges use UTF-16 offsets in the normalized (LF, no BOM) Markdown source. */
export interface ReviewHunk {
  id: string;
  from: number;
  to: number;
  baseFrom: number;
  baseTo: number;
  inserted: string;
  deleted: string;
}

export interface ReviewState {
  enabled: boolean;
  revision: string;
  baselineSource: string;
  hunks: ReviewHunk[];
  baselineOrigin: 'saved' | 'git-head' | 'review';
  gitCommit?: string;
  /** Large, heavily changed spans are grouped rather than spending unbounded time diffing. */
  truncated?: boolean;
}

export const normalizeReviewSource = (source: string) => source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

// A synchronous SHA-256 keeps the renderer's revision identical to the main process
// without Node access. The length prefix prevents ambiguous baseline/current pairs.
const shaConstants = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (n: number, k: number) => (n >>> k) | (n << (32 - k));
function digest(value: string): string {
  const encoded = new TextEncoder().encode(value);
  const length = Math.ceil((encoded.length + 9) / 64) * 64;
  const bytes = new Uint8Array(length);
  bytes.set(encoded); bytes[encoded.length] = 0x80;
  const data = new DataView(bytes.buffer);
  data.setUint32(length - 8, Math.floor(encoded.length / 0x20000000));
  data.setUint32(length - 4, encoded.length << 3);
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = data.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15], y = words[i - 2];
      words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const first = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + shaConstants[i] + words[i]) | 0;
      const second = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + first) | 0; d = c; c = b; b = a; a = (first + second) | 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + round[i]) >>> 0;
  }
  return Array.from(hash, part => part.toString(16).padStart(8, '0')).join('');
}

export function reviewRevision(baseline: string, current: string): string {
  baseline = normalizeReviewSource(baseline); current = normalizeReviewSource(current);
  return digest(`${baseline.length}:${baseline}${current}`);
}

interface Segment { kind: 'same' | 'remove' | 'add'; text: string }
interface DiffBudget { operations: number; truncated: boolean }

/** Bounded Myers diff. A pathological replacement becomes a single review span. */
function sequenceDiff(before: string[], after: string[], budget: DiffBudget): Segment[] {
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const a = before.slice(prefix, before.length - suffix), b = after.slice(prefix, after.length - suffix);
  const parts: Segment[] = [];
  const append = (kind: Segment['kind'], text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last?.kind === kind) last.text += text; else parts.push({ kind, text });
  };
  append('same', before.slice(0, prefix).join(''));
  if (!a.length) append('add', b.join(''));
  else if (!b.length) append('remove', a.join(''));
  else {
    const trace: Map<number, number>[] = [];
    let frontier = new Map<number, number>([[1, 0]]), found = false;
    outer: for (let depth = 0; depth <= Math.min(a.length + b.length, 256); depth++) {
      trace.push(new Map(frontier));
      for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
        if (--budget.operations <= 0) break outer;
        let x = diagonal === -depth || (diagonal !== depth && (frontier.get(diagonal - 1) ?? -Infinity) < (frontier.get(diagonal + 1) ?? -Infinity))
          ? frontier.get(diagonal + 1) ?? 0 : (frontier.get(diagonal - 1) ?? 0) + 1;
        let y = x - diagonal;
        while (x < a.length && y < b.length && a[x] === b[y]) {
          if (--budget.operations <= 0) break outer;
          x++; y++;
        }
        frontier.set(diagonal, x);
        if (x >= a.length && y >= b.length) {
          const reversed: Segment[] = [];
          for (let d = depth; d >= 0; d--) {
            const previous = trace[d], k = x - y;
            const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -Infinity) < (previous.get(k + 1) ?? -Infinity)) ? k + 1 : k - 1;
            const previousX = previous.get(previousK) ?? 0, previousY = previousX - previousK;
            while (x > previousX && y > previousY) { reversed.push({ kind: 'same', text: a[x - 1] }); x--; y--; }
            if (d === 0) break;
            if (x === previousX) { reversed.push({ kind: 'add', text: b[y - 1] }); y--; }
            else { reversed.push({ kind: 'remove', text: a[x - 1] }); x--; }
          }
          for (const piece of reversed.reverse()) append(piece.kind, piece.text);
          found = true; break outer;
        }
      }
    }
    if (!found) { budget.truncated = true; append('remove', a.join('')); append('add', b.join('')); }
  }
  append('same', suffix ? before.slice(before.length - suffix).join('') : '');
  return parts;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const splitLines = (source: string) => source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const splitGraphemes = (source: string) => Array.from(graphemes.segment(source), entry => entry.segment);

export function diffReview(baseline: string, current: string): { hunks: ReviewHunk[]; truncated: boolean } {
  baseline = normalizeReviewSource(baseline); current = normalizeReviewSource(current);
  if (baseline === current) return { hunks: [], truncated: false };
  const budget: DiffBudget = { operations: 350_000, truncated: false };
  const lines = sequenceDiff(splitLines(baseline), splitLines(current), budget);
  const segments: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === 'same') { segments.push(lines[i]); continue; }
    let before = '', after = '';
    while (i < lines.length && lines[i].kind !== 'same') {
      if (lines[i].kind === 'remove') before += lines[i].text; else after += lines[i].text;
      i++;
    }
    i--;
    if (before.length + after.length <= 24_000 && budget.operations > 0) {
      segments.push(...sequenceDiff(splitGraphemes(before), splitGraphemes(after), budget));
    } else {
      budget.truncated = true;
      if (before) segments.push({ kind: 'remove', text: before });
      if (after) segments.push({ kind: 'add', text: after });
    }
  }
  const hunks: ReviewHunk[] = [];
  let baseOffset = 0, offset = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === 'same') { baseOffset += segment.text.length; offset += segment.text.length; continue; }
    const baseFrom = baseOffset, from = offset;
    let deleted = '', inserted = '';
    while (i < segments.length && segments[i].kind !== 'same') {
      const piece = segments[i];
      if (piece.kind === 'remove') { deleted += piece.text; baseOffset += piece.text.length; }
      else { inserted += piece.text; offset += piece.text.length; }
      i++;
    }
    i--;
    hunks.push({ id: `${baseFrom}:${baseOffset}:${from}:${offset}`, baseFrom, baseTo: baseOffset, from, to: offset, inserted, deleted });
  }
  return { hunks, truncated: budget.truncated };
}

/** Accepting updates the accepted baseline only; the user's current source stays intact. */
export function acceptReviewHunk(baseline: string, current: string, id: string): string | null {
  baseline = normalizeReviewSource(baseline); current = normalizeReviewSource(current);
  const hunk = diffReview(baseline, current).hunks.find(candidate => candidate.id === id);
  return hunk ? baseline.slice(0, hunk.baseFrom) + hunk.inserted + baseline.slice(hunk.baseTo) : null;
}

export function computeReviewState(baseline: string, current: string, options: Pick<ReviewState, 'enabled' | 'baselineOrigin' | 'gitCommit'>): ReviewState {
  baseline = normalizeReviewSource(baseline); current = normalizeReviewSource(current);
  const difference = options.enabled ? diffReview(baseline, current) : { hunks: [], truncated: false };
  return { ...options, baselineSource: baseline, revision: reviewRevision(baseline, current), ...difference };
}
