//! The configurator's preview (task T16; AC-8.4, AC-8.5, AC-5.8, plan § Person routes, § Sequences "Configurator
//! preview", amendment G6):
//!
//! `POST /v1/letterheads/{entity}/preview[?pages=1,2,3]` with `{ config, language, layoutVersion?, pages? }`
//! renders the built-in sample document ([`letterhead_engine::sample`]) on the configuration in the request, which
//! is the form as it is now, saved or not.
//!
//! **Who.** The person's token and `letterheads:access` are checked by the layers in front of this handler: a
//! holder of access sees the preview of both entities, whether or not they may change either (AC-8.2). A person
//! without it is 403 `forbidden` before anything of the request is read. The order after that is the write
//! routes' (T15): the entity (422 `unknown_entity`), then the request.
//!
//! **What is checked, in this order, each step cheaper than the next:**
//!
//! 1. `?pages=` (422 `invalid_pages`);
//! 2. the body, at most 1 MiB, within 15 s (413 / 408 / 400), and its envelope: exactly the members `config`,
//!    `language`, `layoutVersion` and `pages`, the first two required (422 `invalid_request`); a `language` that
//!    is not `it` or `en` is 422 `unsupported_language`; a `layoutVersion` this binary does not hold is 422
//!    `unknown_layout`;
//! 3. the configuration, with the save rules (`config::validate_config`), then that every asset it names is an
//!    uploaded asset of this entity and of the right kind, then the fit of each header and footer in its margin
//!    with 40-character values (`layout::check_fit`). Uploaded but not yet saved assets are allowed: an asset is
//!    an asset of the entity from the moment it is uploaded (AC-7.4). A refusal is **422 `invalid_letterhead`
//!    with `problems: [{ path, reason, name?, language? }]`, the very body of a refused save** (G3), so that the
//!    form maps both to its controls with one function. It is a refusal of the preview, not a failure of the
//!    service: nothing was saved and nothing is.
//! 4. the issuer's details from the registry (T23; AC-5.4, below), a place in the worker pool (429 `busy`), the
//!    sample, and the render by a worker, killed at the deadline
//!    (504). The preview is rendered by the same pool, with the same limits, as a document of a caller
//!    (`pool.admit` + `permit.run`), never on a supervisor thread. A header or footer that does not fit its
//!    margin with the sample's real values is the same 422 `invalid_letterhead`, at the frame. The fit check above
//!    makes it rare (its values are 40 characters of words that wrap and the sample's are no longer), but a value
//!    with no place to break can be wider than a narrow zone, and the render keeps its own refusal (AC-5.3).
//!
//! **The issuer's details** (T23; AC-5.4, plan "Configurator preview", amendment E3). The sample keeps its body
//! text, and its entity data is the registry's for the entity, in the preview language, read through the cache of
//! the render routes. The render is made in the "mark missing" mode: an empty value prints its label in the
//! `missing` look, the conditional segment around it is kept, and the page's `text` holds `⟦Label⟧`. Only this
//! route sets the mode, and it travels with the job (`Job::marking_missing`); no `/v1/render/*` job has it. When
//! the registry cannot be read (a document would be a 503, AC-5.5; a preview is not a document) the preview is
//! still made with every placeholder missing, `issuerDetails` is `"unavailable"` and `legalEntityVersion` is
//! `null`. Real details may be longer than the fit check's 40 characters: the frame that cannot hold them is the
//! same 422 `invalid_letterhead` at the frame (R9).
//!
//! **The answer** is the render preview's, 200 `application/json`:
//! `{ letterheadVersion, issuerDetails, legalEntityVersion, pageCount, missingPlaceholders, unprintableCharacters,
//! pages: [{ n, image, text }] }`.
//! There is no letterhead version, because the configuration may not have been saved: **`letterheadVersion` is
//! `null`** (the member is always there). The images are the 64-colour PNGs of the render preview and `text` is the
//! page's text in reading order. `Cache-Control: no-store`, like every answer of the person routes.
//!
//! **Outbound calls.** The body of the sample is a pure function of the entity and the language; nothing is read
//! from the CRM or from any other tool. The calls are `auth`'s: `GET /authz/resolve`, made by the layer in front
//! of this handler (cached 30 s), and the registry's `GET /system/legal-entities` through the cache of the render
//! routes (fresh 30 s). The service's own database and bucket are read only for the assets the configuration
//! names, so a configuration without any makes no call to either.
//!
//! **Nothing is kept.** The configuration, the sample and the pages live in this function and are dropped when it
//! returns; the log says nothing of the request. What an answer says is made by this crate (codes, JSON Pointers
//! into our own schema, closed reasons): no refusal repeats text of the request (AC-3.6's rule, kept on the
//! person routes).
//!
//! The helpers for the body and the assets mirror `write.rs`'s (T15) on purpose: that file is another task's.
//! They are small, and they are the same rules, tested here against the same inputs. The fit check is the very
//! function of the save (`write::fit_check`, a pool job: T48).

