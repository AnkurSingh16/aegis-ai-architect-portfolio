# Question writing instructions (for the question author)

Do not look at retrieval scores, model answers, the v4, v5 or v8 outputs, or the pipeline's prompts. Work from the corpus
manifest and the documents only.

## Answerable questions (at least 40 in the final holdout; at least 20 in calibration)

- **Paraphrase (at least 20 in the holdout):** ask a real person's question in your own words. Do not reuse a sentence from
  the document. Use synonyms and a different structure. Each must be answerable from one document.
- **Direct (the rest):** ask plainly, but not with the document's heading.
- For each: give the supporting document id, and at least one key point a complete answer must contain (the point, not a
  quote). Give two key points where the document has two.

## Unanswerable questions (at least 40 in the holdout; at least 20 in calibration)

- **Near-miss (at least 10):** same topic as a document, but the document does not answer it. Example pattern: the document
  covers approval, and the question asks about the approval amount when the document gives no amount.
- **Unavailable information (at least 8):** a reasonable question whose answer is in no document.
- **Restricted source (at least 8):** a question that could only be answered from a restricted document. The expected
  outcome is an abstention.
- **Unrelated (at least 8):** a question with no connection to the corpus.

## Rules for every question

- No question is a copy of another, or of a question in any earlier set. Check the set for duplicates before delivery.
- Write the questions as a person would ask them. Do not include the expected answer or the document id in the question.
- Keep questions between 8 and 40 words.
- Record author and date on every item.
- Do not write questions after seeing any model output. If a question is changed after the calibration run, it is removed
  from the holdout, not edited.
