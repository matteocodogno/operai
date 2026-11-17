//! The outputs of one compile (task T7): the PDF, the preview pages as 64-colour paletted PNG, and the text of
//! each page.
//!
//! All three are made from the same laid-out document, so a preview and a PDF of one request cannot diverge
//! (AC-1.3, ADR 20261116-the-preview-is-the-pdfs-own-compile...).

mod pdf;
mod png;
mod quantize;
mod text;

pub use self::pdf::pdf;
pub use self::png::{PREVIEW_COLOURS, PREVIEW_PIXELS_PER_PT, PreviewImage, preview_image};
pub use self::text::{page_text, page_text_marking};

/// Which pages of a preview are wanted (AC-1.2): all by default, or the pages of `?pages=1,2,3`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum PageSelection {
    #[default]
    All,
    /// Page numbers, from 1, each once, ascending.
    Pages(Vec<usize>),
}

/// The largest page number a selection may name: the most pages a document can have (AC-3.3).
const LARGEST_PAGE_NUMBER: usize = crate::render::MAX_PAGES;

impl PageSelection {
    /// Read the value of the `pages` query parameter: page numbers from 1, separated by commas. Whitespace
    /// around a number is allowed. A number twice is the page once. A value that is not a list of page
    /// numbers, or names page 0 or a page past the limit, is `None`.
    pub fn parse(value: &str) -> Option<PageSelection> {
        let mut pages = Vec::new();
        for part in value.split(',') {
            let number: usize = part.trim().parse().ok()?;
            if number == 0 || number > LARGEST_PAGE_NUMBER {
                return None;
            }
            pages.push(number);
        }
        pages.sort_unstable();
        pages.dedup();
        Some(PageSelection::Pages(pages))
    }

    /// The pages of a document of `count` pages that this selects, or `None` if it names one past the end.
    pub fn resolve(&self, count: usize) -> Option<Vec<usize>> {
        match self {
            PageSelection::All => Some((1..=count).collect()),
            PageSelection::Pages(pages) if pages.iter().all(|&p| p >= 1 && p <= count) => {
                Some(pages.clone())
            }
            PageSelection::Pages(_) => None,
        }
    }
}