use std::time::Duration;

use axum::{
    body::Body,
    extract::{Extension, Query, Request, State, rejection::PathRejection},
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http_body_util::BodyExt as _;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use letterhead_engine::config::{LetterheadConfig, Problem, Reason, validate_config};
use letterhead_engine::content::{Entity, EntityData, Language, ingest_images};
use letterhead_engine::layout::{Assets, CURRENT_LAYOUT, layout};
use letterhead_engine::output::PageSelection;
use letterhead_engine::render::{LetterheadVersion, PreviewPage};
use letterhead_engine::sample;

use super::render::{pool_error, refusal_error};
use super::write::{fit_check, invalid_letterhead_values};
use super::{ApiError, AppState};
use crate::authz::Authz;
use crate::db::{AssetKind, AssetRow};
use crate::pool::PoolError;
use crate::pool::job::{Body as JobBody, Job, Meta, Output};
use crate::registry;
use crate::storage::StorageError;

/// A preview body: a configuration is a few KiB.
const BODY_MAX: usize = 1024 * 1024;
/// How long a caller has to send its body.
const BODY_TIMEOUT: Duration = Duration::from_secs(15);
/// How much more of an oversized body is read and thrown away, so the caller gets the answer.
const DRAIN_EXTRA: usize = 1024 * 1024;
/// `Retry-After` of a 503 or a 429.
const RETRY_SECONDS: u64 = 2;

/// The number of a letterhead version that is not one: the preview of a configuration that has not been saved.
/// Versions start at 1 (`baseVersion` 0 is "none yet"), so no stored version has it, and the answer says `null`.
const UNSAVED: i32 = 0;

#[derive(Debug, Deserialize)]
struct PreviewQuery {
    pages: Option<String>,
}

/// `POST /v1/letterheads/{entity}/preview`
pub async fn preview(
    State(app): State<AppState>,
    Extension(authz): Extension<Authz>,
    path: Result<axum::extract::Path<String>, PathRejection>,
    request: Request,
) -> Result<Response, ApiError> {
    // The entity, as every route has it (AC-4.9). Access is the whole permission: any entity is previewed.
    let entity = path
        .ok()
        .and_then(|axum::extract::Path(name)| Entity::parse(&name))
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unknown_entity"))?;
    let query_pages = pages_of_query(request.uri())?;
    let body = read_body(request).await?;
    let asked = envelope(&body)?;
    drop(body);

    // The pages: in the query or in the body, not both.
    let selection = match (query_pages, asked.pages) {
        (Some(_), Some(_)) => return Err(invalid_pages()),
        (Some(selection), None) | (None, Some(selection)) => selection,
        (None, None) => PageSelection::All,
    };

    // AC-5.1, 5.6, 5.8, 5.9, 6.1, 6.2, 6.6, 7.4, 7.5: the rules of the configuration, the save's own.
    let config = validate_config(&asked.config).map_err(invalid_letterhead)?;
    drop(asked.config);

    // The assets: uploaded assets of this entity, saved into a version or not (AC-7.4, 7.7).
    let ids = distinct_ids(&config);
    let files = if ids.is_empty() {
        Assets::new()
    } else {
        let rows = app
            .repo
            .assets_of_entity(entity, &ids)
            .await
            .map_err(|_| unavailable())?;
        let unknown = asset_problems(&config, &rows);
        if !unknown.is_empty() {
            return Err(invalid_letterhead(unknown));
        }
        let mut files = Assets::new();
        for row in &rows {
            let bytes = app.storage.asset(row).await.map_err(storage_error)?;
            files.insert(row.id.to_string(), bytes.as_slice().to_vec());
        }
        files
    };

    // AC-5.2: every frame fits its margin with the longest values, on the layout the person is looking at.
    let overflow = fit_check(
        &app,
        &authz,
        asked.layout_version,
        config.clone(),
        files.clone(),
    )
    .await?;
    if !overflow.is_empty() {
        return Err(invalid_letterhead_values(overflow));
    }

    // AC-5.4: the issuer's details, the registry's, in the preview language; the sample keeps its body.
    let issuer = issuer_for_preview(&app, entity, asked.language).await;

    // The sample, in the person's language, on this configuration, on the layout asked for.
    let job = sample_job(
        entity,
        asked.language,
        asked.layout_version,
        config,
        files,
        selection,
        issuer.data,
    )?;
    // The person's own place: a service caller has a name of its own (`system:...`), so the two never share one.
    // Interactive: of two or more workers a preview may hold all but the one that is kept for PDFs (T48).
    let permit = app
        .pool
        .admit_interactive(&format!("person:{}", authz.person.sub))
        .map_err(pool_error)?;
    let rendered = permit.run(job).await.map_err(preview_error)?;
    match rendered.body {
        JobBody::Preview(pages) => Ok(answer(&rendered.meta, &pages, issuer.version)),
        // The job asked for a preview: anything else is a fault of the pool.
        JobBody::Pdf(_) | JobBody::Fit(_) => Err(internal("render_failed")),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The request

/// A preview request, once its shape is checked.
struct Asked {
    config: Value,
    language: Language,
    layout_version: u32,
    pages: Option<PageSelection>,
}

/// A preview body: a JSON object with `config` and `language`, and `layoutVersion` and `pages` if wanted. Anything
/// else is `invalid_request`: the form never sends it, and nothing of it is repeated.
fn envelope(body: &[u8]) -> Result<Asked, ApiError> {
    let invalid = || ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_request");
    let Ok(Value::Object(mut members)) = serde_json::from_slice::<Value>(body) else {
        return Err(invalid());
    };
    let config = members.remove("config").ok_or_else(invalid)?;
    let language = match members.remove("language").ok_or_else(invalid)? {
        Value::String(name) => Language::parse(&name).ok_or_else(|| {
            ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "unsupported_language")
        })?,
        _ => return Err(invalid()),
    };
    // G6: the layout of an old version; the current one when none is named. `null` is not "none": it is not a
    // number.
    let layout_version = match members.remove("layoutVersion") {
        None => CURRENT_LAYOUT,
        Some(value) => {
            let number = value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .filter(|n| *n >= 1)
                .ok_or_else(invalid)?;
            // A version saved by a newer binary has a layout this one lacks: it is refused, never drawn with
            // another (ADR: a letterhead version pins its layout).
            if layout(number).is_none() {
                return Err(ApiError::new(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unknown_layout",
                ));
            }
            number
        }
    };
    let pages = match members.remove("pages") {
        None => None,
        Some(value) => Some(pages_of_body(&value).ok_or_else(invalid_pages)?),
    };
    if !members.is_empty() {
        return Err(invalid());
    }
    Ok(Asked {
        config,
        language,
        layout_version,
        pages,
    })
}

fn invalid_pages() -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pages")
}

/// `?pages=1,2,3`: `None` when the parameter is not there.
fn pages_of_query(uri: &Uri) -> Result<Option<PageSelection>, ApiError> {
    let Some(query) = uri.query() else {
        return Ok(None);
    };
    let parsed = Query::<PreviewQuery>::try_from_uri(
        &format!("/?{query}")
            .parse::<Uri>()
            .map_err(|_| invalid_pages())?,
    )
    .map_err(|_| invalid_pages())?;
    parsed
        .0
        .pages
        .map(|value| PageSelection::parse(&value).ok_or_else(invalid_pages))
        .transpose()
}

/// `"pages": [1, 3]`: whole numbers from 1, by the rules of the query's list.
fn pages_of_body(value: &Value) -> Option<PageSelection> {
    let numbers: Option<Vec<String>> = value
        .as_array()?
        .iter()
        .map(|n| n.as_u64().map(|n| n.to_string()))
        .collect();
    PageSelection::parse(&numbers?.join(","))
}

/// The issuer's details a preview shows (AC-5.4, plan "Configurator preview").
struct Issuer {
    /// What the sample's placeholders are given: the registry's values in the preview language, or, when the
    /// registry cannot be read, nothing at all (every placeholder is then drawn as missing).
    data: EntityData,
    /// The version of the details shown; `None` when they could not be had (`legalEntityVersion: null`).
    version: Option<i64>,
}

/// The registry's details of `entity`, under the cache rule of the render routes (T21). A preview is not a
/// document (AC-5.5 is about documents): when the details cannot be had, the preview is still made, with
/// [`EntityData::default`], every placeholder marked, and the answer says so (`issuerDetails: "unavailable"`).
async fn issuer_for_preview(app: &AppState, entity: Entity, language: Language) -> Issuer {
    match app.registry.get(entity).await {
        Ok(details) => Issuer {
            data: registry::entity_data(&details, language),
            version: Some(details.version),
        },
        Err(_) => Issuer {
            data: EntityData::default(),
            version: None,
        },
    }
}

/// The job of a preview: the sample document of `entity` in `language`, with the issuer's details `data`, laid
/// out on `config` with the layout `layout_version` (G6), in the "mark missing" mode (plan E3). The letterhead
/// version is [`UNSAVED`]: the configuration has none.
fn sample_job(
    entity: Entity,
    language: Language,
    layout_version: u32,
    config: LetterheadConfig,
    files: Assets,
    selection: PageSelection,
    data: EntityData,
) -> Result<Job, ApiError> {
    let mut document = sample::request_with(entity, language, data);
    // What reaches a worker is what the asset rules made of the image blocks, as on the render routes.
    ingest_images(&mut document).map_err(|_| internal("render_failed"))?;
    Ok(Job::new(
        document,
        LetterheadVersion {
            number: UNSAVED,
            layout_version,
            config,
        },
        files,
        Output::Preview(selection),
    )
    .marking_missing())
}

// ---------------------------------------------------------------------------------------------------------------
// The assets and the fit

/// The ids of the assets a configuration uses, each once. They are UUIDs: the validator checked the syntax.
fn distinct_ids(config: &LetterheadConfig) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> = config
        .asset_ids()
        .into_iter()
        .filter_map(|id| Uuid::try_parse(id).ok())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids
}

