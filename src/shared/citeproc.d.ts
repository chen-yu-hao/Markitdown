declare module 'citeproc' {
  interface CitationEngine {
    updateItems(ids: string[]): void;
    makeCitationCluster(items: Array<{ id: string }>): string;
    makeBibliography(): [{ entry_ids: string[][]; bibstart: string; bibend: string }, string[]] | false;
  }
  const CSL: { Engine: new (system: { retrieveLocale(language: string): string; retrieveItem(id: string): Record<string, unknown> }, style: string, language?: string) => CitationEngine };
  export default CSL;
}
