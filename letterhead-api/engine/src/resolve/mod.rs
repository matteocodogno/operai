//! Render-time resolution of the header and footer texts (task T4; AC-2.4, 6.3 to 6.6, 5.7).
//!
//! The texts of a letterhead hold placeholders, never values (AC-6.3). At render time this turns each line
//! of each variant into the parts that are drawn, in the document's language, from the entity data that
//! came with the request:
//!
//! - a placeholder whose value is missing, empty or only spaces prints nothing and is listed (AC-6.4);
//! - `{address}` is the address lines in order, blank ones skipped, joined with `, ` (AC-6.5);
//! - a conditional segment prints, without its brackets, only if every placeholder in it has a value;
//!   otherwise all of it goes, label included (AC-6.6);
//! - a line left with no text is not drawn and takes no height (AC-6.4);
//! - `{page}` and `{pages}` stay symbolic ([`Part::Page`], [`Part::Pages`]): the layout fills them per page
//!   (AC-5.7). They are never "missing";
//! - a line keeps its own look wherever it ends up: [`ResolvedLine`] carries the size, weight and colour of
//!   the line as authored, so a line that is dropped cannot shift the looks of the lines after it (the spike's
//!   finding, which keyed looks by position in the filtered list).
//!
//! **Mark missing (specs/20261117-legal-entities, plan E3, AC-5.4).** Only the configurator's preview asks for
//! it ([`resolve_marking`]). A placeholder without a value is then drawn as its label between `⟦` and `⟧` in the
//! missing look ([`Part::Missing`]) and a conditional segment around it is kept, so that the person sees what is
//! not filled in; the placeholder is still listed as missing. The labels are a closed list in both languages
//! ([`label`]). Without the option nothing changes: a document never carries `⟦ ⟧` unless its own text does.
//!
//! Values are printed as sent (AC-2.1: character for character): nothing is trimmed or unescaped, and entity
//! data is never read for markup. The text of the document's own blocks never comes here: a `{name}` there is
//! printed as typed (AC-2.4), because only the letterhead's texts are resolved.

use std::collections::BTreeSet;

use serde::Serialize;

use crate::config::{
    Frame, LetterheadConfig, Line, Placeholder, Reason, Rule, Token, Valign, Variant, parse_text,
};
use crate::content::{EntityData, Language};

/// A drawn piece of a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Part {
    Text(String),
    /// A placeholder without a value, in the preview's "mark missing" mode only: its label between `⟦` and `⟧`
    /// (E3). Drawn in the missing look; its text is part of the page's text.
    Missing(String),
    /// The page's own number.
    Page,
    /// The document's page count.
    Pages,
}

/// A line that is drawn: at least one part that is not blank.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLine {
    /// Its position among the lines of its zone as authored, counting those that were dropped.
    pub index: usize,
    /// Consecutive text is one part.
    pub parts: Vec<Part>,
    /// The line's own look, copied from the authored line.
    pub size: f64,
    pub bold: bool,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFrame {
    pub valign: Valign,
    pub rule: Rule,
    pub left: Vec<ResolvedLine>,
    pub center: Vec<ResolvedLine>,
    pub right: Vec<ResolvedLine>,
}

impl ResolvedFrame {
    /// No line is drawn in any zone.
    pub fn is_empty(&self) -> bool {
        self.left.is_empty() && self.center.is_empty() && self.right.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVariant {
    pub header: ResolvedFrame,
    pub footer: ResolvedFrame,
    /// The placeholders this variant uses that had no value, by name, sorted, each once.
    pub missing: Vec<&'static str>,
}

/// The letterhead's three variants, resolved. Only the texts are resolved: margins, fonts, rules, logos and
/// backgrounds are read from the configuration as they are.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub default: ResolvedVariant,
    pub first: Option<ResolvedVariant>,
    pub last: Option<ResolvedVariant>,
}

impl Resolution {
    /// The names of the placeholders that were used and had no value, over every variant of the letterhead,
    /// sorted, each once (AC-6.4). A caller that knows which variants a document draws can use
    /// [`ResolvedVariant::missing`] of those instead.
    pub fn missing_placeholders(&self) -> Vec<&'static str> {
        let mut names = BTreeSet::new();
        for variant in [Some(&self.default), self.first.as_ref(), self.last.as_ref()]
            .into_iter()
            .flatten()
        {
            names.extend(variant.missing.iter().copied());
        }
        names.into_iter().collect()
    }
}

