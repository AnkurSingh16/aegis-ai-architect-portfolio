# C4 answer-quality gaps: which tool addresses each problem

Recorded after the owner's review of the v8 answers (`docs/DEV-C4-ANSWER-QUALITY-V8-PROTOCOL.md`). It assigns each gap to the
method that can actually measure it. It changes no evaluation result and adds no rule to make a v8 case pass.

The owner's review found: four answers substantively acceptable, one incomplete (MFA factor check), two failing because they
repeated the question. The automatic score of 7/12 is not a human-validated count.

| Gap | Can a deterministic check detect it? | Status | Right tool |
| --- | --- | --- | --- |
| Question echo (two v8 answers) | Partly. A question-only answer, or a sentence made only of question words, can be detected. Paraphrased statements cannot | v2 built (`question-echo-v2.ts`), development only | Deterministic check (v2) with its own labelled evaluation |
| Incomplete answer (MFA factor check, which omitted the device-clock check and the no-codes instruction) | No. Completeness needs the list of key points for each question, which the pipeline does not have | Not built | Evaluation criterion: each labelled question carries its key points; a human reviewer scores completeness. A prompt change is only a candidate after that exists |
| Source copying (several near-verbatim answers) | Yes, as a measure. The longest verbatim run against the cited source is deterministic | Built as a report-only measure (`source-copying.ts`) | Report only. Copying the source is not wrong in itself; a prompt change to paraphrase would be a candidate, evaluated like any other |
| Unsupported or false claims | No | Not built | Human review against the source, as in the independent kit. Never inferred from "not an echo" |
| Well-formatted but not useful answers | No | Not built | Human review on responsiveness and completeness, reported separately from source correctness |

## Why not a rule for each gap

- Adding a rule that rejects near-verbatim answers would reject accurate answers. The owner asked for fewer, trustworthy
  answers, not for a formatting test.
- Adding a rule that requires completeness would need the key points, which do not exist yet for the existing sets. Writing
  them from the same author's view would not be independent.
- A prompt change (for example, asking for paraphrase or for the device-clock point) is a behavioural change. The owner has
  asked that such changes be tested as candidates, not wired in. No candidate prompt is run here.

## What is still required

1. Independent key points and labels for each question, supplied by the independent author (see the kit).
2. Human adjudication of responsiveness, completeness, support, echo, copying, and citation problems, reported separately.
3. A candidate prompt, if the owner wants one, with its own pre-registered protocol and a live run only after separate authorisation.
