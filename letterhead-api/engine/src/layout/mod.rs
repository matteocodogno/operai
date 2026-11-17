//! Layouts: what lays a document out (tasks T5 and T6; ADR 20261116-a-letterhead-version-pins-its-layout...).
//!
//! A layout is a template, the Typst version that runs it and the font files it uses. A letterhead version
//! records its layout number and is always rendered with that layout, so an upgrade of Typst or an edit of a
//! template can never move the lines of a version that exists (AC-4.5). Layout 1 is Typst 0.15.1,
//! `layouts/1/main.typ` and the 13 font files of [`fonts::LAYOUT_1_FONTS`]. A new layout is added beside it;
//! an existing one is never edited except to fix a defect, with the golden corpus updated in the same commit.
//!
//! The template is the only code that places anything on a page. Text reaches it as JSON strings in
//! `/data.json` and is placed there as `str` values, which Typst never parses as markup, so what a person typed
//! is data and never code (US-2). The template calls no `eval`, no `plugin` and no `read` of a path that a
//! caller chose.
//!
//! [`compile`] turns a letterhead configuration, its assets and a render request into a laid-out document.
//! [`check_fit`] is the save-time fit check of AC-5.2. Both are pure: every byte they read is in their
//! arguments or compiled in.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::OnceLock;

use serde_json::{Value, json};
use typst::Library;
use typst::diag::{Severity, SourceDiagnostic};
use typst::foundations::Bytes;
use typst::syntax::{FileId, Source};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst_layout::PagedDocument;

use crate::config::{
    LetterheadConfig, Problem, Reason as ConfigReason, Variant, bounds::FIT_TEST_VALUE_CHARS,
};
use crate::content::{EntityData, Language, RenderRequest};
use crate::resolve::{Resolution, ResolvedVariant, resolve, resolve_in};
use crate::world::{self, Access, LayoutWorld};

mod body;
mod clusters;
mod fonts;
mod frame;
pub mod inspect;
#[cfg(test)]
mod testing;

pub use fonts::{FontFile, LAYOUT_1_FONTS, typst_family};

/// The newest layout: the one a save records (ADR 20261116-a-letterhead-version-pins-its-layout...).
pub const CURRENT_LAYOUT: u32 = 1;

/// The stored bytes of the images a letterhead uses, by asset id. A letterhead version's assets are immutable
/// (AC-4.6) and were checked when they were uploaded ([`crate::assets::ingest`]).
pub type Assets = BTreeMap<String, Vec<u8>>;

/// The header and footer of a page are drawn inside the margin, hugging the body. They keep this far from the
/// page's edge and this far from the body: a frame is *fit* when its height, with the rule's thickness, is at
/// most the margin less these two (AC-5.2, AC-5.3). Constants of layout 1: the template holds the same two.
pub const FRAME_EDGE_MM: f64 = 5.0;
pub const FRAME_GAP_MM: f64 = 3.0;

/// Typst state shared by every render of a layout: parsed fonts, the library and the template source.
pub(crate) struct Shared {
    pub(crate) library: LazyHash<Library>,
    pub(crate) book: LazyHash<FontBook>,
    pub(crate) fonts: Vec<Font>,
    pub(crate) main: FileId,
    pub(crate) source: Source,
}

/// A layout: a template, the Typst version that runs it, and its fonts.
pub struct Layout {
    pub version: u32,
    /// The version of the `typst` crate this layout is linked with.
    pub typst: &'static str,
    template: &'static str,
    fonts: &'static [FontFile],
    shared: OnceLock<Shared>,
    /// The state of the preview's "mark missing" mode: the same template with the one function that draws a
    /// frame's line replaced (see [`MARKING_FROM`]). `None` when the template has no such line.
    marking: OnceLock<Option<Shared>>,
}

