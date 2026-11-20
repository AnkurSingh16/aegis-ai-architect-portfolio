# Corpus brief (for the corpus author)

Write a new synthetic document corpus. Do not copy, adapt or paraphrase the existing North or South documents.

- **Subject:** an invented software company's internal support guidance for one fictional product. Topics should overlap, so
  retrieval is genuinely hard: several documents about access, billing, incidents and data handling, written so that similar
  words appear in documents that answer different questions.
- **Size:** 12 to 20 documents, each 80 to 250 words, in plain English, one topic per document.
- **Style:** the documents read like real procedures: some have steps, some have rules, some have exceptions, some state what
  is out of scope. Include at least three documents that deliberately leave out a common point.
- **Restricted material:** include at least two documents marked restricted (for example, an internal security procedure).
  The route must not use restricted material to answer public questions. The question author needs to know which are
  restricted, so the manifest says so.
- **Identifiers:** use the prefix `IND-` for every document id, for example `IND-ACCESS-01`. Do not use `SYNTHETIC-NORTH-` or
  `SYNTHETIC-SOUTH-`.
- **Forbidden:** no real company, person, product, address, phone number or credential. No text from the pipeline's
  documents or prompts.

Deliver a manifest with: corpus version (e.g. `ind-corpus-v1`), one line per document (id, title, restricted yes or no,
word count), the author's name or handle, and the date. Lock the corpus with a SHA-256 of its files before any question is
written.
