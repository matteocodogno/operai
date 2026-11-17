//! The engine's one entry point (task T7): a request, a letterhead version and its assets in; the document's
//! pages and its PDF out (AC-1.1, AC-1.2, AC-1.4, AC-3.3, AC-7.6).
//!
//! [`render`] compiles the request **once**. Everything it returns is read from that one laid-out document:
//! the page count, the placeholders that had no value, the count of characters the fonts lacked, the PDF
//! ([`Rendered::pdf`]) and the preview pages with their text ([`Rendered::preview`]). A caller that wants the
//! PDF does not rasterise, and a caller that wants a preview does not export a PDF.
//!
//! Pure like the rest of the engine: no clock, no file, no network. Dropping a [`Rendered`] drops the document;
//! the engine keeps nothing of it (AC-3.7). The memoisation cache of Typst (`comemo`) is process state outside
//! this crate: the worker evicts it after each job.

use typst_layout::PagedDocument;

use crate::config::LetterheadConfig;
use crate::content::RenderRequest;
use crate::layout::{self, Assets, LayoutError};
use crate::output::{self, PageSelection};

/// AC-3.3: a document of more pages than this is refused.
pub const MAX_PAGES: usize = 300;

/// What a caller may ask besides the request. Only the configurator's preview sets anything here; the render
/// routes use [`RenderOptions::default`], and a document made with it is the document of [`render`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RenderOptions {
    /// An empty placeholder is drawn as its label between `⟦` and `⟧` in the missing look, a conditional
    /// segment around it is kept, and the page's text holds the same marks (plan E3, AC-5.4). A document
    /// never carries `⟦ ⟧` unless this is set.
    pub mark_missing: bool,
}

/// A letterhead version as the engine needs it: its number, the layout it was saved with and its
/// configuration. The assets it uses come with the call.
#[derive(Debug, Clone, PartialEq)]
pub struct LetterheadVersion {
    pub number: i32,
    pub layout_version: u32,
    pub config: LetterheadConfig,
}

/// Why nothing was rendered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// The layout could not lay the document out: see [`LayoutError`].
    Layout(LayoutError),
    /// AC-3.3: more than [`MAX_PAGES`] pages. Nothing partial is returned.
    TooManyPages,
    /// A preview was asked for a page the document does not have.
    PageOutOfRange,
}

impl RenderError {
    /// The `code` of the RFC 7807 answer.
    pub fn code(&self) -> &'static str {
        match self {
            RenderError::Layout(error) => error.code(),
            RenderError::TooManyPages => "too_many_pages",
            RenderError::PageOutOfRange => "invalid_pages",
        }
    }
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for RenderError {}

impl From<LayoutError> for RenderError {
    fn from(error: LayoutError) -> RenderError {
        RenderError::Layout(error)
    }
}

/// One preview page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewPage {
    /// From 1.
    pub number: usize,
    /// A 64-colour paletted PNG, 893 x 1263 for A4 (AC-1.2).
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// The page's text in reading order.
    pub text: String,
}

/// A rendered document.
pub struct Rendered {
    document: PagedDocument,
    /// The number of the letterhead version the document was laid out with.
    pub letterhead_version: i32,
    pub layout_version: u32,
    pub page_count: usize,
    /// The placeholders that the drawn headers and footers used and that had no value, sorted (AC-6.4).
    pub missing_placeholders: Vec<&'static str>,
    /// How many characters of the document no font held, over every page (AC-7.6). Never which.
    pub unprintable_characters: usize,
    /// Made with [`RenderOptions::mark_missing`]: the pages' text then holds `⟦Label⟧` for each marked label
    /// (which the drawing does not: it holds the label only, see [`output::page_text_marking`]).
    marking: bool,
}

impl Rendered {
    fn text_of(&self, page: &typst_layout::Page) -> String {
        if self.marking {
            output::page_text_marking(page)
        } else {
            output::page_text(page)
        }
    }

    /// The PDF of the whole document (AC-1.1): the same bytes for the same request (AC-1.4).
    pub fn pdf(&self) -> Result<Vec<u8>, RenderError> {
        output::pdf(&self.document).ok_or_else(|| {
            RenderError::Layout(LayoutError::Internal {
                detail: "pdf export".to_owned(),
            })
        })
    }

    /// The preview pages asked for, each with its picture and its text (AC-1.2). A page past the end is
    /// [`RenderError::PageOutOfRange`].
    pub fn preview(&self, pages: &PageSelection) -> Result<Vec<PreviewPage>, RenderError> {
        let numbers = pages
            .resolve(self.page_count)
            .ok_or(RenderError::PageOutOfRange)?;
        numbers
            .into_iter()
            .map(|number| {
                let page = &self.document.pages()[number - 1];
                let image = output::preview_image(page).ok_or_else(|| {
                    RenderError::Layout(LayoutError::Internal {
                        detail: "png encoding".to_owned(),
                    })
                })?;
                Ok(PreviewPage {
                    number,
                    png: image.png,
                    width: image.width,
                    height: image.height,
                    text: self.text_of(page),
                })
            })
            .collect()
    }

