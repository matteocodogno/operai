//! Validation of a render request (AC-1.5, 1.7, 1.8, 2.3, 3.3, 3.6, 4.9).
//!
//! The walker reads a `serde_json::Value`, not bytes through serde's derive, for one reason: AC-3.6 says an
//! error answer never repeats any text from the request, and serde's errors quote it (`unknown field
//! `<name>``). Here a problem is a path and a reason from a closed list, and both come from this file:
//!
//! - the path is a JSON Pointer made of fixed member names and array indexes. A member name that the
//!   schema does not know is never written into a path: the problem points at the object that holds it
//!   (`unknown_member`). The image members that name an address (`url`, `path`, ...) are fixed names of
//!   a deny list, so those may appear (`external_reference`, AC-2.3);
//! - a missing member is reported at the path it should have had;
//! - the reason is a [`Reason`].
//!
//! Order of the verdicts, so that one request has one answer: the envelope first (content version, entity,
//! language, each its own code), then the size limits and the problems of the body. A limit that is reached
//! ends the walk at once: `content_too_large` wins over problems, because the request is refused whatever
//! else it holds.

use serde_json::{Map, Value};

use super::model::{
    Align, Block, CONTENT_VERSION_2, CellBlock, Entity, EntityData, Heading, Image, Language, List,
    ListItem, Paragraph, RenderRequest, Run, SUPPORTED_CONTENT_VERSIONS, Style, Table,
};

/// AC-3.3: more blocks than this in one request is refused.
pub const MAX_BLOCKS: usize = 5_000;
/// AC-3.3: more characters than this in the text of one block is refused.
pub const MAX_TEXT_CHARS: usize = 200_000;
/// AC-3.6: an answer lists at most this many problems.
pub const MAX_PROBLEMS: usize = 20;
/// Upper bound of a table column weight and of a heading level; see [`Walker::table`] and [`Walker::heading`].
const MAX_COLUMN_WEIGHT: f64 = 1_000_000.0;
const MAX_HEADING_LEVEL: u64 = 3;

// The member names of the schema, in one place. The AC-9.2 test reads them: none may name a caller's domain.
/// The members of a content version 1 request.
pub(super) const ROOT_MEMBERS_V1: &[&str] = &[
    "contentVersion",
    "entity",
    "letterheadVersion",
    "language",
    "entityData",
    "blocks",
];
/// The members of a content version 2 request: version 1's and the pin of the issuer's details. A version 1
/// request that carries `legalEntityVersion` is refused as an unknown member, like any other.
pub(super) const ROOT_MEMBERS: &[&str] = &[
    "contentVersion",
    "entity",
    "letterheadVersion",
    "legalEntityVersion",
    "language",
    "entityData",
    "blocks",
];
pub(super) const ENTITY_DATA_MEMBERS: &[&str] =
    &["legalName", "addressLines", "vat", "iban", "contacts"];
pub(super) const HEADING_MEMBERS: &[&str] = &["type", "level", "text", "style"];
pub(super) const PARAGRAPH_MEMBERS: &[&str] = &["type", "runs", "style"];
pub(super) const LIST_MEMBERS: &[&str] = &["type", "ordered", "items", "style"];
pub(super) const ITEM_MEMBERS: &[&str] = &["runs"];
pub(super) const RUN_MEMBERS: &[&str] = &["text", "bold", "italic", "underline", "style"];
pub(super) const TABLE_MEMBERS: &[&str] = &["type", "columns", "align", "header", "rows", "style"];
pub(super) const IMAGE_MEMBERS: &[&str] = &["type", "data", "widthRatio", "style"];
pub(super) const PAGE_BREAK_MEMBERS: &[&str] = &["type"];
/// Image members that would make the service fetch something for the caller (AC-2.3): always refused.
pub(super) const IMAGE_REFERENCE_MEMBERS: &[&str] =
    &["url", "uri", "href", "src", "source", "path", "file"];
