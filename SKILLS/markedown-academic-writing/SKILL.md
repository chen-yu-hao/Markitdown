---
name: markedown-academic-writing
description: "Write and audit academic Markdown citations in Markedown, coordinating local Zotero lookup and verified scholarly-source imports before inserting [@ZOTERO_KEY] references."
---

# Markedown Academic Writing

Use this skill for academic manuscript citation insertion, reference audits, bibliography placement, and citation-style changes.

## Required workflow

1. Identify the claims or citation requests and preserve the author's wording and existing citation order.
2. Before inserting any key, use the Zotero skill at `C:\Users\DELL\.codex\plugins\cache\openai-api-curated\zotero\d416fd5a\skills\zotero\SKILL.md` to check the local library through `http://localhost:23119/api/`.
3. If an exact or clearly matching item exists, insert its Zotero item key as `[@KEY]`; combine multiple items as `[@KEY1; @KEY2]`.
4. If no matching item exists and the user asked to add the reference, search scholarly sources such as Crossref or PubMed, verify title, creators, year, venue, and DOI, import the confirmed record into Zotero, then use the newly returned Zotero item key in Markdown.
5. Do not import records for a read-only search or audit request. If Zotero is unavailable, metadata is ambiguous, or import/key retrieval fails, stop before changing the document and report the exact blocker.
6. Keep one bibliography placeholder at the document end. Reuse an existing Markedown bibliography marker instead of creating a duplicate; move it only when the user asks to reposition the bibliography.

## Citation rules

- Default to Markedown's numeric citation style (Nature-compatible). Follow an explicitly requested journal/style instead.
- Treat Zotero item keys as distinct from BibTeX keys, DOI strings, and local cache identifiers.
- Scan only prose. Ignore fenced/indented code, inline code, HTML comments, math spans, and Markdown link definitions when looking for `[@...]`.
- Preserve existing clusters and only change the smallest citation span needed. Never invent a key from a title or DOI.
- Report inserted keys, Zotero records added, bibliography marker location, and any unresolved citations.

Read [references/citation-workflow.md](references/citation-workflow.md) for formatting examples and [references/zotero-interop.md](references/zotero-interop.md) for the delegated Zotero command sequence.
