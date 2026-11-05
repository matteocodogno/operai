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

## SYNTHETIC (hand-built from Google's REST reference, T97)

Kept ONLY for shapes the service was never seen to produce, so the adapter stays defensive about them. Do not read them
as evidence of what Google sends: no recording ever contained a `resultEndOffset`, a confidence or several results.

`operation-done-error.json` (an operation-level `error`), `output-two-speakers.json`, `output-speaker-change.json`,
`output-no-labels.json`, `output-with-word-offsets.json`, `output-empty.json`, `output-silence.json`.

`overlap-part-1.json` and `overlap-part-2.json` (T116): two consecutive OVERLAPPING parts (0-50 s and 30-80 s of one
synthetic recording, a word every 0.5 s, in the recorded shape: one result per part, string offsets relative to the part,
the first `startOffset` omitted, labels from 0 in part 1 and swapped in part 2). The 20 s overlap carries 20 matched words
for each of two speakers. T124 replaces them with recorded ones.

Placeholders, substituted by the test: `{{INPUT_URI}}` (the part's `gs://` input URI) and `{{OUTPUT_URI}}` (the output
file's `gs://` URI).