    /// The text of every page, in reading order, without drawing anything.
    pub fn page_texts(&self) -> Vec<String> {
        self.document
            .pages()
            .iter()
            .map(|page| self.text_of(page))
            .collect()
    }

    /// The laid-out document, for the frame-level checks of the golden corpus.
    pub fn document(&self) -> &PagedDocument {
        &self.document
    }
}

/// Lay `request` out on `version` and keep the document. `assets` holds the stored bytes of every asset the
/// version's configuration uses, by id.
///
/// Refused before any output is made: a layout this binary lacks, a frame that does not fit its margin
/// (AC-5.3), an image the asset rules refuse (AC-2.3), more than [`MAX_PAGES`] pages (AC-3.3).
pub fn render(
    request: &RenderRequest,
    version: &LetterheadVersion,
    assets: &Assets,
) -> Result<Rendered, RenderError> {
    render_with(request, version, assets, RenderOptions::default())
}

/// [`render`] with `options`: the configurator preview's "mark missing" mode (plan E3).
pub fn render_with(
    request: &RenderRequest,
    version: &LetterheadVersion,
    assets: &Assets,
    options: RenderOptions,
) -> Result<Rendered, RenderError> {
    let layout = layout::layout(version.layout_version)
        .ok_or(LayoutError::UnknownLayout(version.layout_version))?;
    let compiled = layout::compile_in(
        layout,
        &version.config,
        assets,
        request,
        options.mark_missing,
    )?;
    let page_count = compiled.document.pages().len();
    if page_count > MAX_PAGES {
        return Err(RenderError::TooManyPages);
    }
    let unprintable_characters = compiled
        .document
        .pages()
        .iter()
        .map(layout::inspect::unprintable_characters)
        .sum();
    Ok(Rendered {
        document: compiled.document,
        letterhead_version: version.number,
        layout_version: version.layout_version,
        page_count,
        missing_placeholders: compiled.missing_placeholders,
        unprintable_characters,
        marking: options.mark_missing,
    })
}

// The tests live under output/ with the rest of this task's files.
#[cfg(test)]
#[path = "output/render_tests.rs"]
mod tests;

/// The configurator preview's "mark missing" option (plan E3, AC-5.3, AC-5.4), end to end: the options, the
/// preview's picture and text, the PDF, the count of unprintable characters.
#[cfg(test)]
mod mark_missing_tests {
    use super::*;
    use crate::config::{Frame, Line, LocalText, Rule, Valign, default_config};
    use crate::content::{Entity, EntityData, Language};
    use crate::layout::CURRENT_LAYOUT;
    use crate::sample;

    fn line(text: &str) -> Line {
        Line {
            text: LocalText {
                it: text.to_owned(),
                en: text.to_owned(),
            },
            size: 8.0,
            bold: false,
            color: "595c69".to_owned(),
        }
    }

    fn version() -> LetterheadVersion {
        let mut config = default_config();
        config.margins.bottom = 30.0;
        config.variants.default.footer = Frame {
            valign: Valign::Bottom,
            rule: Rule {
                show: false,
                thickness_pt: 0.5,
                color: "e50339".to_owned(),
            },
            left: vec![line("{legal_name}"), line("[IBAN {iban}]")],
            center: Vec::new(),
            right: vec![line("{page}/{pages}")],
        };
        config.variants.first = None;
        config.variants.last = None;
        LetterheadVersion {
            number: 3,
            layout_version: CURRENT_LAYOUT,
            config,
        }
    }

    fn no_iban() -> EntityData {
        EntityData {
            legal_name: Some("WellD Sagl".to_owned()),
            ..EntityData::default()
        }
    }

    fn rendered(options: RenderOptions) -> Rendered {
        let request = sample::request_with(Entity::WelldIt, Language::En, no_iban());
        render_with(&request, &version(), &Assets::new(), options).expect("renders")
    }

    fn footer_text(rendered: &Rendered) -> String {
        let text = rendered.page_texts().remove(0);
        text.lines().last().expect("a line").to_owned()
    }