pub(super) const BLOCK_TYPES: &[&str] = &[
    "heading",
    "paragraph",
    "list",
    "table",
    "image",
    "pageBreak",
];
pub(super) const CELL_BLOCK_TYPES: &[&str] = &["paragraph", "list"];

/// Why a part of the request is refused. A closed list: the answer carries these and nothing else. It is
/// serialised as its [`Reason::as_str`] name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The body is not JSON, or nests deeper than the parser allows.
    MalformedJson,
    /// A value of another JSON type than the schema says.
    WrongType,
    MissingMember,
    UnknownMember,
    /// A block `type` outside the closed set, or one that is not allowed in a table cell.
    UnknownBlockType,
    UnknownStyle,
    /// A number outside its bounds, or one that is not of the kind asked for.
    OutOfRange,
    /// An image that names an address (a URL or a path) instead of carrying its bytes.
    ExternalReference,
    InvalidBase64,
    /// A header or a row with a number of cells other than the table's columns, or an `align` longer
    /// than them.
    ColumnCountMismatch,
    /// A table with no columns.
    NoColumns,
    /// An image block that the asset rules refuse (AC-2.3, AC-7.1 to AC-7.3; amendment 2026-11-17, 3g): the
    /// upload reasons of [`crate::assets::Reason`] join this list, at the path of the block's `data`.
    Asset(crate::assets::Reason),
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::MalformedJson => "malformed_json",
            Reason::WrongType => "wrong_type",
            Reason::MissingMember => "missing_member",
            Reason::UnknownMember => "unknown_member",
            Reason::UnknownBlockType => "unknown_block_type",
            Reason::UnknownStyle => "unknown_style",
            Reason::OutOfRange => "out_of_range",
            Reason::ExternalReference => "external_reference",
            Reason::InvalidBase64 => "invalid_base64",
            Reason::ColumnCountMismatch => "column_count_mismatch",
            Reason::NoColumns => "no_columns",
            Reason::Asset(reason) => reason.as_str(),
        }
    }
}

impl serde::Serialize for Reason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// One problem of a request: where, and why. Never any text of the request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Problem {
    /// JSON Pointer into the request (RFC 6901); the empty string is the whole request.
    pub path: String,
    pub reason: Reason,
}

/// The limit that a `content_too_large` names (AC-3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Limit {
    pub name: LimitName,
    pub max: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LimitName {
    /// Blocks in the request, counting those inside table cells.
    Blocks,
    /// Characters of the text of one block.
    TextChars,
}

impl Limit {
    pub const BLOCKS: Limit = Limit {
        name: LimitName::Blocks,
        max: MAX_BLOCKS,
    };
    pub const TEXT_CHARS: Limit = Limit {
        name: LimitName::TextChars,
        max: MAX_TEXT_CHARS,
    };

    pub fn name(self) -> &'static str {
        match self.name {
            LimitName::Blocks => "blocks",
            LimitName::TextChars => "text_chars",
        }
    }
}

/// Why a request is not rendered. Each variant is one answer of the render routes (plan § API contracts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    /// 422 `invalid_content`: 1 to [`MAX_PROBLEMS`] problems.
    InvalidContent(Vec<Problem>),
    /// 422 `content_too_large`, naming the limit.
    ContentTooLarge(Limit),
    /// 422 `unsupported_content_version`.
    UnsupportedContentVersion,
    /// 422 `unsupported_language`.
    UnsupportedLanguage,
    /// 422 `unknown_entity`.
    UnknownEntity,
}

