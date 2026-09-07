export interface ReferenceItem { key: string; csl: Record<string, unknown>; title: string; authors: string; year: string }
export interface ReferenceStatus { available: boolean; version?: string; message?: string }
export interface ReferenceResolution { items: ReferenceItem[]; missing: string[]; offline: boolean; warnings: string[] }
export interface ReferenceSearch { items: ReferenceItem[]; hasMore: boolean }
export interface CitationEntry { key: string; number: number; title: string; authors: string; year: string }
export interface CitationRenderData {
  clusters: Record<string, string>;
  bibliography: string;
  entries: CitationEntry[];
  missing: string[];
  warnings: string[];
  offline: boolean;
}
export interface ReferenceProvider {
  id: string;
  name: string;
  status(): Promise<ReferenceStatus>;
  search(query: string, signal?: AbortSignal): Promise<ReferenceSearch>;
  resolve(keys: string[], refresh?: boolean): Promise<ReferenceResolution>;
}
export interface ReferencesAPI {
  status(): Promise<ReferenceStatus>;
  search(query: string): Promise<ReferenceSearch>;
  cancelSearch(): Promise<void>;
  resolve(source: string, refresh?: boolean): Promise<CitationRenderData>;
}
export const emptyCitationData: CitationRenderData = { clusters: {}, bibliography: '', entries: [], missing: [], warnings: [], offline: false };
