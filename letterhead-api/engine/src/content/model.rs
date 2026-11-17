//! The render request, content version 1 (plan § API contracts).
//!
//! These types are the validated form of a request: a value of [`RenderRequest`] has passed
//! [`super::validate_request`], so the layout code can trust its shape. They derive `Serialize` and
//! `Deserialize` only so that the supervisor can hand a validated request to a worker process and get it
//! back unchanged; a request from a caller is never deserialised into them directly, because serde's own
//! error messages quote the offending text (AC-3.6). The way in is [`super::validate_request`].
//!
//! Nothing here names a caller's domain (AC-9.2): the member names are those of a document, not of a deal,
//! an offer, an expense request or an estimate.

use serde::{Deserialize, Serialize};

/// Content version 1: the original shape, and the value the engine's own sample request carries.
pub const CONTENT_VERSION: u32 = 1;

/// Content version 2 (specs/20261117-legal-entities, AC-5.2): "the issuer's details are the service's". The
/// body is version 1's plus an optional `legalEntityVersion` pin. The engine does not branch on the version
/// when it lays a document out (the supervisor fills the issuer's details from the registry for both), so
/// the engine's interface and its golden pages are unchanged.
pub const CONTENT_VERSION_2: u32 = 2;

/// The content versions this service accepts; any other is `unsupported_content_version`.
pub const SUPPORTED_CONTENT_VERSIONS: [u32; 2] = [CONTENT_VERSION, CONTENT_VERSION_2];

/// A legal entity that has a letterhead (AC-4.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Entity {
    #[serde(rename = "welld_it")]
    WelldIt,
    #[serde(rename = "welld_ch")]
    WelldCh,
}

impl Entity {
    pub const ALL: [Entity; 2] = [Entity::WelldIt, Entity::WelldCh];

    pub fn as_str(self) -> &'static str {
        match self {
            Entity::WelldIt => "welld_it",
            Entity::WelldCh => "welld_ch",
        }
    }

    pub fn parse(name: &str) -> Option<Entity> {
        Entity::ALL.into_iter().find(|e| e.as_str() == name)
    }
}

/// The language of a document (AC-5.8): it selects which header and footer texts are printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Language {
    #[serde(rename = "it")]
    It,
    #[serde(rename = "en")]
    En,
}

impl Language {
    pub const ALL: [Language; 2] = [Language::It, Language::En];

    pub fn as_str(self) -> &'static str {
        match self {
            Language::It => "it",
            Language::En => "en",
        }
    }

    pub fn parse(name: &str) -> Option<Language> {
        Language::ALL.into_iter().find(|l| l.as_str() == name)
    }
}

/// The closed set of named styles (AC-1.7). They are defined by the layout, on top of the letterhead's look
/// (AC-5.9). `Missing` is the highlighted style of an unanswered field (AC-10.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Style {
    Plain,
    Muted,
    Small,
    Right,
    Center,
    Title,
    Missing,
}

impl Style {
    pub const ALL: [Style; 7] = [
        Style::Plain,
        Style::Muted,
        Style::Small,
        Style::Right,
        Style::Center,
        Style::Title,
        Style::Missing,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Style::Plain => "plain",
            Style::Muted => "muted",
            Style::Small => "small",
            Style::Right => "right",
            Style::Center => "center",
            Style::Title => "title",
            Style::Missing => "missing",
        }
    }

    pub fn parse(name: &str) -> Option<Style> {
        Style::ALL.into_iter().find(|s| s.as_str() == name)
    }
}

/// Horizontal alignment of one table column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    pub const ALL: [Align; 3] = [Align::Left, Align::Center, Align::Right];

    pub fn as_str(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
        }
    }

    pub fn parse(name: &str) -> Option<Align> {
        Align::ALL.into_iter().find(|a| a.as_str() == name)
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// The values of the header and footer placeholders (AC-6.3). Every member is optional: a request without
/// any is valid, and a missing or blank value prints nothing (AC-6.4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legal_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address_lines: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vat: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iban: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contacts: Option<String>,
}

/// A validated render request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub content_version: u32,
    pub entity: Entity,
    /// `None`: the entity's active version (AC-4.4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub letterhead_version: Option<i32>,
    pub language: Language,
    /// The version of the issuer's details the caller used (content version 2 only; `None` in version 1 and
    /// when a version 2 caller sends no pin). Read by the service, never by the layout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legal_entity_version: Option<i32>,
    /// Parsed for its structure in both versions and otherwise ignored by the service (AC-5.2).
    #[serde(default)]
    pub entity_data: EntityData,
    pub blocks: Vec<Block>,
}

/// A block of the document body (AC-1.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Heading(Heading),
    Paragraph(Paragraph),
    List(List),
    Table(Table),
    Image(Image),
    PageBreak,
}

/// What a table cell may hold: a paragraph or a list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CellBlock {
    Paragraph(Paragraph),
    List(List),
}

/// A heading of level 1 to 3.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}

/// A paragraph: runs of text. No runs is an empty paragraph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Paragraph {
    pub runs: Vec<Run>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}

/// A run of text with its own emphasis. The text is data: it is never read as markup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub text: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub bold: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub italic: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}

/// A bulleted or numbered list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    #[serde(default, skip_serializing_if = "is_false")]
    pub ordered: bool,
    pub items: Vec<ListItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListItem {
    pub runs: Vec<Run>,
}

/// A table. `columns` are relative widths; `header` and every row hold one cell per column, and a cell
/// holds paragraphs or lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Table {
    pub columns: Vec<f64>,
    /// At most one entry per column; a column without one is left-aligned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Vec<Align>>,
    /// The header row, repeated on every page the table continues on (AC-1.6). `None`: no header row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<Vec<Vec<CellBlock>>>,
    pub rows: Vec<Vec<Vec<CellBlock>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}

/// An image whose bytes are in the request (AC-2.3). `data` is base64 of a PNG, JPEG or SVG; its format
/// and size are judged from the decoded bytes by the asset rules (AC-7.1 to AC-7.3), never from a name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub data: String,
    /// Width as a share of the body width, above 0 and at most 1. `None`: the full width.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width_ratio: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<Style>,
}