impl Rejection {
    /// The `code` of the RFC 7807 answer.
    pub fn code(&self) -> &'static str {
        match self {
            Rejection::InvalidContent(_) => "invalid_content",
            Rejection::ContentTooLarge(_) => "content_too_large",
            Rejection::UnsupportedContentVersion => "unsupported_content_version",
            Rejection::UnsupportedLanguage => "unsupported_language",
            Rejection::UnknownEntity => "unknown_entity",
        }
    }

    pub fn problems(&self) -> &[Problem] {
        match self {
            Rejection::InvalidContent(problems) => problems,
            _ => &[],
        }
    }

    pub fn limit(&self) -> Option<Limit> {
        match self {
            Rejection::ContentTooLarge(limit) => Some(*limit),
            _ => None,
        }
    }
}

/// Parse and validate a request body. The one entry point for bytes: a body that is not JSON is one
/// `malformed_json` problem, and the parser's message, which quotes the text, is dropped.
pub fn parse_request(body: &[u8]) -> Result<RenderRequest, Rejection> {
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => validate_request(&value),
        Err(_) => Err(Rejection::InvalidContent(vec![Problem {
            path: String::new(),
            reason: Reason::MalformedJson,
        }])),
    }
}

/// Validate a parsed request and build its typed form.
pub fn validate_request(root: &Value) -> Result<RenderRequest, Rejection> {
    let Some(object) = root.as_object() else {
        return Err(Rejection::InvalidContent(vec![Problem {
            path: String::new(),
            reason: Reason::WrongType,
        }]));
    };

    // The envelope. Each has its own code, so a caller can tell them from a malformed body.
    let Some(content_version) = object
        .get("contentVersion")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| SUPPORTED_CONTENT_VERSIONS.contains(n))
    else {
        return Err(Rejection::UnsupportedContentVersion);
    };
    let Some(entity) = object
        .get("entity")
        .and_then(Value::as_str)
        .and_then(Entity::parse)
    else {
        return Err(Rejection::UnknownEntity);
    };
    let Some(language) = object
        .get("language")
        .and_then(Value::as_str)
        .and_then(Language::parse)
    else {
        return Err(Rejection::UnsupportedLanguage);
    };

    let mut walker = Walker::default();
    let request = walker.request(object, content_version, entity, language);
    if let Some(limit) = walker.limit {
        return Err(Rejection::ContentTooLarge(limit));
    }
    if !walker.problems.is_empty() {
        return Err(Rejection::InvalidContent(walker.problems));
    }
    Ok(request)
}

// ---------------------------------------------------------------------------------------------------
// Paths: a linked list on the stack, rendered only when a problem is recorded.

#[derive(Clone, Copy)]
enum Seg {
    Key(&'static str),
    Index(usize),
}

struct Path<'a> {
    parent: At<'a>,
    seg: Seg,
}

type At<'a> = Option<&'a Path<'a>>;

impl<'a> Path<'a> {
    fn key(parent: At<'a>, key: &'static str) -> Path<'a> {
        Path {
            parent,
            seg: Seg::Key(key),
        }
    }

    fn index(parent: At<'a>, index: usize) -> Path<'a> {
        Path {
            parent,
            seg: Seg::Index(index),
        }
    }
}