/// `asset_unknown` for every use of an asset that is not an uploaded asset of the entity, or is of the other
/// kind: a logo slot holding a background, or the reverse. The path is the slot, never the id.
fn asset_problems(config: &LetterheadConfig, found: &[AssetRow]) -> Vec<Problem> {
    let mut problems = Vec::new();
    let variants = [
        ("default", Some(&config.variants.default)),
        ("first", config.variants.first.as_ref()),
        ("last", config.variants.last.as_ref()),
    ];
    for (name, variant) in variants {
        let Some(variant) = variant else { continue };
        let uses = [
            (
                format!("/variants/{name}/logo/asset"),
                variant.logo.as_ref().map(|logo| logo.asset.as_str()),
                AssetKind::Logo,
            ),
            (
                format!("/variants/{name}/background"),
                variant.background.as_deref(),
                AssetKind::Background,
            ),
        ];
        for (path, id, kind) in uses {
            let Some(id) = id else { continue };
            let usable = Uuid::try_parse(id)
                .ok()
                .and_then(|id| found.iter().find(|row| row.id == id))
                .is_some_and(|row| row.kind == kind);
            if !usable {
                problems.push(Problem {
                    path,
                    reason: Reason::AssetUnknown,
                    name: None,
                    language: None,
                });
            }
        }
    }
    problems
}

