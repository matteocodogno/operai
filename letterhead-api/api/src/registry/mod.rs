//! The legal entities registry as this service reads it (specs/20261117-legal-entities T21; AC-1.5, AC-3.2, AC-3.3,
//! AC-5.5; plan decision 7 and the section "Consumer read"; ADR
//! 20261117-the-letterhead-service-reads-the-issuers-details-itself-...).
//!
//! The issuer's legal name, address, VAT number and IBAN are `auth`'s, not the caller's: this service reads
//! `GET {AUTH_BASE_URL}/system/legal-entities` as itself (its own service client `letterhead-api`, scope
//! `legal-entities:read`, `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET`) and prints what it read. This is the Rust twin
//! of `crm-api/src/lib/legalEntities.ts`, with the same rule, which is the **consumer cache rule** of the ADR:
//!
//! - ONE entry per process: the list of both entities, stamped with the monotonic time its request was **sent** (not
//!   when the answer arrived, not when it was parsed);
//! - age < 30 s: used, no call;
//! - otherwise refreshed: single flight, 5 s in all (the token, the call and the one retry), no redirects, a body of
//!   at most 64 KiB;
//! - the refresh fails and the entry's age is <= 60 s: the old entry is used and `registry_stale_used` is logged;
//! - the refresh fails and the age is > 60 s, or there is no entry: [`Unavailable`] (the routes answer 503
//!   `legal_entities_unavailable` with `Retry-After: 5`). No document is made from older details.
//!
//! Why the proof holds (AC-3.3, AC-5.5): a document started at t uses an entry sent at >= t - 60 s. A save that
//! committed at T < t - 60 s was committed before that request was sent, so `auth` read the table after it. Nothing
//! older than 60 s is ever used.
//!
//! Layout: [`cache`] is the rule (a [`Source`] and a clock go in, snapshots come out); [`http`] is the one real source
//! (the service token and the call); this file holds the shape of the answer and what the engine is given from it.
//! The clock is injected, so the rule is tested at 29 / 31 / 59 / 61 s without waiting.
//!
//! Nothing here logs or prints a token, the secret, a body or a value: closed words and numbers only. This file and
//! its children name no other part of the crate, because `tests/registry.rs` compiles them on their own.

pub mod cache;
pub mod http;

use std::sync::Arc;

use letterhead_engine::content::{Entity, EntityData, Language};
use serde::Deserialize;

// What the supervisor wires; `tests/registry.rs` reaches the same items by their modules.
#[allow(
    unused_imports,
    reason = "compiled on its own by tests/registry.rs, which uses the modules"
)]
pub use cache::{Registry, RegistryOptions};
#[allow(
    unused_imports,
    reason = "compiled on its own by tests/registry.rs, which uses the modules"
)]
pub use http::{HttpSource, ServiceClient};

/// The code of the 503 when the registry cannot be read within the bounds of the cache rule.
pub const LEGAL_ENTITIES_UNAVAILABLE: &str = "legal_entities_unavailable";
/// The `Retry-After` of that 503, in seconds (plan, "API contracts").
pub const RETRY_AFTER_SECONDS: u64 = 5;

/// An entry younger than this is used without a call.
pub const FRESH_FOR: std::time::Duration = std::time::Duration::from_secs(30);
/// The oldest entry that may be used when a refresh fails.
pub const USABLE_FOR: std::time::Duration = std::time::Duration::from_secs(60);
/// The whole refresh: the token, the call and the one retry.
pub const REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
/// The largest answer that is read.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

// ─── The answer (plan, "API contracts": the shared fixture `legal-entities.json`) ────────────────────────────────────

/// A value in both languages of a document.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Localized<T> {
    pub it: T,
    pub en: T,
}

impl<T> Localized<T> {
    pub fn get(&self, language: Language) -> &T {
        match language {
            Language::It => &self.it,
            Language::En => &self.en,
        }
    }
}

/// One thing the registry holds against a value (`invalid` of the answer). Reported, never printed.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Invalid {
    pub field: String,
    #[serde(default)]
    pub line: Option<i64>,
    pub reason: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// One entity's details as the registry serves them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegalEntityDetails {
    pub entity: Entity,
    /// 0: not moved yet (empty values).
    pub version: i64,
    pub updated_at: Option<String>,
    pub legal_name: String,
    pub address: Localized<Vec<String>>,
    pub vat_number: String,
    /// Electronic form; "" when empty.
    pub iban: String,
    /// Groups of four, for print; "" when empty.
    pub iban_print: String,
    pub contacts: Localized<String>,
    pub complete: bool,
    pub missing: Vec<String>,
    pub invalid: Vec<Invalid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEntity {
    version: i64,
    updated_at: Option<String>,
    legal_name: String,
    address: Localized<Vec<String>>,
    vat_number: String,
    iban: String,
    iban_print: String,
    contacts: Localized<String>,
    complete: bool,
    missing: Vec<String>,
    invalid: Vec<Invalid>,
}