fn render_path(at: At<'_>) -> String {
    let mut segments = Vec::new();
    let mut cursor = at;
    while let Some(path) = cursor {
        segments.push(path.seg);
        cursor = path.parent;
    }
    let mut out = String::new();
    for seg in segments.into_iter().rev() {
        out.push('/');
        match seg {
            // Keys come from this file and hold no `~` or `/`; the escape is the RFC's, kept for safety.
            Seg::Key(key) => out.push_str(&key.replace('~', "~0").replace('/', "~1")),
            Seg::Index(index) => out.push_str(&index.to_string()),
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------------

#[derive(Default)]
struct Walker {
    problems: Vec<Problem>,
    /// Blocks seen so far, at any depth; an empty table cell counts as one.
    units: usize,
    /// The first limit reached. The walk stops once it is set.
    limit: Option<Limit>,
}

impl Walker {
    fn problem(&mut self, at: At<'_>, reason: Reason) {
        if self.problems.len() < MAX_PROBLEMS {
            self.problems.push(Problem {
                path: render_path(at),
                reason,
            });
        }
    }

    fn halted(&self) -> bool {
        self.limit.is_some()
    }

    fn reach(&mut self, limit: Limit) {
        self.limit.get_or_insert(limit);
    }

    fn unit(&mut self) {
        self.units += 1;
        if self.units > MAX_BLOCKS {
            self.reach(Limit::BLOCKS);
        }
    }

    /// Add the characters of one text to a block's total. A text that adds no characters (an empty run,
    /// list item or address line) counts as one, so that a body of empty runs cannot escape the limit
    /// (plan amendment 2026-11-17, item 3b).
    fn text_chars(&mut self, total: &mut usize, text: &str) {
        *total = total.saturating_add(text.chars().count().max(1));
        if *total > MAX_TEXT_CHARS {
            self.reach(Limit::TEXT_CHARS);
        }
    }

    // --- helpers over one JSON object ---------------------------------------------------------------

    /// Record `unknown_member` once for the object when it holds a member outside `allowed`.
    fn check_members(&mut self, object: &Map<String, Value>, at: At<'_>, allowed: &[&str]) {
        if object.keys().any(|key| !allowed.contains(&key.as_str())) {
            self.problem(at, Reason::UnknownMember);
        }
    }

    fn object<'v>(&mut self, value: &'v Value, at: At<'_>) -> Option<&'v Map<String, Value>> {
        let object = value.as_object();
        if object.is_none() {
            self.problem(at, Reason::WrongType);
        }
        object
    }

    fn array<'v>(&mut self, value: &'v Value, at: At<'_>) -> Option<&'v Vec<Value>> {
        let array = value.as_array();
        if array.is_none() {
            self.problem(at, Reason::WrongType);
        }
        array
    }

    /// A required member; records `missing_member` when absent.
    fn required<'v>(
        &mut self,
        object: &'v Map<String, Value>,
        key: &'static str,
        at: At<'_>,
    ) -> Option<&'v Value> {
        let value = object.get(key);
        if value.is_none() {
            self.problem(Some(&Path::key(at, key)), Reason::MissingMember);
        }
        value
    }

    fn required_string<'v>(
        &mut self,
        object: &'v Map<String, Value>,
        key: &'static str,
        at: At<'_>,
    ) -> Option<&'v str> {
        let here = Path::key(at, key);
        let Some(value) = object.get(key) else {
            self.problem(Some(&here), Reason::MissingMember);
            return None;
        };
        let text = value.as_str();
        if text.is_none() {
            self.problem(Some(&here), Reason::WrongType);
        }
        text
    }

    fn optional_bool(
        &mut self,
        object: &Map<String, Value>,
        key: &'static str,
        at: At<'_>,
    ) -> bool {
        match object.get(key) {
            None => false,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                self.problem(Some(&Path::key(at, key)), Reason::WrongType);
                false
            }
        }
    }

    fn optional_style(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<Style> {
        let value = object.get("style")?;
        let here = Path::key(at, "style");
        match value.as_str() {
            Some(name) => {
                let style = Style::parse(name);
                if style.is_none() {
                    self.problem(Some(&here), Reason::UnknownStyle);
                }
                style
            }
            None => {
                self.problem(Some(&here), Reason::WrongType);
                None
            }
        }
    }

    // --- the request ---------------------------------------------------------------------------------

    fn request(
        &mut self,
        object: &Map<String, Value>,
        content_version: u32,
        entity: Entity,
        language: Language,
    ) -> RenderRequest {
        let v2 = content_version == CONTENT_VERSION_2;
        self.check_members(
            object,
            None,
            if v2 { ROOT_MEMBERS } else { ROOT_MEMBERS_V1 },
        );

        let letterhead_version = match object.get("letterheadVersion") {
            None | Some(Value::Null) => None,
            Some(value) => {
                let here = Path::key(None, "letterheadVersion");
                match value.as_i64() {
                    Some(n) if (1..=i64::from(i32::MAX)).contains(&n) => Some(n as i32),
                    _ if value.is_number() => {
                        self.problem(Some(&here), Reason::OutOfRange);
                        None
                    }
                    _ => {
                        self.problem(Some(&here), Reason::WrongType);
                        None
                    }
                }
            }
        };

        // Version 2 only. In version 1 the member is already an `unknown_member` of the root and is not read.
        let legal_entity_version = match object.get("legalEntityVersion") {
            Some(value) if v2 && !value.is_null() => {
                let here = Path::key(None, "legalEntityVersion");
                match value.as_i64() {
                    Some(n) if (1..=i64::from(i32::MAX)).contains(&n) => Some(n as i32),
                    _ if value.is_number() => {
                        self.problem(Some(&here), Reason::OutOfRange);
                        None
                    }
                    _ => {
                        self.problem(Some(&here), Reason::WrongType);
                        None
                    }
                }
            }
            _ => None,
        };

        let entity_data = match object.get("entityData") {
            None | Some(Value::Null) => EntityData::default(),
            Some(value) => {
                let here = Path::key(None, "entityData");
                self.entity_data(value, Some(&here))
            }
        };

        let blocks = match object.get("blocks") {
            None => {
                self.problem(Some(&Path::key(None, "blocks")), Reason::MissingMember);
                Vec::new()
            }
            Some(value) => {
                let here = Path::key(None, "blocks");
                self.blocks(value, Some(&here))
            }
        };

        RenderRequest {
            content_version,
            entity,
            letterhead_version,
            legal_entity_version,
            language,
            entity_data,
            blocks,
        }
    }

    fn entity_data(&mut self, value: &Value, at: At<'_>) -> EntityData {
        let mut data = EntityData::default();
        let Some(object) = self.object(value, at) else {
            return data;
        };
        self.check_members(object, at, ENTITY_DATA_MEMBERS);
        data.legal_name = self.entity_text(object, "legalName", at);
        data.vat = self.entity_text(object, "vat", at);
        data.iban = self.entity_text(object, "iban", at);
        data.contacts = self.entity_text(object, "contacts", at);

        match object.get("addressLines") {
            None | Some(Value::Null) => {}
            Some(value) => {
                let here = Path::key(at, "addressLines");
                if let Some(lines) = self.array(value, Some(&here)) {
                    // One budget for the whole address; an empty line counts as one, like any empty text.
                    let mut total = 0usize;
                    let mut out = Vec::with_capacity(lines.len().min(64));
                    for (index, line) in lines.iter().enumerate() {
                        if self.halted() {
                            break;
                        }
                        let line_at = Path::index(Some(&here), index);
                        match line.as_str() {
                            Some(text) => {
                                self.text_chars(&mut total, text);
                                out.push(text.to_owned());
                            }
                            None => self.problem(Some(&line_at), Reason::WrongType),
                        }
                    }
                    data.address_lines = Some(out);
                }
            }
        }
        data
    }

    /// An optional entity value; `null` is the same as absent, as a caller's empty profile field is.
    fn entity_text(
        &mut self,
        object: &Map<String, Value>,
        key: &'static str,
        at: At<'_>,
    ) -> Option<String> {
        match object.get(key) {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => {
                let mut total = 0usize;
                self.text_chars(&mut total, text);
                Some(text.clone())
            }
            Some(_) => {
                self.problem(Some(&Path::key(at, key)), Reason::WrongType);
                None
            }
        }
    }

    // --- blocks ---------------------------------------------------------------------------------------

    fn blocks(&mut self, value: &Value, at: At<'_>) -> Vec<Block> {
        let Some(array) = self.array(value, at) else {
            return Vec::new();
        };
        if array.len() > MAX_BLOCKS {
            self.reach(Limit::BLOCKS);
            return Vec::new();
        }
        let mut out = Vec::with_capacity(array.len());
        for (index, item) in array.iter().enumerate() {
            if self.halted() {
                break;
            }
            let here = Path::index(at, index);
            if let Some(block) = self.block(item, Some(&here)) {
                out.push(block);
            }
        }
        out
    }

    /// The `type` of a block object, checked against the set allowed here.
    fn block_type<'v>(
        &mut self,
        object: &'v Map<String, Value>,
        at: At<'_>,
        allowed: &[&str],
    ) -> Option<&'v str> {
        let here = Path::key(at, "type");
        match object.get("type") {
            None => {
                self.problem(Some(&here), Reason::MissingMember);
                None
            }
            Some(Value::String(name)) if allowed.contains(&name.as_str()) => Some(name),
            Some(Value::String(_)) => {
                self.problem(Some(&here), Reason::UnknownBlockType);
                None
            }
            Some(_) => {
                self.problem(Some(&here), Reason::WrongType);
                None
            }
        }
    }

    fn block(&mut self, value: &Value, at: At<'_>) -> Option<Block> {
        let object = self.object(value, at)?;
        let kind = self.block_type(object, at, BLOCK_TYPES)?;
        self.unit();
        if self.halted() {
            return None;
        }
        match kind {
            "heading" => self.heading(object, at).map(Block::Heading),
            "paragraph" => self.paragraph(object, at).map(Block::Paragraph),
            "list" => self.list(object, at).map(Block::List),
            "table" => self.table(object, at).map(Block::Table),
            "image" => self.image(object, at).map(Block::Image),
            _ => {
                self.check_members(object, at, PAGE_BREAK_MEMBERS);
                Some(Block::PageBreak)
            }
        }
    }

    fn heading(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<Heading> {
        self.check_members(object, at, HEADING_MEMBERS);
        let style = self.optional_style(object, at);

        let level = match object.get("level") {
            None => {
                self.problem(Some(&Path::key(at, "level")), Reason::MissingMember);
                1
            }
            Some(value) => match value.as_u64() {
                Some(level) if (1..=MAX_HEADING_LEVEL).contains(&level) => level as u8,
                _ if value.is_number() => {
                    self.problem(Some(&Path::key(at, "level")), Reason::OutOfRange);
                    1
                }
                _ => {
                    self.problem(Some(&Path::key(at, "level")), Reason::WrongType);
                    1
                }
            },
        };
        let text = self.required_string(object, "text", at).unwrap_or_default();
        let mut total = 0usize;
        self.text_chars(&mut total, text);
        Some(Heading {
            level,
            text: text.to_owned(),
            style,
        })
    }

    fn paragraph(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<Paragraph> {
        self.check_members(object, at, PARAGRAPH_MEMBERS);
        let style = self.optional_style(object, at);
        let mut total = 0usize;
        let runs = match self.required(object, "runs", at) {
            Some(value) => {
                let here = Path::key(at, "runs");
                self.runs(value, Some(&here), &mut total)
            }
            None => Vec::new(),
        };
        Some(Paragraph { runs, style })
    }

    fn runs(&mut self, value: &Value, at: At<'_>, total: &mut usize) -> Vec<Run> {
        let Some(array) = self.array(value, at) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(array.len().min(1024));
        for (index, item) in array.iter().enumerate() {
            if self.halted() {
                break;
            }
            let here = Path::index(at, index);
            let Some(object) = self.object(item, Some(&here)) else {
                continue;
            };
            self.check_members(object, Some(&here), RUN_MEMBERS);
            let text = self
                .required_string(object, "text", Some(&here))
                .unwrap_or_default();
            self.text_chars(total, text);
            let bold = self.optional_bool(object, "bold", Some(&here));
            let italic = self.optional_bool(object, "italic", Some(&here));
            let underline = self.optional_bool(object, "underline", Some(&here));
            let style = self.optional_style(object, Some(&here));
            out.push(Run {
                text: text.to_owned(),
                bold,
                italic,
                underline,
                style,
            });
        }
        out
    }

    fn list(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<List> {
        self.check_members(object, at, LIST_MEMBERS);
        let style = self.optional_style(object, at);
        let ordered = self.optional_bool(object, "ordered", at);
        let mut total = 0usize;
        let mut items = Vec::new();
        if let Some(value) = self.required(object, "items", at) {
            let here = Path::key(at, "items");
            if let Some(array) = self.array(value, Some(&here)) {
                items.reserve(array.len().min(1024));
                for (index, item) in array.iter().enumerate() {
                    if self.halted() {
                        break;
                    }
                    let item_at = Path::index(Some(&here), index);
                    let Some(item_object) = self.object(item, Some(&item_at)) else {
                        continue;
                    };
                    self.check_members(item_object, Some(&item_at), ITEM_MEMBERS);
                    let runs = match self.required(item_object, "runs", Some(&item_at)) {
                        Some(value) => {
                            let runs_at = Path::key(Some(&item_at), "runs");
                            self.runs(value, Some(&runs_at), &mut total)
                        }
                        None => Vec::new(),
                    };
                    items.push(ListItem { runs });
                }
            }
        }
        Some(List {
            ordered,
            items,
            style,
        })
    }

    fn table(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<Table> {
        self.check_members(object, at, TABLE_MEMBERS);
        let style = self.optional_style(object, at);

        let columns = self.columns(object, at);
        let width = columns.len();

        let align = match object.get("align") {
            None => None,
            Some(value) => {
                let here = Path::key(at, "align");
                self.align(value, Some(&here), width)
            }
        };

        let header = match object.get("header") {
            None => None,
            Some(value) => {
                let here = Path::key(at, "header");
                Some(self.row(value, Some(&here), width))
            }
        };

        let mut rows = Vec::new();
        if let Some(value) = self.required(object, "rows", at) {
            let here = Path::key(at, "rows");
            if let Some(array) = self.array(value, Some(&here)) {
                rows.reserve(array.len().min(1024));
                for (index, row) in array.iter().enumerate() {
                    if self.halted() {
                        break;
                    }
                    let row_at = Path::index(Some(&here), index);
                    rows.push(self.row(row, Some(&row_at), width));
                }
            }
        }

        Some(Table {
            columns,
            align,
            header,
            rows,
            style,
        })
    }

    fn columns(&mut self, object: &Map<String, Value>, at: At<'_>) -> Vec<f64> {
        let Some(value) = self.required(object, "columns", at) else {
            return Vec::new();
        };
        let here = Path::key(at, "columns");
        let Some(array) = self.array(value, Some(&here)) else {
            return Vec::new();
        };
        if array.is_empty() {
            self.problem(Some(&here), Reason::NoColumns);
        }
        let mut out = Vec::with_capacity(array.len().min(1024));
        for (index, item) in array.iter().enumerate() {
            let item_at = Path::index(Some(&here), index);
            match item.as_f64() {
                Some(weight) if weight > 0.0 && weight <= MAX_COLUMN_WEIGHT => out.push(weight),
                Some(_) => {
                    self.problem(Some(&item_at), Reason::OutOfRange);
                    out.push(1.0);
                }
                None => {
                    self.problem(Some(&item_at), Reason::WrongType);
                    out.push(1.0);
                }
            }
        }
        out
    }

    fn align(&mut self, value: &Value, at: At<'_>, width: usize) -> Option<Vec<Align>> {
        let array = self.array(value, at)?;
        if array.len() > width {
            self.problem(at, Reason::ColumnCountMismatch);
        }
        let mut out = Vec::with_capacity(array.len().min(1024));
        for (index, item) in array.iter().enumerate() {
            let item_at = Path::index(at, index);
            match item.as_str() {
                Some(name) => match Align::parse(name) {
                    Some(align) => out.push(align),
                    None => {
                        self.problem(Some(&item_at), Reason::OutOfRange);
                        out.push(Align::Left);
                    }
                },
                None => {
                    self.problem(Some(&item_at), Reason::WrongType);
                    out.push(Align::Left);
                }
            }
        }
        Some(out)
    }

    /// A header or body row: one cell per column, a cell holding paragraphs and lists.
    fn row(&mut self, value: &Value, at: At<'_>, width: usize) -> Vec<Vec<CellBlock>> {
        let Some(cells) = self.array(value, at) else {
            return Vec::new();
        };
        if cells.len() != width {
            self.problem(at, Reason::ColumnCountMismatch);
        }
        let mut out = Vec::with_capacity(cells.len().min(1024));
        for (index, cell) in cells.iter().enumerate() {
            if self.halted() {
                break;
            }
            let cell_at = Path::index(at, index);
            out.push(self.cell(cell, Some(&cell_at)));
        }
        out
    }

    fn cell(&mut self, value: &Value, at: At<'_>) -> Vec<CellBlock> {
        let Some(array) = self.array(value, at) else {
            return Vec::new();
        };
        if array.is_empty() {
            // An empty cell is still a thing to lay out.
            self.unit();
        }
        let mut out = Vec::with_capacity(array.len().min(64));
        for (index, item) in array.iter().enumerate() {
            if self.halted() {
                break;
            }
            let here = Path::index(at, index);
            let Some(object) = self.object(item, Some(&here)) else {
                continue;
            };
            let Some(kind) = self.block_type(object, Some(&here), CELL_BLOCK_TYPES) else {
                continue;
            };
            self.unit();
            if self.halted() {
                break;
            }
            match kind {
                "paragraph" => {
                    if let Some(paragraph) = self.paragraph(object, Some(&here)) {
                        out.push(CellBlock::Paragraph(paragraph));
                    }
                }
                _ => {
                    if let Some(list) = self.list(object, Some(&here)) {
                        out.push(CellBlock::List(list));
                    }
                }
            }
        }
        out
    }

    fn image(&mut self, object: &Map<String, Value>, at: At<'_>) -> Option<Image> {
        // A block that names an address is refused whatever else it holds (AC-2.3).
        for name in IMAGE_REFERENCE_MEMBERS {
            if object.contains_key(*name) {
                self.problem(Some(&Path::key(at, name)), Reason::ExternalReference);
            }
        }
        let allowed: Vec<&str> = IMAGE_MEMBERS
            .iter()
            .chain(IMAGE_REFERENCE_MEMBERS)
            .copied()
            .collect();
        self.check_members(object, at, &allowed);
        let style = self.optional_style(object, at);

        let data = match self.required_string(object, "data", at) {
            Some(data) => {
                if !is_base64(data) {
                    self.problem(Some(&Path::key(at, "data")), Reason::InvalidBase64);
                }
                data.to_owned()
            }
            None => String::new(),
        };

        let width_ratio = match object.get("widthRatio") {
            None => None,
            Some(value) => {
                let here = Path::key(at, "widthRatio");
                match value.as_f64() {
                    Some(ratio) if ratio > 0.0 && ratio <= 1.0 => Some(ratio),
                    Some(_) => {
                        self.problem(Some(&here), Reason::OutOfRange);
                        None
                    }
                    None => {
                        self.problem(Some(&here), Reason::WrongType);
                        None
                    }
                }
            }
        };
        Some(Image {
            data,
            width_ratio,
            style,
        })
    }
}

/// Standard base64 with padding, no whitespace. Whether the bytes are an image is judged later, from the
/// bytes (AC-7.1); this keeps text that is plainly not base64 (a URL, a path) out of the layout code.
fn is_base64(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|b| **b == b'=').count();
    if padding > 2 {
        return false;
    }
    bytes[..bytes.len() - padding]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/')
}
