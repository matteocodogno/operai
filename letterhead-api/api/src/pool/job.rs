//! What a job and its result look like on the wire, and what the pool's callers see of them (task T11).
//!
//! A job frame is `[header, asset 1, asset 2, ...]`: the header is JSON (the request, the letterhead version, what
//! to produce, and the ids of the assets that follow), the assets are raw bytes. A result frame is
//! `[reply, body...]`: the reply is JSON, the body is the PDF or one PNG per page, raw.
//!
//! The JSON of a request holds what the caller sent, so a parse error, which quotes the text, is never kept or
//! shown: every failure here is a bare [`DecodeError`].
//!
//! Shared by the supervisor and the worker, so it is held to the worker's rule (a test checks it).

use serde::{Deserialize, Serialize};

use letterhead_engine::config::LetterheadConfig;
use letterhead_engine::content::RenderRequest;
use letterhead_engine::layout::Assets;
use letterhead_engine::output::PageSelection;
use letterhead_engine::render::{LetterheadVersion, PreviewPage};

/// What a job asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// The PDF of the whole document (AC-1.1).
    Pdf,
    /// The preview pages asked for, each with its picture and its text (AC-1.2).
    Preview(PageSelection),
    /// The fit check of a configuration (AC-5.2): every header and footer in its margin with 40-character values.
    /// It has no document, so a [`Job::fit`] has no request; it is the same worker, deadline and memory cap (T48,
    /// security review F2: it decodes the person's uploaded images and compiles Typst, so it is not run on a
    /// supervisor thread).
    Fit,
}

/// One render: everything the worker needs, and nothing it does not (it has no database and no bucket).
pub struct Job {
    /// `None` for [`Output::Fit`].
    request: Option<RenderRequest>,
    version: LetterheadVersion,
    assets: Assets,
    output: Output,
    /// The configurator preview's "mark missing" mode (plan E3). Only a [`Output::Preview`] may carry it: see
    /// [`Job::marking_missing`].
    mark_missing: bool,
    #[cfg(any(test, feature = "test-slow"))]
    test: Option<TestLayout>,
}

impl Job {
    /// `assets` holds the bytes of the assets that `version.config` uses, by id; an asset it does not use is
    /// not sent. The bytes of an image block are in the request.
    pub fn new(
        request: RenderRequest,
        version: LetterheadVersion,
        assets: Assets,
        output: Output,
    ) -> Job {
        Job {
            request: Some(request),
            version,
            assets,
            output,
            mark_missing: false,
            #[cfg(any(test, feature = "test-slow"))]
            test: None,
        }
    }

    /// The preview is drawn in the "mark missing" mode (plan E3, AC-5.4): an empty placeholder shows its label in
    /// the missing look and in the page's text. Only the configurator's preview asks for it; a job made by
    /// [`Job::new`] never has it, which is what every `/v1/render/*` job is. A job of any output but a preview
    /// that has it is not encoded ([`Job::encode`] fails): a PDF never carries a mark.
    pub fn marking_missing(mut self) -> Job {
        self.mark_missing = true;
        self
    }

    /// The fit check of `config` on `layout_version`, with the bytes of the assets it uses. The answer is
    /// [`Body::Fit`]: the problems, empty when every frame fits.
    pub fn fit(layout_version: u32, config: LetterheadConfig, assets: Assets) -> Job {
        Job {
            request: None,
            version: LetterheadVersion {
                number: 0,
                layout_version,
                config,
            },
            assets,
            output: Output::Fit,
            mark_missing: false,
            #[cfg(any(test, feature = "test-slow"))]
            test: None,
        }
    }

    /// Runs a test layout in place of the render (see [`TestLayout`]).
    #[cfg(any(test, feature = "test-slow"))]
    pub fn with_test_layout(mut self, layout: TestLayout) -> Job {
        self.test = Some(layout);
        self
    }

