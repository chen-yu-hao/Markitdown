import CSL from 'citeproc';
import sanitizeHtml from 'sanitize-html';
import { scanCitations } from '../shared/citations';
import { citationStyles, citationLocale } from '../shared/citation-styles';
import type { ReferenceProvider, ReferenceResolution, CitationRenderData } from '../shared/academic-contracts';
import { emptyCitationData } from '../shared/academic-contracts';
import type { Settings } from '../shared/contracts';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const clean = (html: string) => sanitizeHtml(html, { allowedTags: ['div', 'span', 'i', 'b', 'em', 'strong', 'sup', 'sub'], allowedAttributes: { div: ['class'], span: ['class'] }, allowedClasses: { div: ['csl-entry', 'csl-left-margin', 'csl-right-inline'], span: ['nocase', 'nodecor'] }, disallowedTagsMode: 'discard' });

export function formatCitations(source: string, resolution: ReferenceResolution, settings: Pick<Settings, 'citationStyle'> & Partial<Settings>): CitationRenderData {
  const scanned = scanCitations(source, settings);
  if (!scanned.keys.length) return { ...emptyCitationData, warnings: [...resolution.warnings], offline: resolution.offline };
  const byKey = new Map(resolution.items.map(item => [item.key, item]));
  const missing = scanned.keys.filter(key => !byKey.has(key));
  const keys = scanned.keys.filter(key => byKey.has(key));
  const data: CitationRenderData = {
    clusters: {}, bibliography: '', entries: keys.map((key, index) => ({ key, number: index + 1, title: byKey.get(key)!.title, authors: byKey.get(key)!.authors, year: byKey.get(key)!.year })),
    missing, warnings: [...resolution.warnings], offline: resolution.offline,
  };
  if (!keys.length) return data;
  const engine = new CSL.Engine({ retrieveLocale: () => citationLocale, retrieveItem: key => ({ ...byKey.get(key)!.csl, id: key }) }, citationStyles[settings.citationStyle] || citationStyles.numeric, 'en-US');
  engine.updateItems(keys);
  for (const cluster of scanned.clusters) {
    if (Object.hasOwn(data.clusters, cluster.raw) || !cluster.keys.every(key => byKey.has(key))) continue;
    data.clusters[cluster.raw] = clean(engine.makeCitationCluster(cluster.keys.map(id => ({ id }))));
  }
  const bibliography = engine.makeBibliography();
  if (bibliography) data.bibliography = bibliography[1].map((entry, index) => {
    const key = bibliography[0].entry_ids[index][0];
    return `<div id="ref-${escape(key)}" class="csl-entry" data-reference-key="${escape(key)}">${clean(entry).replace(/^\s*<div class="csl-entry">([\s\S]*)<\/div>\s*$/, '$1')}</div>`;
  }).join('\n');
  return data;
}

export class CitationService {
  constructor(readonly provider: ReferenceProvider) {}
  async resolve(source: string, settings: Pick<Settings, 'citationStyle'> & Partial<Settings>, refresh = false): Promise<CitationRenderData> {
    if (typeof source !== 'string' || source.length > 20 * 1024 * 1024) throw new Error('Citation document exceeds 20 MiB.');
    const scan = scanCitations(source, settings);
    if (!scan.keys.length) return { ...emptyCitationData };
    if (scan.keys.length > 500) throw new Error('A document can resolve at most 500 distinct references.');
    return formatCitations(source, await this.provider.resolve(scan.keys, refresh), settings);
  }
}