// ---------------------------------------------------------------------------------------------------------------
// The answer

/// The render preview's answer, with `letterheadVersion: null`: the configuration has no version (it may be
/// unsaved). It adds `issuerDetails` (`"current"`, or `"unavailable"` when the registry could not be read) and
/// `legalEntityVersion` (the version shown, `null` when unavailable).
fn answer(meta: &Meta, pages: &[PreviewPage], legal_entity_version: Option<i64>) -> Response {
    let pages: Vec<Value> = pages
        .iter()
        .map(|page| {
            json!({
                "n": page.number,
                "image": STANDARD.encode(&page.png),
                "text": page.text,
            })
        })
        .collect();
    let body = json!({
        "letterheadVersion": Value::Null,
        "issuerDetails": if legal_entity_version.is_some() { "current" } else { "unavailable" },
        "legalEntityVersion": legal_entity_version,
        "pageCount": meta.page_count,
        "missingPlaceholders": meta.missing_placeholders,
        "unprintableCharacters": meta.unprintable_characters,
        "pages": pages,
    });
    let mut response = (StatusCode::OK, body.to_string()).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

// ---------------------------------------------------------------------------------------------------------------
// The refusals

fn internal(code: &'static str) -> ApiError {
    ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, code)
}

/// 503 with `Retry-After`: the database could not answer now.
fn unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "service_unavailable").retry_after(RETRY_SECONDS)
}