    /// The frame's parts: the header, then the assets it names, in the order it names them.
    pub fn encode(&self) -> Result<(Vec<u8>, Vec<&[u8]>), DecodeError> {
        if self.mark_missing && !matches!(self.output, Output::Preview(_)) {
            return Err(DecodeError);
        }
        let mut ids: Vec<&str> = Vec::new();
        let mut bytes: Vec<&[u8]> = Vec::new();
        for id in self.version.config.asset_ids() {
            if ids.contains(&id) {
                continue;
            }
            if let Some(held) = self.assets.get(id) {
                ids.push(id);
                bytes.push(held);
            }
        }
        let header = HeaderOut {
            request: self.request.as_ref(),
            version: VersionOut {
                number: self.version.number,
                layout_version: self.version.layout_version,
                config: &self.version.config,
            },
            output: match &self.output {
                Output::Pdf => WireOutput::Pdf,
                Output::Fit => WireOutput::Fit,
                Output::Preview(PageSelection::All) => WireOutput::Preview { pages: None },
                Output::Preview(PageSelection::Pages(pages)) => WireOutput::Preview {
                    pages: Some(pages.clone()),
                },
            },
            asset_ids: ids,
            mark_missing: self.mark_missing,
            #[cfg(any(test, feature = "test-slow"))]
            test: self.test.as_ref(),
        };
        let header = serde_json::to_vec(&header).map_err(|_| DecodeError)?;
        Ok((header, bytes))
    }
}

/// A job frame that is not one: the supervisor and the worker are of one build, so this is a fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("worker message is malformed")
    }
}

impl std::error::Error for DecodeError {}

#[derive(Serialize)]
struct HeaderOut<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    request: Option<&'a RenderRequest>,
    version: VersionOut<'a>,
    output: WireOutput,
    asset_ids: Vec<&'a str>,
    /// Written only when set, so the header of every other job is what it was before the mode existed.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    mark_missing: bool,
    #[cfg(any(test, feature = "test-slow"))]
    #[serde(skip_serializing_if = "Option::is_none")]
    test: Option<&'a TestLayout>,
}

#[derive(Serialize)]
struct VersionOut<'a> {
    number: i32,
    layout_version: u32,
    config: &'a LetterheadConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HeaderIn {
    #[serde(default)]
    request: Option<RenderRequest>,
    version: VersionIn,
    output: WireOutput,
    asset_ids: Vec<String>,
    #[serde(default)]
    mark_missing: bool,
    #[cfg(any(test, feature = "test-slow"))]
    #[serde(default)]
    test: Option<TestLayout>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionIn {
    number: i32,
    layout_version: u32,
    config: LetterheadConfig,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum WireOutput {
    Pdf,
    Fit,
    Preview { pages: Option<Vec<usize>> },
}

/// A job as the worker reads it.
pub struct Decoded {
    /// `Some` for a PDF and a preview, `None` for a fit check.
    pub request: Option<RenderRequest>,
    pub version: LetterheadVersion,
    pub assets: Assets,
    pub output: Output,
    /// The preview's "mark missing" mode; only ever true for a [`Output::Preview`].
    pub mark_missing: bool,
    #[cfg(any(test, feature = "test-slow"))]
    pub test: Option<TestLayout>,
}

/// Read a job frame.
pub fn decode_job(mut parts: Vec<Vec<u8>>) -> Result<Decoded, DecodeError> {
    if parts.is_empty() {
        return Err(DecodeError);
    }
    let header = parts.remove(0);
    let header: HeaderIn = serde_json::from_slice(&header).map_err(|_| DecodeError)?;
    if parts.len() != header.asset_ids.len() {
        return Err(DecodeError);
    }
    let mut assets = Assets::new();
    for (id, bytes) in header.asset_ids.into_iter().zip(parts) {
        if assets.insert(id, bytes).is_some() {
            return Err(DecodeError);
        }
    }
    // A document needs its request, and a fit check has none: anything else is a fault.
    if matches!(header.output, WireOutput::Fit) != header.request.is_none() {
        return Err(DecodeError);
    }
    // The mark is for the configurator's preview alone: a PDF or a fit check that has it is a fault, never drawn.
    if header.mark_missing && !matches!(header.output, WireOutput::Preview { .. }) {
        return Err(DecodeError);
    }
    Ok(Decoded {
        request: header.request,
        version: LetterheadVersion {
            number: header.version.number,
            layout_version: header.version.layout_version,
            config: header.version.config,
        },
        assets,
        output: match header.output {
            WireOutput::Pdf => Output::Pdf,
            WireOutput::Fit => Output::Fit,
            WireOutput::Preview { pages: None } => Output::Preview(PageSelection::All),
            WireOutput::Preview { pages: Some(pages) } => {
                Output::Preview(PageSelection::Pages(pages))
            }
        },
        mark_missing: header.mark_missing,
        #[cfg(any(test, feature = "test-slow"))]
        test: header.test,
    })
}

/// What every rendered document reports about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Meta {
    pub letterhead_version: i32,
    pub layout_version: u32,
    pub page_count: usize,
    /// The placeholders that the drawn headers and footers used and that had no value, sorted (AC-6.4).
    pub missing_placeholders: Vec<String>,
    /// How many characters no font held (AC-7.6).
    pub unprintable_characters: usize,
}