    #[test]
    fn with_the_option_an_empty_iban_is_in_the_page_text_and_listed() {
        let marked = rendered(RenderOptions { mark_missing: true });
        let texts = marked.page_texts();
        // The text alternative has the marks, the drawing (checked in `layout::frame`) only the label: in
        // this mode alone the page's text differs from the drawn glyphs, on purpose (DR-4).
        assert!(
            texts[0].contains("IBAN \u{27E6}IBAN\u{27E7}"),
            "{}",
            texts[0]
        );
        assert_eq!(marked.missing_placeholders, ["iban"]);
        // The preview carries the same text (the page's text alternative, DR-4).
        let pages = marked.preview(&PageSelection::All).expect("a preview");
        assert_eq!(pages[0].text, texts[0]);
        assert!(!pages[0].png.is_empty());
        // No bracket is typeset, so nothing counts as unprintable.
        assert_eq!(marked.unprintable_characters, 0);
    }

    #[test]
    fn without_it_the_iban_prints_nothing_its_segment_goes_and_it_is_listed() {
        for options in [
            RenderOptions::default(),
            RenderOptions {
                mark_missing: false,
            },
        ] {
            let plain = rendered(options);
            for text in plain.page_texts() {
                assert!(
                    !text.contains('\u{27E6}') && !text.contains('\u{27E7}'),
                    "{text}"
                );
                assert!(!text.contains("IBAN"), "{text}");
            }
            assert_eq!(plain.missing_placeholders, ["iban"]);
            assert_eq!(plain.unprintable_characters, 0);
            assert!(footer_text(&plain).contains("WellD Sagl"));
        }
    }

    #[test]
    fn render_is_render_with_the_default_options_to_the_byte() {
        let request = sample::request(Entity::WelldCh, Language::It);
        let a = render(&request, &version(), &Assets::new()).unwrap();
        let b = render_with(
            &request,
            &version(),
            &Assets::new(),
            RenderOptions::default(),
        )
        .unwrap();
        assert_eq!(a.pdf().unwrap(), b.pdf().unwrap());
        assert_eq!(a.page_texts(), b.page_texts());
    }

    #[test]
    fn a_complete_entity_makes_the_same_pdf_with_the_option() {
        // Nothing is missing, so nothing is marked: the same text and the same positions.
        let request = sample::request(Entity::WelldIt, Language::It);
        let plain = render(&request, &version(), &Assets::new()).unwrap();
        let marked = render_with(
            &request,
            &version(),
            &Assets::new(),
            RenderOptions { mark_missing: true },
        )
        .unwrap();
        assert_eq!(plain.page_texts(), marked.page_texts());
        assert_eq!(plain.missing_placeholders, marked.missing_placeholders);
        assert_eq!(plain.unprintable_characters, marked.unprintable_characters);
    }

    #[test]
    fn the_unavailable_registry_marks_every_placeholder_in_both_languages() {
        let mut version = version();
        version.config.variants.default.footer.left =
            vec![line("{legal_name} {address} {vat} {iban} {contacts}")];
        for (language, labels) in [
            (Language::It, "\u{27E6}Ragione sociale\u{27E7}"),
            (Language::En, "\u{27E6}Legal name\u{27E7}"),
        ] {
            let request = sample::request_with(Entity::WelldIt, language, EntityData::default());
            let r = render_with(
                &request,
                &version,
                &Assets::new(),
                RenderOptions { mark_missing: true },
            )
            .unwrap();
            let text = r.page_texts().remove(0);
            assert!(text.contains(labels), "{text}");
            assert_eq!(
                r.missing_placeholders,
                ["address", "contacts", "iban", "legal_name", "vat"]
            );
        }
    }

    #[test]
    fn adjacent_and_broken_labels_are_marked_one_by_one_and_a_users_own_marks_are_not() {
        let mut version = version();
        version.config.variants.default.footer.left = vec![
            line("{iban}{contacts}{vat}"),
            line("{legal_name} \u{27E6}mine\u{27E7}"),
        ];
        let request = sample::request_with(
            Entity::WelldIt,
            Language::It,
            EntityData {
                legal_name: Some("WellD".to_owned()),
                ..EntityData::default()
            },
        );
        let r = render_with(
            &request,
            &version,
            &Assets::new(),
            RenderOptions { mark_missing: true },
        )
        .unwrap();
        let text = r.page_texts().remove(0);
        let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            flat.contains(
                "\u{27E6}IBAN\u{27E7} \u{27E6}Riga contatti\u{27E7} \u{27E6}Partita IVA\u{27E7}"
            ) || flat.contains(
                "\u{27E6}IBAN\u{27E7}\u{27E6}Riga contatti\u{27E7}\u{27E6}Partita IVA\u{27E7}"
            ),
            "{text}"
        );
        // A person's own marks are text like any other, and an unprintable character as before.
        assert!(text.contains("WellD \u{27E6}mine\u{27E7}"), "{text}");
        assert_eq!(r.unprintable_characters, 2 * r.page_count);
    }
}