/// The line of a layout 1 frame's template that the preview's "mark missing" mode replaces (plan E3): it draws
/// a line's parts as one string in the line's look.
const MARKING_FROM: &str = "par(safe(s, zone-width, c => c))";
/// What replaces it: the parts are drawn each in its own look, and a part that stands for a missing value
/// (`"m": true`) in the missing look of the paper (`--paper-mark` and `--paper-mark-ink` of the design system),
/// so that it is words, glyphs and colour, never colour alone (DR-4). The text is the same text: a highlight
/// draws a box behind it and adds no glyph.
const MARKING_TO: &str = r#"par(safe-runs(l.parts.map(part => if "t" in part {
    (text: part.t, wrap: if part.at("m", default: false) { c => highlight(fill: hex("ffe58a"), top-edge: 0.8em, bottom-edge: -0.2em, text(fill: hex("3a2a00"), c)) } else { c => c })
  } else {
    (text: if part.pg == "page" { str(p) } else { str(n) }, wrap: c => c)
  }), zone-width))"#;

impl Layout {
    pub const fn new(
        version: u32,
        typst: &'static str,
        template: &'static str,
        fonts: &'static [FontFile],
    ) -> Layout {
        Layout {
            version,
            typst,
            template,
            fonts,
            shared: OnceLock::new(),
            marking: OnceLock::new(),
        }
    }

    pub fn fonts(&self) -> &'static [FontFile] {
        self.fonts
    }

    pub fn template(&self) -> &'static str {
        self.template
    }

    fn build(&self, template: String) -> Shared {
        let fonts: Vec<Font> = self
            .fonts
            .iter()
            .flat_map(|file| Font::iter(Bytes::new(file.bytes)))
            .collect();
        let main = world::main_id();
        Shared {
            library: world::library(),
            book: LazyHash::new(FontBook::from_fonts(&fonts)),
            fonts,
            main,
            source: Source::new(main, template),
        }
    }

    pub(crate) fn shared(&self) -> &Shared {
        self.shared
            .get_or_init(|| self.build(self.template.to_owned()))
    }

    /// The state of the "mark missing" mode, or `None` when this layout's template has no line to replace
    /// (a layout that does not know the mode refuses it, rather than draw a document without the look).
    fn marking(&self) -> Option<&Shared> {
        self.marking
            .get_or_init(|| {
                (self.template.matches(MARKING_FROM).count() == 1)
                    .then(|| self.build(self.template.replace(MARKING_FROM, MARKING_TO)))
            })
            .as_ref()
    }
}

static LAYOUT_1: Layout = Layout::new(
    1,
    "0.15.1",
    include_str!("../../layouts/1/main.typ"),
    &fonts::LAYOUT_1_FONTS,
);

/// The layout with this number, or `None` when this binary does not contain it: a version saved by a newer
/// binary, which must be refused and not rendered with another layout (ADR 20261116-a-letterhead-version...).
pub fn layout(version: u32) -> Option<&'static Layout> {
    match version {
        1 => Some(&LAYOUT_1),
        _ => None,
    }
}

/// The header or the footer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Header,
    Footer,
}

impl FrameKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FrameKind::Header => "header",
            FrameKind::Footer => "footer",
        }
    }
}

/// Why a document could not be laid out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutError {
    /// The layout number is not in this binary.
    UnknownLayout(u32),
    /// The configuration uses an asset that `assets` does not hold.
    MissingAsset(String),
    /// A text of the configuration does not parse: the configuration was not validated.
    InvalidConfig { path: String, reason: ConfigReason },
    /// A header or a footer is taller than its margin (AC-5.3): 422 `header_overflow` or `footer_overflow`.
    Overflow {
        variant: &'static str,
        frame: FrameKind,
    },
    /// An image of a block was refused by the asset rules (AC-2.3, AC-7.1 to AC-7.3). `path` is a JSON Pointer
    /// to the member of the request that holds the image's data.
    Image {
        path: String,
        reason: crate::assets::Reason,
    },
    /// A fault of the engine, not of the request. `detail` is for the developer and may quote template values:
    /// it is never logged or sent (AC-3.2, AC-3.6).
    Internal { detail: String },
}

impl LayoutError {
    /// The JSON Pointer into the configuration of a frame that does not fit.
    pub fn overflow_path(variant: &str, frame: FrameKind) -> String {
        format!("/variants/{variant}/{}", frame.as_str())
    }