/// The entities of an answer, in [`Entity::ALL`] order, or `None` when it is not the contract's: not the list shape,
/// an entity of the group that is not whole or has a field of the wrong type, a negative version, an entity twice,
/// or one of the group's entities absent. An entity this service does not know is ignored whatever it holds (a
/// later entity may carry members this one has never heard of), and so is a member the contract does not name.
pub fn parse_legal_entities(body: &[u8]) -> Option<Vec<Arc<LegalEntityDetails>>> {
    let document: serde_json::Value = serde_json::from_slice(body).ok()?;
    let items = document.get("items")?.as_array()?;
    let mut found: Vec<Option<LegalEntityDetails>> = vec![None; Entity::ALL.len()];
    for item in items {
        let name = item.get("entity")?.as_str()?;
        let Some(entity) = Entity::parse(name) else {
            continue;
        };
        let raw = RawEntity::deserialize(item).ok()?;
        if raw.version < 0 {
            return None;
        }
        let slot = Entity::ALL.iter().position(|e| *e == entity)?;
        if found[slot].is_some() {
            return None;
        }
        found[slot] = Some(LegalEntityDetails {
            entity,
            version: raw.version,
            updated_at: raw.updated_at,
            legal_name: raw.legal_name,
            address: raw.address,
            vat_number: raw.vat_number,
            iban: raw.iban,
            iban_print: raw.iban_print,
            contacts: raw.contacts,
            complete: raw.complete,
            missing: raw.missing,
            invalid: raw.invalid,
        });
    }
    found.into_iter().map(|d| d.map(Arc::new)).collect()
}

/// What the engine is given for the header and footer of a document in `language` (plan, "Render"): the registry's
/// values, verbatim: the legal name, `address[language]`, the VAT number, `ibanPrint` and `contacts[language]`. An
/// empty value stays empty; the engine reads a blank one as missing (AC-5.3).
pub fn entity_data(details: &LegalEntityDetails, language: Language) -> EntityData {
    EntityData {
        legal_name: Some(details.legal_name.clone()),
        address_lines: Some(details.address.get(language).clone()),
        vat: Some(details.vat_number.clone()),
        iban: Some(details.iban_print.clone()),
        contacts: Some(details.contacts.get(language).clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(entity: &str, version: i64) -> serde_json::Value {
        serde_json::json!({
            "entity": entity, "version": version, "updatedAt": null, "legalName": "N",
            "address": {"it": ["a"], "en": ["b"]}, "vatNumber": "V", "iban": "I", "ibanPrint": "I P",
            "contacts": {"it": "c-it", "en": "c-en"}, "complete": true, "missing": [], "invalid": [],
        })
    }

    fn parse(items: &[serde_json::Value]) -> Option<Vec<Arc<LegalEntityDetails>>> {
        parse_legal_entities(serde_json::json!({ "items": items }).to_string().as_bytes())
    }

    #[test]
    fn registry_parse_keeps_the_group_order_and_ignores_what_it_does_not_know() {
        let parsed = parse(&[
            item("welld_ch", 3),
            item("elsewhere", 9),
            item("welld_it", 1),
        ])
        .expect("both entities are there");
        let order: Vec<Entity> = parsed.iter().map(|d| d.entity).collect();
        assert_eq!(order, Entity::ALL);
        assert_eq!(parsed[1].version, 3);
    }

    #[test]
    fn registry_parse_refuses_what_is_not_the_contract() {
        assert!(parse(&[item("welld_it", 1)]).is_none(), "an entity absent");
        assert!(
            parse(&[
                item("welld_it", 1),
                item("welld_it", 2),
                item("welld_ch", 1)
            ])
            .is_none(),
            "an entity twice"
        );
        assert!(parse(&[item("welld_it", -1), item("welld_ch", 1)]).is_none());
        assert!(parse_legal_entities(b"[]").is_none());
        assert!(parse_legal_entities(b"not json").is_none());
        let mut broken = item("welld_ch", 1);
        broken["complete"] = serde_json::json!("yes");
        assert!(parse(&[item("welld_it", 1), broken]).is_none());
    }

    #[test]
    fn registry_entity_data_is_the_registrys_values_in_the_documents_language() {
        let parsed = parse(&[item("welld_it", 1), item("welld_ch", 1)]).expect("parsed");
        let it = entity_data(&parsed[0], Language::It);
        let en = entity_data(&parsed[0], Language::En);
        assert_eq!(it.address_lines.as_deref(), Some(&["a".to_owned()][..]));
        assert_eq!(en.address_lines.as_deref(), Some(&["b".to_owned()][..]));
        assert_eq!(it.contacts.as_deref(), Some("c-it"));
        assert_eq!(en.contacts.as_deref(), Some("c-en"));
        assert_eq!(
            it.iban.as_deref(),
            Some("I P"),
            "the print form, not the electronic one"
        );
        assert_eq!(it.vat.as_deref(), Some("V"));
        assert_eq!(it.legal_name.as_deref(), Some("N"));
    }
}
