# Google Speech-to-Text v2 fixtures

Two kinds, and the tests say which they use.

## RECORDED (T107, 2026-11-05, specs/021 plan G-3 / G-12)

Taken from the real service (Chirp 3, `eu`, BatchRecognize, output to Cloud Storage) for SYNTHETIC audio (macOS `say`,
two voices, Italian and English), then scrubbed: project id and number, bucket name, operation ids and object names
are replaced by placeholders, the input and output URIs by `{{INPUT_URI}}` / `{{OUTPUT_URI}}` (substituted by the test).
The three `output-recorded-*` word documents are the first 60 words of a real 5-minute file (a trimmed copy keeps the
real shape: ONE result for the whole file).

| File | What it records |
|---|---|
| `batch-submit.json` | the `batchRecognize` answer: an `Operation` named `projects/<NUMBER>/locations/eu/operations/v2-<uuid>` |
| `operation-running.json` | the first poll: no `done`, no `progressPercent` |
| `operation-done.json` | the finished operation: `response.results[<input uri>].cloudStorageResult.uri`, `totalBilledDuration` |
| `operation-done-file-error.json` | per-file `error` code 3: "Audio data does not appear to be in a supported encoding" (3 KB of noise) |
| `operation-done-file-not-found.json` | per-file `error` code 5: the input object is missing |
| `operation-done-file-too-long.json` | per-file `error` code 3: "Only audio files up to 20 minutes long are supported for BatchRecognize" (a 1 h file; billed 0 s) |
| `output-recorded-it.json` | output WITHOUT word offsets: one result, no `resultEndOffset`, words carry only `speakerLabel` (labels `0`/`1`) |
| `output-recorded-it-word-offsets.json` | output WITH offsets: `startOffset`/`endOffset` per word, a zero omitted (proto3), and a garbled first sentence |
| `output-recorded-en.json` | English: labels `1`/`2` (labels start at 0 or 1, depending on the file) |
| `output-recorded-silence.json` | 30 s of digital silence or a 20 s tone: ONE result whose transcript is a lone `[` (the model's `[BACKGROUND]`, cut short) |
| `output-recorded-garbled-offsets.json` | 30 consecutive words of a 19-minute part, with the recorded timing defects (a word at 9985 s, ends before starts) |

Each output document also carries a top-level `metadata.prompt` (Google's instruction text; no content of ours).

## RECORDED OVERLAP AND QUALITY FIXTURES (T124, 2026-11-05, specs/021 plan H-10)

From the real service (Chirp 3, `eu`, BatchRecognize) on SYNTHETIC audio (macOS `say`: it/en voices alternating as speakers, with pauses; sentences
generated from a small vocabulary, so the text is meaningless and carries no personal data). Spike runs: a 60-minute Italian file (2 voices, 8 parts of the
shipped 10-minute length, 90 s target overlap), a 30-minute English file (2 voices, 4 parts) and a 25-minute English file (3 voices, cut at 19 minutes).
Every document is the model's output for ONE part, CROPPED to the seam of interest: the words in provider order from a time to a time, offsets
rebased to the cropped part's start (`overlap-recorded-meta.json` holds each part's span in MEETING time, the locale and the silence list of the
cropped stretch). Scrubbing as above; one word per line. `metadata.prompt` is Google's text, as in the other recordings.

| Files | What they record |
|---|---|
| `overlap-it-part-1/2.json` | boundary 1|2 of the 60-minute file: 2 voices, 272 words said in both parts, both labels joined (clean) |
| `overlap-en-jitter-part-1/2.json` | boundary 1|2 of the 30-minute file: 274 aligned words, but the PROVIDER mislabelled about 10 % of part 1's words (63 and 83 words under the other voice's label), so (b)/(c) refuse the join. Parts 2-4 of the same file were labelled perfectly |
| `overlap-it-hole-part-1/2.json` | boundary 5|6 of the 60-minute file. Part 5 lost about 100 words (recall 91 %) and returned 347 words as an untimed tail (a stretch of its own end again, with no usable time); the detector finds ONE gap (35:52-38:36 of the file); J0 refuses both joins at this seam |
| `overlap-en3-part-1/2.json` | the 25-minute 3-voice file cut at 19 minutes: part 1 returned 1 046 of 3 019 words untimed and lost 6.7 % of the reference; its 20 s hole is NOT a gap (the untimed-word credit hides it, a known limit, plan H-3 R24); 3 voices were separated badly by the provider (purity 74 %) |
| `output-recorded-repeat-tail.json` | the last 3.4 minutes of part 7 of the 60-minute file: the model returned its last 2.5 minutes a second time as 345 untimed words (D1 removes them) |
| `overlap-recorded-meta.json` | per set: `parts` (meeting-time spans), `silences` (speech band, -35 dB, >= 0.5 s, the spike's own `silencedetect`), `locale`, `source` |

Cropping, to rebuild or add one: take the try's document, keep the words from the first timed word starting at or after `from` (a suffix, so an untimed
tail is kept) or up to the last timed word starting at or before `to` (a prefix), subtract `from - partStart` from every offset (a start that becomes 0 is
omitted, as the service omits it) and use `from` as the new part start.

## SYNTHETIC (hand-built from Google's REST reference, T97)

Kept ONLY for shapes the service was never seen to produce, so the adapter stays defensive about them. Do not read them
as evidence of what Google sends: no recording ever contained a `resultEndOffset`, a confidence or several results.

`operation-done-error.json` (an operation-level `error`), `output-two-speakers.json`, `output-speaker-change.json`,
`output-no-labels.json`, `output-with-word-offsets.json`, `output-empty.json`, `output-silence.json`.

Placeholders, substituted by the test: `{{INPUT_URI}}` (the part's `gs://` input URI) and `{{OUTPUT_URI}}` (the output
file's `gs://` URI).