/// What the document is: the PDF, or the pages of a preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    Pdf(Vec<u8>),
    Preview(Vec<PreviewPage>),
    /// The problems of a fit check, as the JSON of `invalid_letterhead.problems[]` (a `Problem` serialised by the
    /// worker): the supervisor only passes them on.
    Fit(Vec<serde_json::Value>),
}

impl Meta {
    /// What a job that is not a document reports.
    pub fn none() -> Meta {
        Meta {
            letterhead_version: 0,
            layout_version: 0,
            page_count: 0,
            missing_placeholders: Vec::new(),
            unprintable_characters: 0,
        }
    }
}

/// A finished render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutput {
    pub meta: Meta,
    pub body: Body,
}

/// The engine refused the job. Only the code and a JSON Pointer into the configuration or the request, and a
/// reason code, travel: never text of the request (AC-3.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    /// The `code` of the RFC 7807 answer (`header_overflow`, `too_many_pages`, `invalid_content`, ...).
    pub code: String,
    pub path: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageInfo {
    pub number: usize,
    pub width: u32,
    pub height: u32,
    pub text: String,
}

/// The first part of a result frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    /// Body: one part, the PDF.
    Pdf {
        meta: Meta,
    },
    /// Body: one PNG per page, in the order of `pages`.
    Preview {
        meta: Meta,
        pages: Vec<PageInfo>,
    },
    /// A fit check's problems (none when every frame fits). No body.
    Fit {
        problems: Vec<serde_json::Value>,
    },
    Refused(Refusal),
    /// The worker could not do the job and is not to be trusted with another (a panic, a job it could not read).
    Failed,
}

/// What the supervisor makes of a result frame.
#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    Done(JobOutput),
    Refused(Refusal),
    Failed,
}

/// Read a result frame.
pub fn decode_reply(mut parts: Vec<Vec<u8>>) -> Result<Answer, DecodeError> {
    if parts.is_empty() {
        return Err(DecodeError);
    }
    let head = parts.remove(0);
    let reply: Reply = serde_json::from_slice(&head).map_err(|_| DecodeError)?;
    match reply {
        Reply::Pdf { meta } => {
            let [pdf] = <[Vec<u8>; 1]>::try_from(parts).map_err(|_| DecodeError)?;
            Ok(Answer::Done(JobOutput {
                meta,
                body: Body::Pdf(pdf),
            }))
        }
        Reply::Preview { meta, pages } => {
            if pages.len() != parts.len() {
                return Err(DecodeError);
            }
            let pages = pages
                .into_iter()
                .zip(parts)
                .map(|(info, png)| PreviewPage {
                    number: info.number,
                    png,
                    width: info.width,
                    height: info.height,
                    text: info.text,
                })
                .collect();
            Ok(Answer::Done(JobOutput {
                meta,
                body: Body::Preview(pages),
            }))
        }
        Reply::Fit { problems } if parts.is_empty() => Ok(Answer::Done(JobOutput {
            meta: Meta::none(),
            body: Body::Fit(problems),
        })),
        Reply::Refused(refusal) if parts.is_empty() => Ok(Answer::Refused(refusal)),
        Reply::Failed if parts.is_empty() => Ok(Answer::Failed),
        Reply::Fit { .. } | Reply::Refused(_) | Reply::Failed => Err(DecodeError),
    }
}

/// A render that misbehaves on demand, for the tests of the deadline, the memory cap and admission. It exists in
/// the test binary of the pool and in a build with the `test-slow` feature; never in the image.
#[cfg(any(test, feature = "test-slow"))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestLayout {
    /// Spins for ever: only a kill ends it (spike F3).
    Loop,
    /// Takes this long to answer, then renders for real.
    Hold { millis: u64 },
    /// Allocates and touches this much memory, then waits: only the memory cap (or the deadline) ends it.
    Hog { mib: usize },
    /// Panics with a marker in its message.
    Panic,
    /// Answers with a JSON description of the worker's process: pid, number of environment variables, arguments.
    /// (As the body of a PDF reply.)
    Probe,
}
