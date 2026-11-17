//! Content model v1 and its validation (task T2; AC-1.5, 1.7, 1.8, 2.3, 3.3, 3.6, 4.9, 9.2).
//!
//! [`model`] holds the typed request, [`validate_request`] and [`parse_request`] the only ways to get one.

mod ingest;
mod model;
mod validate;

pub use ingest::ingest_images;
pub use model::{
    Align, Block, CONTENT_VERSION, CONTENT_VERSION_2, CellBlock, Entity, EntityData, Heading,
    Image, Language, List, ListItem, Paragraph, RenderRequest, Run, SUPPORTED_CONTENT_VERSIONS,
    Style, Table,
};
pub use validate::{
    Limit, LimitName, MAX_BLOCKS, MAX_PROBLEMS, MAX_TEXT_CHARS, Problem, Reason, Rejection,
    parse_request, validate_request,
};

#[cfg(test)]
mod tests;