/// A text of a stored configuration that does not parse. A configuration passed validation when it was
/// saved, so this is a fault of the caller (an unvalidated configuration), never of a person's typing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveError {
    /// JSON Pointer of the text, into the configuration.
    pub path: String,
    pub reason: Reason,
}

/// The label of an entity placeholder in the preview's "mark missing" mode (plan E3): a closed list, the same
/// in every letterhead. `None` for `{page}` and `{pages}`, which are never missing.
pub fn label(placeholder: Placeholder, language: Language) -> Option<&'static str> {
    let (it, en) = match placeholder {
        Placeholder::LegalName => ("Ragione sociale", "Legal name"),
        Placeholder::Address => ("Indirizzo", "Address"),
        Placeholder::Vat => ("Partita IVA", "VAT number"),
        Placeholder::Iban => ("IBAN", "IBAN"),
        Placeholder::Contacts => ("Riga contatti", "Contacts line"),
        Placeholder::Page | Placeholder::Pages => return None,
    };
    Some(match language {
        Language::It => it,
        Language::En => en,
    })
}

/// The text of a missing value in the preview: its label between `⟦` (U+27E6) and `⟧` (U+27E7).
fn marked(placeholder: Placeholder, language: Language) -> Option<String> {
    label(placeholder, language).map(|label| format!("\u{27E6}{label}\u{27E7}"))
}

/// The values of the entity placeholders, worked out once.
struct Values {
    /// The preview's "mark missing" mode, and the language its labels are in.
    mark: Option<Language>,
    legal_name: Option<String>,
    address: Option<String>,
    vat: Option<String>,
    iban: Option<String>,
    contacts: Option<String>,
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

fn present(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|s| !is_blank(s)).cloned()
}

impl Values {
    fn of(data: &EntityData, mark: Option<Language>) -> Values {
        let address = data.address_lines.as_ref().and_then(|lines| {
            let kept: Vec<&str> = lines
                .iter()
                .map(String::as_str)
                .filter(|l| !is_blank(l))
                .collect();
            if kept.is_empty() {
                None
            } else {
                Some(kept.join(", "))
            }
        });
        Values {
            mark,
            legal_name: present(&data.legal_name),
            address,
            vat: present(&data.vat),
            iban: present(&data.iban),
            contacts: present(&data.contacts),
        }
    }

    /// `None` for a placeholder without a value. The page placeholders are not looked up here.
    fn get(&self, placeholder: Placeholder) -> Option<&str> {
        match placeholder {
            Placeholder::LegalName => self.legal_name.as_deref(),
            Placeholder::Address => self.address.as_deref(),
            Placeholder::Vat => self.vat.as_deref(),
            Placeholder::Iban => self.iban.as_deref(),
            Placeholder::Contacts => self.contacts.as_deref(),
            Placeholder::Page | Placeholder::Pages => None,
        }
    }

    fn has(&self, placeholder: Placeholder) -> bool {
        placeholder.is_page() || self.get(placeholder).is_some()
    }
}

fn push_text(parts: &mut Vec<Part>, text: &str) {
    if let Some(Part::Text(last)) = parts.last_mut() {
        last.push_str(text);
    } else {
        parts.push(Part::Text(text.to_owned()));
    }
}

fn emit(
    tokens: &[Token],
    values: &Values,
    parts: &mut Vec<Part>,
    missing: &mut BTreeSet<&'static str>,
) {
    for token in tokens {
        match token {
            Token::Literal(text) => push_text(parts, text),
            Token::Placeholder(Placeholder::Page) => parts.push(Part::Page),
            Token::Placeholder(Placeholder::Pages) => parts.push(Part::Pages),
            Token::Placeholder(placeholder) => match values.get(*placeholder) {
                Some(value) => push_text(parts, value),
                None => {
                    missing.insert(placeholder.name());
                    if let Some(language) = values.mark
                        && let Some(label) = marked(*placeholder, language)
                    {
                        parts.push(Part::Missing(label));
                    }
                }
            },
            Token::Segment(inner) => {
                let complete = inner.iter().all(|t| match t {
                    Token::Placeholder(p) => values.has(*p),
                    _ => true,
                });
                // Marking keeps an incomplete segment, so that its missing values show (AC-5.4).
                if complete || values.mark.is_some() {
                    emit(inner, values, parts, missing);
                } else {
                    // The whole segment goes; the placeholders in it that lack a value are still reported.
                    for t in inner {
                        if let Token::Placeholder(p) = t
                            && !values.has(*p)
                        {
                            missing.insert(p.name());
                        }
                    }
                }
            }
        }
    }
}

