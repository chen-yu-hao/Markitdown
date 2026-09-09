# Citation Workflow

## Markdown forms

Use a single citation as `[@D9PGQUM4]` and a cluster as `[@D9PGQUM4; @T4IQZGRM; @MRHTZ5CI]`. Keep the citation adjacent to the supported claim and do not convert it to a raw URL or BibTeX key.

Markedown's bibliography placeholder is the source of truth for the rendered reference list. If the document already contains the placeholder, retain its position. Otherwise append the placeholder after the final prose block, separated by a blank line.

## Style decisions

The application defaults to sequential numeric rendering. Apply author-date only when requested by the author, target journal, or document settings. Citation keys remain unchanged when switching display styles.

## Audit checklist

- Every citation key resolves to a Zotero item or is explicitly reported unresolved.
- A repeated key is reused rather than imported again.
- Clusters keep source order unless the requested style requires stable numeric ordering.
- `[@...]` text inside code, comments, math, and link definitions is not a citation.
- Bibliography text is generated from the resolved Zotero metadata, not manually duplicated in the manuscript.