fn storage_error(error: StorageError) -> ApiError {
    match error {
        // The database and the bucket disagree, or the object is not what the row says: retrying will not mend it.
        StorageError::Missing | StorageError::Corrupt => internal("asset_unavailable"),
        StorageError::Unavailable => {
            ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "asset_unavailable")
                .retry_after(RETRY_SECONDS)
        }
    }
}

/// 422 `invalid_letterhead` with `problems` (G3): paths into the configuration, reasons from the closed list. The
/// body of a refused save.
fn invalid_letterhead(problems: Vec<Problem>) -> ApiError {
    ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_letterhead").with(
        "problems",
        serde_json::to_value(problems).unwrap_or(Value::Array(Vec::new())),
    )
}

/// What the pool says, as the render routes say it, except a frame that does not hold the sample: that is a value
/// of the form, so it is the form's refusal, at the frame (AC-5.3).
fn preview_error(error: PoolError) -> ApiError {
    if let PoolError::Refused(refusal) = &error {
        let reason = match refusal.code.as_str() {
            "header_overflow" => Some(Reason::HeaderOverflow),
            "footer_overflow" => Some(Reason::FooterOverflow),
            _ => None,
        };
        if let Some(reason) = reason {
            return invalid_letterhead(vec![Problem {
                path: refusal.path.clone().unwrap_or_default(),
                reason,
                name: None,
                language: None,
            }]);
        }
        // Another refusal (`invalid_pages`, `too_many_pages`): the render routes' answer.
        return refusal_error(refusal);
    }
    pool_error(error)
}

// ---------------------------------------------------------------------------------------------------------------
// The body

/// `Content-Length`, if the request has a valid one.
fn declared_length(request: &Request) -> Option<u64> {
    request
        .headers()
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

fn too_large() -> ApiError {
    ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "request_too_large")
}

/// Reads and throws away what a client is still sending, up to [`BODY_MAX`] plus [`DRAIN_EXTRA`] and for at most
/// [`BODY_TIMEOUT`].
async fn drain(mut body: Body) {
    let reading = async {
        let mut seen = 0usize;
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(data) = frame.into_data() {
                seen += data.len();
                if seen > BODY_MAX + DRAIN_EXTRA {
                    break;
                }
            }
        }
    };
    let _ = tokio::time::timeout(BODY_TIMEOUT, reading).await;
}