fn resolve_line(
    line: &Line,
    index: usize,
    path: &str,
    language: Language,
    values: &Values,
    missing: &mut BTreeSet<&'static str>,
) -> Result<Option<ResolvedLine>, ResolveError> {
    let text = match language {
        Language::It => &line.text.it,
        Language::En => &line.text.en,
    };
    let tokens = parse_text(text).map_err(|e| ResolveError {
        path: format!("{path}/{index}/text/{}", language.as_str()),
        reason: e.reason,
    })?;
    let mut parts = Vec::new();
    emit(&tokens, values, &mut parts, missing);
    // A line with no text is not drawn and takes no height. A page number is text.
    let drawn = parts.iter().any(|p| match p {
        Part::Text(text) => !is_blank(text),
        Part::Missing(_) | Part::Page | Part::Pages => true,
    });
    Ok(drawn.then(|| ResolvedLine {
        index,
        parts,
        size: line.size,
        bold: line.bold,
        color: line.color.clone(),
    }))
}

fn resolve_zone(
    lines: &[Line],
    path: &str,
    language: Language,
    values: &Values,
    missing: &mut BTreeSet<&'static str>,
) -> Result<Vec<ResolvedLine>, ResolveError> {
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(resolved) = resolve_line(line, index, path, language, values, missing)? {
            out.push(resolved);
        }
    }
    Ok(out)
}

fn resolve_frame(
    frame: &Frame,
    path: &str,
    language: Language,
    values: &Values,
    missing: &mut BTreeSet<&'static str>,
) -> Result<ResolvedFrame, ResolveError> {
    Ok(ResolvedFrame {
        valign: frame.valign,
        rule: frame.rule.clone(),
        left: resolve_zone(
            &frame.left,
            &format!("{path}/left"),
            language,
            values,
            missing,
        )?,
        center: resolve_zone(
            &frame.center,
            &format!("{path}/center"),
            language,
            values,
            missing,
        )?,
        right: resolve_zone(
            &frame.right,
            &format!("{path}/right"),
            language,
            values,
            missing,
        )?,
    })
}

fn resolve_variant(
    variant: &Variant,
    name: &str,
    language: Language,
    values: &Values,
) -> Result<ResolvedVariant, ResolveError> {
    let mut missing = BTreeSet::new();
    let header = resolve_frame(
        &variant.header,
        &format!("/variants/{name}/header"),
        language,
        values,
        &mut missing,
    )?;
    let footer = resolve_frame(
        &variant.footer,
        &format!("/variants/{name}/footer"),
        language,
        values,
        &mut missing,
    )?;
    Ok(ResolvedVariant {
        header,
        footer,
        missing: missing.into_iter().collect(),
    })
}

/// Resolve every variant of `config` in `language` with `data` (all of whose members are optional: a
/// request without entity data resolves, AC-6.3).
pub fn resolve(
    config: &LetterheadConfig,
    language: Language,
    data: &EntityData,
) -> Result<Resolution, ResolveError> {
    resolve_in(config, language, data, false)
}

/// [`resolve`] in the configurator preview's "mark missing" mode (plan E3, AC-5.4): a placeholder without a
/// value is a [`Part::Missing`] with its label, and a conditional segment around it is kept. The placeholders
/// without a value are still listed as missing.
pub fn resolve_marking(
    config: &LetterheadConfig,
    language: Language,
    data: &EntityData,
) -> Result<Resolution, ResolveError> {
    resolve_in(config, language, data, true)
}

/// [`resolve`] with the option that only the preview sets.
pub fn resolve_in(
    config: &LetterheadConfig,
    language: Language,
    data: &EntityData,
    mark: bool,
) -> Result<Resolution, ResolveError> {
    let values = Values::of(data, mark.then_some(language));
    let default = resolve_variant(&config.variants.default, "default", language, &values)?;
    let first = config
        .variants
        .first
        .as_ref()
        .map(|v| resolve_variant(v, "first", language, &values))
        .transpose()?;
    let last = config
        .variants
        .last
        .as_ref()
        .map(|v| resolve_variant(v, "last", language, &values))
        .transpose()?;
    Ok(Resolution {
        default,
        first,
        last,
    })
}

#[cfg(test)]
mod tests;