    /// The `code` of the RFC 7807 answer, where the error has one of its own.
    pub fn code(&self) -> &'static str {
        match self {
            LayoutError::Overflow {
                frame: FrameKind::Header,
                ..
            } => "header_overflow",
            LayoutError::Overflow {
                frame: FrameKind::Footer,
                ..
            } => "footer_overflow",
            LayoutError::Image { .. } => "invalid_content",
            LayoutError::UnknownLayout(_) => "unknown_layout",
            LayoutError::MissingAsset(_) | LayoutError::InvalidConfig { .. } => {
                "invalid_letterhead"
            }
            LayoutError::Internal { .. } => "render_failed",
        }
    }
}

impl std::fmt::Display for LayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Only the kind: no detail, no text of a request.
        f.write_str(self.code())
    }
}

impl std::error::Error for LayoutError {}

/// A laid-out document.
pub struct Compiled {
    pub document: PagedDocument,
    /// The placeholders that the drawn headers and footers used and that had no value (AC-6.4), sorted.
    pub missing_placeholders: Vec<&'static str>,
    /// Every access to the World's files, in order (AC-2.2).
    pub accesses: Vec<Access>,
}

/// The variant a page uses (AC-5.4, AC-5.5): the first page uses `first` if there is one; the last page of a
/// document of more than one page uses `last` if there is one; every other page uses `default`.
pub fn variant_of_page(page: usize, pages: usize, has_first: bool, has_last: bool) -> &'static str {
    if page == 1 {
        if has_first { "first" } else { "default" }
    } else if page == pages && has_last {
        "last"
    } else {
        "default"
    }
}

fn variants_drawn(resolution: &Resolution, pages: usize) -> BTreeSet<&'static str> {
    (1..=pages.max(1))
        .map(|page| {
            variant_of_page(
                page,
                pages,
                resolution.first.is_some(),
                resolution.last.is_some(),
            )
        })
        .collect()
}

fn missing_of(resolution: &Resolution, pages: usize) -> Vec<&'static str> {
    let mut names = BTreeSet::new();
    for name in variants_drawn(resolution, pages) {
        let variant: Option<&ResolvedVariant> = match name {
            "first" => resolution.first.as_ref(),
            "last" => resolution.last.as_ref(),
            _ => Some(&resolution.default),
        };
        if let Some(variant) = variant {
            names.extend(variant.missing.iter().copied());
        }
    }
    names.into_iter().collect()
}

/// The files of the World that come from the letterhead: `(path, bytes)` per asset slot, and the path of each
/// asset by its id.
struct AssetFiles {
    files: Vec<(String, Vec<u8>)>,
    paths: HashMap<String, String>,
}

impl AssetFiles {
    fn of(config: &LetterheadConfig, assets: &Assets) -> Result<AssetFiles, LayoutError> {
        let mut files = Vec::new();
        let mut paths = HashMap::new();
        for (slot, id) in config.asset_ids().into_iter().enumerate() {
            let bytes = assets
                .get(id)
                .ok_or_else(|| LayoutError::MissingAsset(id.to_owned()))?;
            if slot >= world::MAX_ASSET_SLOTS {
                return Err(LayoutError::Internal {
                    detail: "more assets than slots".to_owned(),
                });
            }
            let path = world::asset_path(slot, world::sniff(bytes));
            files.push((path.clone(), bytes.clone()));
            paths.insert(id.to_owned(), path);
        }
        Ok(AssetFiles { files, paths })
    }

    fn path(&self, id: &str) -> Value {
        self.paths.get(id).map_or(Value::Null, |p| json!(p))
    }
}

/// What the template is told besides the blocks.
struct Setup<'a> {
    config: &'a LetterheadConfig,
    resolution: &'a Resolution,
    language: Language,
    assets: &'a AssetFiles,
}

