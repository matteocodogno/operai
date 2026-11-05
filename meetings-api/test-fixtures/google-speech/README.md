# Google Speech-to-Text v2 fixtures

HAND-BUILT from Google's REST reference (T97, specs/021, plan G-12): the shape of an `Operation`, a
`BatchRecognizeResponse` and the `BatchRecognizeResults` file Speech writes to Cloud Storage. They are
SYNTHETIC: no real audio, no real project. The spike (T107) replaces them with scrubbed recordings of
real responses.

Placeholders, substituted by the test: `{{INPUT_URI}}` (the part's `gs://` input URI) and `{{OUTPUT_URI}}`
(the output file's `gs://` URI).
