# Zotero Interoperability

Use the existing Zotero skill and its helper rather than implementing a second API client. Resolve its plugin root from the referenced `SKILL.md`; the standard helper is `scripts/zotero.py`.

## Read-first sequence

1. `python3 <plugin-root>/skills/zotero/scripts/zotero.py status --json`
2. If the user asked to operate Zotero and the local API preference is disabled, run `enable --restart`.
3. Search with `search <query> --json` and compare title, creators, year, venue, and DOI.
4. Use the returned Zotero item key, not the exported BibTeX key.

## Missing-item sequence

When the user explicitly requests adding a missing reference, search Crossref/PubMed or another appropriate scholarly source, verify the bibliographic fields, then prepare/import a BibTeX or RIS record with the Zotero helper. After import, search again to obtain the canonical Zotero item key before editing Markdown.

Never import an unverified or partial match. Do not retrieve attachments or full text unless separately requested.

## Reporting

State the Zotero item key used, whether an item was newly imported, the Markdown file changed, and the bibliography placeholder status. Distinguish blockers such as app missing, API disabled, no exact match, failed import, and missing canonical key.