/// The `/data.json` of a render; `only` and `fit` are the fit check's switches.
fn data(setup: &Setup<'_>, blocks: Value, only: Option<FrameKind>, fit: bool) -> Value {
    let config = setup.config;
    let variant_json = |variant: &Variant, resolved: &ResolvedVariant| {
        frame::variant(variant, resolved, setup.assets)
    };
    let variants = json!({
        "default": variant_json(&config.variants.default, &setup.resolution.default),
        "first": config.variants.first.as_ref().zip(setup.resolution.first.as_ref())
            .map(|(v, r)| variant_json(v, r)),
        "last": config.variants.last.as_ref().zip(setup.resolution.last.as_ref())
            .map(|(v, r)| variant_json(v, r)),
    });
    json!({
        "language": setup.language.as_str(),
        "margins": config.margins,
        "fonts": {
            "body": typst_family(config.fonts.body),
            "heading": typst_family(config.fonts.heading),
            "frame": typst_family(config.fonts.frame),
        },
        "look": body::look(&config.look),
        "variants": variants,
        "only": only.map(FrameKind::as_str),
        "fit": fit,
        "blocks": blocks,
    })
}

fn message_of(diagnostic: &SourceDiagnostic) -> String {
    diagnostic.message.to_string()
}

/// The overflow that a failed compile reports, if that is why it failed. The template panics with a message
/// of its own making: `LH_ERR:<header|footer>_overflow:<variant>`.
fn overflow_in(errors: &[SourceDiagnostic]) -> Option<LayoutError> {
    errors.iter().find_map(|e| {
        let message = message_of(e);
        let tag = message.split("LH_ERR:").nth(1)?;
        let tag = tag.trim_end_matches('"');
        let mut parts = tag.split(':');
        let frame = match parts.next()? {
            "header_overflow" => FrameKind::Header,
            "footer_overflow" => FrameKind::Footer,
            _ => return None,
        };
        let variant = match parts.next()? {
            "first" => "first",
            "last" => "last",
            _ => "default",
        };
        Some(LayoutError::Overflow { variant, frame })
    })
}

fn run(
    layout: &Layout,
    data: &Value,
    mut files: Vec<(String, Vec<u8>)>,
    mark_missing: bool,
) -> Result<(PagedDocument, Vec<Access>), LayoutError> {
    let shared = if mark_missing {
        layout.marking().ok_or_else(|| LayoutError::Internal {
            detail: "mark missing".to_owned(),
        })?
    } else {
        layout.shared()
    };
    files.push((
        world::DATA_PATH.to_owned(),
        serde_json::to_vec(data).map_err(|_| LayoutError::Internal {
            detail: "data.json".to_owned(),
        })?,
    ));
    let world = LayoutWorld::new(shared, files);
    let warned = typst::compile::<PagedDocument>(&world);
    match warned.output {
        Ok(document) => Ok((clusters::write_clusters_once(document), world.accesses())),
        Err(errors) => {
            if let Some(overflow) = overflow_in(&errors) {
                return Err(overflow);
            }
            let detail = errors
                .iter()
                .filter(|e| e.severity == Severity::Error)
                .map(message_of)
                .collect::<Vec<_>>()
                .join(" | ");
            Err(LayoutError::Internal { detail })
        }
    }
}

/// Lay out `request` on the letterhead `config` with `layout`.
///
/// `assets` must hold every asset the configuration uses. A header or footer that does not fit its margin on a
/// page that is drawn is [`LayoutError::Overflow`] (AC-5.3).
pub fn compile(
    layout: &Layout,
    config: &LetterheadConfig,
    assets: &Assets,
    request: &RenderRequest,
) -> Result<Compiled, LayoutError> {
    compile_in(layout, config, assets, request, false)
}