/// The body, at most [`BODY_MAX`] bytes and within [`BODY_TIMEOUT`]: 413 past the size, 408 past the time, 400
/// when the connection broke while the caller was sending.
async fn read_body(request: Request) -> Result<Vec<u8>, ApiError> {
    let declared = declared_length(&request);
    let mut body = request.into_body();
    if declared.is_some_and(|length| length > BODY_MAX as u64) {
        tokio::spawn(drain(body));
        return Err(too_large());
    }
    enum Unread {
        TooLarge,
        TimedOut,
        Aborted,
    }
    let capacity = declared.map_or(0, |length| length.min(BODY_MAX as u64) as usize);
    let reading = async {
        let mut bytes: Vec<u8> = Vec::with_capacity(capacity);
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Unread::Aborted)?;
            if let Ok(data) = frame.into_data() {
                if bytes.len() + data.len() > BODY_MAX {
                    return Err(Unread::TooLarge);
                }
                bytes.extend_from_slice(&data);
            }
        }
        Ok(bytes)
    };
    let read = tokio::time::timeout(BODY_TIMEOUT, reading)
        .await
        .unwrap_or(Err(Unread::TimedOut));
    match read {
        Ok(bytes) => Ok(bytes),
        Err(Unread::TooLarge) => {
            tokio::spawn(drain(body));
            Err(too_large())
        }
        Err(Unread::TimedOut) => Err(ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "request_timeout",
        )),
        Err(Unread::Aborted) => Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request")),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn asked(body: Value) -> Result<Asked, ApiError> {
        envelope(body.to_string().as_bytes())
    }

    fn refused(body: Value) -> (StatusCode, &'static str) {
        let error = asked(body).err().expect("a refusal");
        (error.status(), error.code())
    }

    #[test]
    fn a_body_with_a_configuration_and_a_language_is_a_request_for_the_current_layout() {
        let ok = asked(json!({ "config": {}, "language": "en" })).expect("a request");
        assert_eq!(ok.language, Language::En);
        assert_eq!(ok.layout_version, CURRENT_LAYOUT);
        assert!(ok.pages.is_none());
    }

    #[test]
    fn the_layout_version_is_a_known_layout_or_a_refusal() {
        let ok = asked(json!({ "config": {}, "language": "it", "layoutVersion": 1 })).expect("ok");
        assert_eq!(ok.layout_version, 1);
        for unknown in [json!(900), json!(999_999)] {
            assert_eq!(
                refused(json!({ "config": {}, "language": "it", "layoutVersion": unknown })),
                (StatusCode::UNPROCESSABLE_ENTITY, "unknown_layout")
            );
        }
        for not_a_layout in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("1"),
            json!(null),
            json!(true),
            json!(4_294_967_297u64),
        ] {
            assert_eq!(
                refused(json!({ "config": {}, "language": "it", "layoutVersion": not_a_layout })),
                (StatusCode::UNPROCESSABLE_ENTITY, "invalid_request"),
                "{not_a_layout}"
            );
        }
    }

    #[test]
    fn a_language_is_it_or_en() {
        assert_eq!(
            refused(json!({ "config": {}, "language": "fr" })),
            (StatusCode::UNPROCESSABLE_ENTITY, "unsupported_language")
        );
        for wrong in [json!(null), json!(1), json!(["it"])] {
            assert_eq!(
                refused(json!({ "config": {}, "language": wrong })),
                (StatusCode::UNPROCESSABLE_ENTITY, "invalid_request")
            );
        }
    }

    #[test]
    fn a_missing_or_extra_member_or_a_body_that_is_not_an_object_is_invalid_request() {
        let invalid = (StatusCode::UNPROCESSABLE_ENTITY, "invalid_request");
        assert_eq!(refused(json!({ "language": "it" })), invalid);
        assert_eq!(refused(json!({ "config": {} })), invalid);
        assert_eq!(
            refused(json!({ "config": {}, "language": "it", "baseVersion": 1 })),
            invalid
        );
        assert_eq!(refused(json!([1])), invalid);
        assert_eq!(
            envelope(b"not json").err().map(|e| e.code()),
            Some("invalid_request")
        );
    }

    #[test]
    fn pages_in_the_body_follow_the_rules_of_the_query() {
        let ok = asked(json!({ "config": {}, "language": "it", "pages": [3, 1, 3] })).expect("ok");
        assert_eq!(ok.pages, Some(PageSelection::Pages(vec![1, 3])));
        for bad in [
            json!([]),
            json!([0]),
            json!([301]),
            json!([1.5]),
            json!(["1"]),
            json!("1,2"),
            json!(null),
        ] {
            assert_eq!(
                refused(json!({ "config": {}, "language": "it", "pages": bad })),
                (StatusCode::UNPROCESSABLE_ENTITY, "invalid_pages"),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_query_names_pages_or_is_refused() {
        let at = |q: &str| pages_of_query(&format!("/x?{q}").parse::<Uri>().expect("uri"));
        assert_eq!(at("other=1").expect("ok"), None);
        assert_eq!(
            at("pages=2,1").expect("ok"),
            Some(PageSelection::Pages(vec![1, 2]))
        );
        for bad in [
            "pages=0",
            "pages=x",
            "pages=",
            "pages=1&pages=2",
            "pages=301",
        ] {
            assert_eq!(
                at(bad).err().map(|e| e.code()),
                Some("invalid_pages"),
                "{bad}"
            );
        }
    }

    #[test]
    fn an_overflow_of_the_sample_is_the_forms_refusal_at_the_frame() {
        use crate::pool::job::Refusal;
        let error = preview_error(PoolError::Refused(Refusal {
            code: "footer_overflow".to_owned(),
            path: Some("/variants/default/footer".to_owned()),
            reason: None,
        }));
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error.code(), "invalid_letterhead");
        let other = preview_error(PoolError::Refused(Refusal {
            code: "invalid_pages".to_owned(),
            path: None,
            reason: None,
        }));
        assert_eq!(other.code(), "invalid_pages");
        assert_eq!(
            preview_error(PoolError::Timeout).status(),
            StatusCode::GATEWAY_TIMEOUT
        );
    }

    #[test]
    fn the_job_carries_the_layout_asked_for_the_unsaved_number_the_language_and_the_pages() {
        let job = |layout_version, language| {
            sample_job(
                Entity::WelldCh,
                language,
                layout_version,
                letterhead_engine::config::default_config(),
                Assets::new(),
                PageSelection::Pages(vec![2]),
                EntityData {
                    legal_name: Some("Registry SA".to_owned()),
                    ..EntityData::default()
                },
            )
            .expect("a job")
        };
        for layout in [1, 7, 42] {
            let built = job(layout, Language::En);
            let (header, assets) = built.encode().expect("encoded");
            let header: Value = serde_json::from_slice(&header).expect("json");
            assert_eq!(header["version"]["layout_version"], layout);
            assert_eq!(header["version"]["number"], 0, "no letterhead version");
            assert_eq!(header["request"]["language"], "en");
            assert_eq!(header["request"]["entity"], "welld_ch");
            // The registry's data, not the sample's: and the mark mode travels with the job.
            assert_eq!(header["request"]["entityData"]["legalName"], "Registry SA");
            assert_eq!(header["mark_missing"], true);
            assert_eq!(header["output"]["pages"], json!([2]));
            assert!(assets.is_empty());
        }
        let built = job(1, Language::It);
        let (header, _) = built.encode().expect("encoded");
        let header: Value = serde_json::from_slice(&header).expect("json");
        assert_eq!(header["request"]["language"], "it");
    }

    /// A job as the render routes make theirs (`Job::new`), whatever its output.
    fn render_route_job(output: Output) -> Job {
        Job::new(
            sample::request(Entity::WelldIt, Language::It),
            LetterheadVersion {
                number: 1,
                layout_version: 1,
                config: letterhead_engine::config::default_config(),
            },
            Assets::new(),
            output,
        )
    }

    /// Plan E3: the "mark missing" mode is the configurator preview's alone. A job made as the render routes make
    /// theirs has no such member on the wire, for a PDF or for a preview, and the worker reads it as not marking.
    #[test]
    fn a_render_routes_job_never_has_the_mark_on_the_wire() {
        use crate::pool::job::decode_job;
        for output in [Output::Pdf, Output::Preview(PageSelection::All)] {
            let (bytes, _) = render_route_job(output).encode().expect("encoded");
            let header: Value = serde_json::from_slice(&bytes).expect("json");
            assert!(
                header.get("mark_missing").is_none(),
                "the header is what it was before the mode: {header}"
            );
            assert!(!decode_job(vec![bytes]).expect("decoded").mark_missing);
        }
    }

    #[test]
    fn the_mark_travels_with_the_previews_job_to_the_worker() {
        use crate::pool::job::decode_job;
        let job = sample_job(
            Entity::WelldIt,
            Language::En,
            1,
            letterhead_engine::config::default_config(),
            Assets::new(),
            PageSelection::All,
            EntityData::default(),
        )
        .expect("a job");
        let (bytes, _) = job.encode().expect("encoded");
        let decoded = decode_job(vec![bytes]).expect("decoded");
        assert!(decoded.mark_missing);
        assert_eq!(decoded.output, Output::Preview(PageSelection::All));
        assert_eq!(
            decoded.request.expect("a request").entity_data,
            EntityData::default(),
            "the registry's values, here none: every placeholder missing"
        );
    }

    /// A PDF, or a fit check, that asks for the mark is a fault on either side of the wire: a document never
    /// carries `⟦ ⟧`.
    #[test]
    fn a_pdf_or_a_fit_check_with_the_mark_is_neither_encoded_nor_decoded() {
        use crate::pool::job::decode_job;
        assert!(
            render_route_job(Output::Pdf)
                .marking_missing()
                .encode()
                .is_err()
        );
        let fit = || {
            Job::fit(
                1,
                letterhead_engine::config::default_config(),
                Assets::new(),
            )
        };
        assert!(fit().marking_missing().encode().is_err());
        for job in [render_route_job(Output::Pdf), fit()] {
            let (bytes, _) = job.encode().expect("encoded");
            let mut header: Value = serde_json::from_slice(&bytes).expect("json");
            header["mark_missing"] = json!(true);
            assert!(decode_job(vec![header.to_string().into_bytes()]).is_err());
        }
    }
}