/// [`compile`] with the option that only the configurator's preview sets (plan E3, AC-5.4): with
/// `mark_missing`, a placeholder without a value is drawn as its label between `⟦` and `⟧` in the missing look
/// and a conditional segment around it is kept; the page's text holds the same marks. Without it this is
/// [`compile`], to the byte.
pub fn compile_in(
    layout: &Layout,
    config: &LetterheadConfig,
    assets: &Assets,
    request: &RenderRequest,
    mark_missing: bool,
) -> Result<Compiled, LayoutError> {
    let resolution = resolve_in(config, request.language, &request.entity_data, mark_missing)
        .map_err(|e| LayoutError::InvalidConfig {
            path: e.path,
            reason: e.reason,
        })?;
    let asset_files = AssetFiles::of(config, assets)?;
    let setup = Setup {
        config,
        resolution: &resolution,
        language: request.language,
        assets: &asset_files,
    };
    let mut files = asset_files.files.clone();
    let blocks = body::blocks(&request.blocks, &mut files)?;
    let data = data(&setup, blocks, None, false);
    let (document, accesses) = run(layout, &data, files, mark_missing)?;
    let missing_placeholders = missing_of(&resolution, document.pages().len());
    Ok(Compiled {
        document,
        missing_placeholders,
        accesses,
    })
}

/// The value that stands in for every placeholder in the save-time fit check (AC-5.2): 40 characters, made of
/// words so that it wraps where a name would.
pub const FIT_VALUE: &str = "Mmmmmmm Mmmmmmm Mmmmmmm Mmmmmmm Mmmmmmmm";

/// The save-time fit check (AC-5.2): every variant's header and footer, in each language, with every
/// placeholder replaced by a [`FIT_VALUE`], must fit its margin. The height measured is the real one: lines
/// that wrap, a rule's thickness, a logo's height. A problem is reported once per frame, as
/// `/variants/<name>/<header|footer>`.
pub fn check_fit(
    layout: &Layout,
    config: &LetterheadConfig,
    assets: &Assets,
) -> Result<Vec<Problem>, LayoutError> {
    debug_assert_eq!(FIT_VALUE.chars().count(), FIT_TEST_VALUE_CHARS);
    let asset_files = AssetFiles::of(config, assets)?;
    let entity = EntityData {
        legal_name: Some(FIT_VALUE.to_owned()),
        address_lines: Some(vec![FIT_VALUE.to_owned()]),
        vat: Some(FIT_VALUE.to_owned()),
        iban: Some(FIT_VALUE.to_owned()),
        contacts: Some(FIT_VALUE.to_owned()),
    };
    let mut problems: Vec<Problem> = Vec::new();
    for language in Language::ALL {
        let resolution =
            resolve(config, language, &entity).map_err(|e| LayoutError::InvalidConfig {
                path: e.path,
                reason: e.reason,
            })?;
        // One compile per variant and frame, each as the only variant of a one-page document: a failure
        // stops a compile at its first error, and every frame is to be told.
        let named = [
            (
                "default",
                Some(&config.variants.default),
                Some(&resolution.default),
            ),
            (
                "first",
                config.variants.first.as_ref(),
                resolution.first.as_ref(),
            ),
            (
                "last",
                config.variants.last.as_ref(),
                resolution.last.as_ref(),
            ),
        ];
        for (name, variant, resolved) in named {
            let (Some(variant), Some(resolved)) = (variant, resolved) else {
                continue;
            };
            for frame in [FrameKind::Header, FrameKind::Footer] {
                let alone = LetterheadConfig {
                    variants: crate::config::Variants {
                        default: variant.clone(),
                        first: None,
                        last: None,
                    },
                    ..config.clone()
                };
                let alone_resolution = Resolution {
                    default: resolved.clone(),
                    first: None,
                    last: None,
                };
                let setup = Setup {
                    config: &alone,
                    resolution: &alone_resolution,
                    language,
                    assets: &asset_files,
                };
                let data = data(&setup, json!([]), Some(frame), true);
                match run(layout, &data, asset_files.files.clone(), false) {
                    Ok(_) => {}
                    Err(LayoutError::Overflow { .. }) => {
                        let path = LayoutError::overflow_path(name, frame);
                        if !problems.iter().any(|p| p.path == path) {
                            problems.push(Problem {
                                path,
                                reason: match frame {
                                    FrameKind::Header => ConfigReason::HeaderOverflow,
                                    FrameKind::Footer => ConfigReason::FooterOverflow,
                                },
                                name: None,
                                language: None,
                            });
                        }
                    }
                    Err(other) => return Err(other),
                }
            }
        }
    }
    Ok(problems)
}

#[cfg(test)]
mod tests;
