//! The service routes (task T12; AC-1.1, 1.2, 3.1 to 3.3, 3.6, 3.8, 4.4, 9.1):
//!
//! - `POST /v1/render/preview?pages=1,2,3` → the page count, the placeholders that had no value and, for each
//!   page asked for, its 64-colour PNG and its text;
//! - `POST /v1/render/pdf` → the PDF, with the version and the counts in headers;
//! - `GET /v1/letterheads/status` → the active version of each entity (the CRM's switch check, AC-10.12).
//!
//! The order of a render, and why (plan § Sequences, amendment 2026-11-17 item "request admission"):
//!
//! 1. **Who** (the layer in front of these handlers): a service credential, or the one 401.
//! 2. **A place** in the pool, before the body is read. The pool says `busy` (429, `Retry-After`) at once when
//!    the caller's share is taken, so a request that will be turned away costs no memory, and the number of
//!    20 MiB bodies held at once is the pool's size plus its queue, not the number of connections.
//! 3. **The body**, at most 20 MiB (413), within a deadline (408). A body that is declared too big takes no place
//!    and is not kept: the 413 is answered at once and what the client is still sending is read and thrown away
//!    in the background, up to a bound, so that the answer reaches a client that has not finished sending.
//! 4. **The content**, on a blocking thread (parsing 20 MiB is not work for the async threads): validation
//!    (422), then the asset rules over every image block (422 at `/blocks/<i>/data`). Only the rebuilt bytes of
//!    an SVG go on.
//! 5. **The issuer's details** (T22; AC-5.1 to 5.3, 5.5): the registry's values for the entity, in the request's
//!    language, replace whatever `entityData` the request held (both content versions). 503
//!    `legal_entities_unavailable` when they cannot be had within the cache rule; 409
//!    `legal_entity_version_mismatch` when the request's `legalEntityVersion` pin is not the version in use after
//!    one refresh (a refresh forced by a pin happens at most once per second per process). The answer says which version it printed (`legalEntityVersion` / `Legal-Entity-Version`).
//! 6. **The letterhead version**: named (404 if it does not exist) or the active one (409 if none), and its
//!    assets from the bucket. Never a fallback to another version, another entity or a plain page (AC-4.4).
//! 7. **The worker**, which lays the document out and is killed at the deadline.
//!
//! Nothing of the document is kept: the body, the request and the result live in this function and are dropped
//! when it returns (AC-3.7). The log line has no content in it (see `log.rs`), and no answer repeats any.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    body::Body,
    extract::{Extension, Query, Request, State},
    http::{HeaderName, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http_body_util::BodyExt as _;
use serde::Deserialize;
use serde_json::{Value, json};

use letterhead_engine::config::LetterheadConfig;
use letterhead_engine::content::{
    Entity, EntityData, Rejection, RenderRequest, ingest_images, parse_request,
};
use letterhead_engine::layout::Assets;
use letterhead_engine::output::PageSelection;
use letterhead_engine::render::{LetterheadVersion, MAX_PAGES, PreviewPage};

use super::{ApiError, AppState};
use crate::auth::service::Caller;
use crate::db::VersionRow;
use crate::log::Facts;
use crate::pool::job::{Body as JobBody, Job, JobOutput, Meta, Output, Refusal};
use crate::pool::{Permit, PoolError};
use crate::registry::{self, LEGAL_ENTITIES_UNAVAILABLE, LegalEntityDetails, RETRY_AFTER_SECONDS};
use crate::storage::StorageError;

/// AC-3.3: a request body larger than this is refused with 413.
pub const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;
/// How long a caller has to send its body, from the moment it holds a place in the pool. 20 MiB between two
/// services of the suite takes a fraction of this; a caller that is slower than 1.4 MB/s is holding a worker that
/// others are waiting for.
const BODY_TIMEOUT: Duration = Duration::from_secs(15);
/// How much more of an oversized body is read and thrown away before the 413, so that a client that is still
/// sending gets the answer instead of a closed connection.
const DRAIN_BYTES: usize = MAX_BODY_BYTES + 1024 * 1024;
/// `Retry-After` of a 503: a worker is being replaced, a bucket is slow.
const UNAVAILABLE_RETRY_SECONDS: u64 = 2;

// ---------------------------------------------------------------------------------------------------------------
// Handlers

#[derive(Debug, Deserialize)]
struct PreviewQuery {
    pages: Option<String>,
}

/// `POST /v1/render/preview`
pub async fn preview(
    State(app): State<AppState>,
    Extension(caller): Extension<Caller>,
    request: Request,
) -> Response {
    let mut facts = Facts {
        caller: Some(caller.0.clone()),
        ..Facts::default()
    };
    let selection = match pages_of(request.uri()) {
        Ok(selection) => selection,
        Err(error) => return error.respond(facts),
    };
    finish(
        serve(
            &app,
            &caller,
            request,
            Output::Preview(selection),
            &mut facts,
        )
        .await,
        facts,
    )
}

/// `POST /v1/render/pdf`
pub async fn pdf(
    State(app): State<AppState>,
    Extension(caller): Extension<Caller>,
    request: Request,
) -> Response {
    let mut facts = Facts {
        caller: Some(caller.0.clone()),
        ..Facts::default()
    };
    finish(
        serve(&app, &caller, request, Output::Pdf, &mut facts).await,
        facts,
    )
}

/// `GET /v1/letterheads/status`: `{ "welld_it": { "activeVersion": 3 }, "welld_ch": null }`.
pub async fn status(State(app): State<AppState>, Extension(caller): Extension<Caller>) -> Response {
    let mut facts = Facts {
        caller: Some(caller.0),
        ..Facts::default()
    };
    match app.repo.active_versions().await {
        Ok(active) => {
            let mut body = serde_json::Map::new();
            for entity in Entity::ALL {
                let version = active.iter().find(|(e, _)| *e == entity).map(|(_, v)| *v);
                body.insert(
                    entity.as_str().to_owned(),
                    version.map_or(Value::Null, |v| json!({ "activeVersion": v })),
                );
            }
            facts.outcome = Some("ok");
            let mut response = axum::Json(Value::Object(body)).into_response();
            response.extensions_mut().insert(facts);
            response
        }
        Err(_) => database_unavailable().respond(facts),
    }
}

fn finish(result: Result<Response, ApiError>, mut facts: Facts) -> Response {
    match result {
        Ok(mut response) => {
            facts.outcome = Some("ok");
            response.extensions_mut().insert(facts);
            response
        }
        Err(error) => error.respond(facts),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// One render

async fn serve(
    app: &AppState,
    caller: &Caller,
    request: Request,
    output: Output,
    facts: &mut Facts,
) -> Result<Response, ApiError> {
    // 2. A place, or the 429, before anything is read. A body that says it is too big takes no place.
    let declared = declared_length(&request);
    if declared.is_some_and(|length| length > MAX_BODY_BYTES as u64) {
        tokio::spawn(drain(request.into_body()));
        return Err(too_large());
    }
    // A preview may not take the slot that is kept for PDFs (T48); a PDF may take any.
    let permit = match output {
        Output::Pdf => app.pool.admit(&caller.0),
        _ => app.pool.admit_interactive(&caller.0),
    }
    .map_err(pool_error)?;

    // 3. The body.
    let body = read_body(request.into_body(), declared).await?;

    // 4. The content, off the async threads.
    let content = tokio::task::spawn_blocking(move || prepare(&body))
        .await
        .map_err(|_| internal("render_failed"))?
        .map_err(rejection_error)?;
    facts.entity = Some(content.entity.as_str());

    // The `entityData` of the request is parsed for its shape and then thrown away, in both content versions
    // (AC-5.2): a caller does not choose the issuer a document prints.
    facts.entity_data_ignored = Some(content.entity_data != EntityData::default());

    // 5. The issuer's details, from the registry under the cache rule: 503 when they cannot be had, 409 when the
    // caller's pin is not the version in use. Before the letterhead's assets are read and before any worker job.
    let mut content = content;
    let issuer = issuer_details(app, &content, facts).await?;
    content.entity_data = registry::entity_data(&issuer, content.language);

    // 6. The version and its assets.
    let (version, assets) = load_version(app, &content).await?;

    // 7. The worker.
    let rendered = run(permit, Job::new(content, version, assets, output.clone())).await?;
    facts.pages = Some(rendered.meta.page_count);
    Ok(answer(rendered, issuer.version))
}

/// The issuer's details a document of `content` prints, and the check of its `legalEntityVersion` pin (plan decision
/// 8: one document, one version of the details).
///
/// The cache gives the entity's details (fresh for 30 s, a stale entry for 60 s when `auth` fails, else
/// `legal_entities_unavailable`). A pin that is not the version held is read as "the caller saw something else":
/// the entry is dropped and read again, once, but at most once per second per process (a caller cannot make every
/// request a call to `auth`; inside that second the held entry answers). Still different: 409 `legal_entity_version_mismatch` with the version
/// in use, and the caller (crm-api) rebuilds its content and retries once. A pin that matches costs no call.
async fn issuer_details(
    app: &AppState,
    content: &RenderRequest,
    facts: &mut Facts,
) -> Result<Arc<LegalEntityDetails>, ApiError> {
    let mut details = app
        .registry
        .get(content.entity)
        .await
        .map_err(|_| registry_unavailable())?;
    if let Some(pin) = content.legal_entity_version
        && i64::from(pin) != details.version
    {
        // At most one forced read per second per process (F6): inside that second, or when the entry is that
        // young, nothing is dropped and the read below is the held entry (no call) or the refresh in flight.
        app.registry.refresh_for_pin();
        details = app
            .registry
            .get(content.entity)
            .await
            .map_err(|_| registry_unavailable())?;
        if i64::from(pin) != details.version {
            facts.legal_entity_version = Some(details.version);
            return Err(
                ApiError::new(StatusCode::CONFLICT, "legal_entity_version_mismatch")
                    .with("currentVersion", json!(details.version)),
            );
        }
    }
    facts.legal_entity_version = Some(details.version);
    Ok(details)
}

/// 503 `legal_entities_unavailable` with `Retry-After: 5` (AC-5.5): no document is made from details older than 60 s.
fn registry_unavailable() -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, LEGAL_ENTITIES_UNAVAILABLE)
        .retry_after(RETRY_AFTER_SECONDS)
}

/// What the supervisor does with the bytes of a request before it takes a worker.
fn prepare(body: &[u8]) -> Result<RenderRequest, Rejection> {
    let mut request = parse_request(body)?;
    ingest_images(&mut request)?;
    Ok(request)
}

async fn run(permit: Permit, job: Job) -> Result<JobOutput, ApiError> {
    permit.run(job).await.map_err(pool_error)
}

/// The letterhead version a request names, or the entity's active one, with the bytes of its assets.
async fn load_version(
    app: &AppState,
    content: &RenderRequest,
) -> Result<(LetterheadVersion, Assets), ApiError> {
    let entity = content.entity;
    let found = match content.letterhead_version {
        Some(number) => app.repo.version(entity, number).await,
        None => app.repo.active_version(entity).await,
    }
    .map_err(|_| database_unavailable())?;
    let row = found.ok_or_else(|| match content.letterhead_version {
        Some(_) => ApiError::new(StatusCode::NOT_FOUND, "letterhead_version_not_found"),
        None => ApiError::new(StatusCode::CONFLICT, "letterhead_not_configured"),
    })?;

    let linked = app
        .repo
        .version_assets(entity, row.version)
        .await
        .map_err(|_| database_unavailable())?;
    let mut assets = Assets::new();
    for asset in &linked {
        let bytes = app.storage.asset(asset).await.map_err(storage_error)?;
        assets.insert(asset.id.to_string(), bytes.as_slice().to_vec());
    }
    Ok((version_of(row)?, assets))
}

/// The engine's view of a stored version. Stored configurations are read by shape only, never re-validated
/// against today's save rules: a restored version is valid for its own layout (AC-4.2, AC-4.5).
fn version_of(row: VersionRow) -> Result<LetterheadVersion, ApiError> {
    let layout_version =
        u32::try_from(row.layout_version).map_err(|_| stored_version_unusable())?;
    let config: LetterheadConfig =
        serde_json::from_value(row.config).map_err(|_| stored_version_unusable())?;
    Ok(LetterheadVersion {
        number: row.version,
        layout_version,
        config,
    })
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

/// Reads and throws away what a client is still sending, up to [`DRAIN_BYTES`] and for at most [`BODY_TIMEOUT`].
async fn drain(mut body: Body) {
    let reading = async {
        let mut seen = 0usize;
        while let Some(Ok(frame)) = body.frame().await {
            if let Ok(data) = frame.into_data() {
                seen += data.len();
                if seen > DRAIN_BYTES {
                    break;
                }
            }
        }
    };
    let _ = tokio::time::timeout(BODY_TIMEOUT, reading).await;
}

/// Why a body was not read.
enum Unread {
    TooLarge,
    TimedOut,
    /// The connection broke while the caller was sending.
    Aborted,
}

/// The body, at most [`MAX_BODY_BYTES`] and within [`BODY_TIMEOUT`]: 413 past the size, 408 past the time.
async fn read_body(mut body: Body, declared: Option<u64>) -> Result<Vec<u8>, ApiError> {
    let capacity = declared.map_or(0, |length| length.min(MAX_BODY_BYTES as u64) as usize);
    let reading = async {
        let mut bytes: Vec<u8> = Vec::with_capacity(capacity);
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|_| Unread::Aborted)?;
            if let Ok(data) = frame.into_data() {
                if bytes.len() + data.len() > MAX_BODY_BYTES {
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
            // The answer goes now; what is still coming is read and dropped, within bounds.
            tokio::spawn(drain(body));
            Err(too_large())
        }
        Err(Unread::TimedOut) => Err(ApiError::new(
            StatusCode::REQUEST_TIMEOUT,
            "request_timeout",
        )),
        // A connection that broke while sending has no one to answer: the log says so.
        Err(Unread::Aborted) => {
            Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request").outcome("body_aborted"))
        }
    }
}

/// The pages of `?pages=1,2,3`; all of them when there is no such parameter.
fn pages_of(uri: &Uri) -> Result<PageSelection, ApiError> {
    let invalid = || ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "invalid_pages");
    let Some(query) = uri.query() else {
        return Ok(PageSelection::All);
    };
    let parsed = Query::<PreviewQuery>::try_from_uri(
        // `try_from_uri` reads the query of an absolute or relative URI; ours is relative.
        &format!("/?{query}").parse::<Uri>().map_err(|_| invalid())?,
    )
    .map_err(|_| invalid())?;
    match parsed.0.pages {
        None => Ok(PageSelection::All),
        Some(value) => PageSelection::parse(&value).ok_or_else(invalid),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The answers

fn answer(rendered: JobOutput, legal_entity_version: i64) -> Response {
    let JobOutput { meta, body } = rendered;
    match body {
        JobBody::Pdf(pdf) => pdf_response(&meta, legal_entity_version, pdf),
        JobBody::Preview(pages) => preview_response(&meta, legal_entity_version, &pages),
        // A document job never answers with a fit check's problems: a fault of the pool.
        JobBody::Fit(_) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "render_failed")
            .respond(Facts::default()),
    }
}

fn pdf_response(meta: &Meta, legal_entity_version: i64, pdf: Vec<u8>) -> Response {
    let mut response = (StatusCode::OK, pdf).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    let numbers: [(&'static str, String); 4] = [
        ("letterhead-version", meta.letterhead_version.to_string()),
        ("legal-entity-version", legal_entity_version.to_string()),
        ("page-count", meta.page_count.to_string()),
        (
            "unprintable-characters",
            meta.unprintable_characters.to_string(),
        ),
    ];
    for (name, value) in numbers {
        if let Ok(value) = HeaderValue::from_str(&value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
    // Names of placeholders from the closed list (`legal_name`, `iban`, ...), comma separated; empty if none.
    if let Ok(value) = HeaderValue::from_str(&meta.missing_placeholders.join(",")) {
        headers.insert(HeaderName::from_static("missing-placeholders"), value);
    }
    response
}

fn preview_response(meta: &Meta, legal_entity_version: i64, pages: &[PreviewPage]) -> Response {
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
        "letterheadVersion": meta.letterhead_version,
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

fn stored_version_unusable() -> ApiError {
    internal("render_failed").outcome("stored_version_unusable")
}

fn database_unavailable() -> ApiError {
    unavailable("db_unavailable")
}

/// 503 `render_unavailable` with `Retry-After`: the service could not do this now. What exactly goes to the log.
fn unavailable(outcome: &'static str) -> ApiError {
    ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "render_unavailable")
        .outcome(outcome)
        .retry_after(UNAVAILABLE_RETRY_SECONDS)
}

fn storage_error(error: StorageError) -> ApiError {
    match error {
        // The database and the bucket disagree: retrying will not mend it.
        StorageError::Missing => internal("render_failed").outcome("asset_missing"),
        StorageError::Corrupt => internal("render_failed").outcome("asset_corrupt"),
        StorageError::Unavailable => unavailable("storage_unavailable"),
    }
}

/// Orchestrator note 2026-11-17: `Busy` is 429, `Timeout` 504; a worker that ran out of memory, died, or could
/// not be started is a 503 with `Retry-After: 2`, which the plan's error table has no row for.
pub fn pool_error(error: PoolError) -> ApiError {
    match error {
        PoolError::Busy { retry_after } => ApiError::new(StatusCode::TOO_MANY_REQUESTS, "busy")
            .retry_after(retry_after.as_secs().max(1)),
        PoolError::Timeout => ApiError::new(StatusCode::GATEWAY_TIMEOUT, "render_timeout"),
        PoolError::MemoryExceeded => unavailable("render_memory_exceeded"),
        PoolError::WorkerFailed => unavailable("worker_failed"),
        PoolError::Unavailable => unavailable("worker_unavailable"),
        PoolError::Refused(refusal) => refusal_error(&refusal),
    }
}

/// An engine refusal, as the plan's error table has it. Only a code and a pointer travel (see `Refusal`).
pub fn refusal_error(refusal: &Refusal) -> ApiError {
    let unprocessable = |code: &'static str| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, code);
    match refusal.code.as_str() {
        "invalid_content" => {
            let problems: Vec<Value> = refusal
                .path
                .iter()
                .map(|path| json!({ "path": path, "reason": refusal.reason }))
                .collect();
            unprocessable("invalid_content").with("problems", Value::Array(problems))
        }
        code @ ("header_overflow" | "footer_overflow") => {
            let code = if code == "header_overflow" {
                "header_overflow"
            } else {
                "footer_overflow"
            };
            let error = unprocessable(code);
            match &refusal.path {
                Some(path) => error.with("path", json!(path)),
                None => error,
            }
        }
        "too_many_pages" => unprocessable("too_many_pages")
            .with("limit", json!({ "name": "pages", "max": MAX_PAGES })),
        "invalid_pages" => unprocessable("invalid_pages"),
        // A stored version that does not lay out, a layout this binary lacks, a fault of the engine: the
        // service's, not the caller's. The engine's detail never leaves the worker.
        "unknown_layout" => internal("render_failed").outcome("unknown_layout"),
        "invalid_letterhead" => internal("render_failed").outcome("invalid_letterhead"),
        _ => internal("render_failed"),
    }
}

/// A request the content rules refuse (AC-1.7, 1.8, 3.3, 3.6, 4.9): 422, a code, and where, never what.
pub fn rejection_error(rejection: Rejection) -> ApiError {
    let error = ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, rejection.code());
    match &rejection {
        Rejection::InvalidContent(problems) => error.with(
            "problems",
            serde_json::to_value(problems).unwrap_or(Value::Array(Vec::new())),
        ),
        Rejection::ContentTooLarge(limit) => {
            error.with("limit", serde_json::to_value(limit).unwrap_or(Value::Null))
        }
        _ => error,
    }
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use letterhead_engine::content::{Limit, Problem, Reason};

    use super::*;

    async fn shown(error: ApiError) -> (StatusCode, Option<String>, Value) {
        let response = error.into_response();
        let status = response.status();
        let retry = response
            .headers()
            .get(header::RETRY_AFTER)
            .map(|v| v.to_str().expect("ascii").to_owned());
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body");
        (status, retry, serde_json::from_slice(&body).expect("json"))
    }

    #[tokio::test]
    async fn every_pool_error_has_its_status_and_code() {
        let busy = shown(pool_error(PoolError::Busy {
            retry_after: Duration::from_secs(2),
        }))
        .await;
        assert_eq!(busy.0, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(busy.1.as_deref(), Some("2"));
        assert_eq!(busy.2["code"], "busy");

        let timeout = shown(pool_error(PoolError::Timeout)).await;
        assert_eq!(timeout.0, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(timeout.1, None);
        assert_eq!(timeout.2["code"], "render_timeout");

        for (error, outcome) in [
            (PoolError::MemoryExceeded, "render_memory_exceeded"),
            (PoolError::WorkerFailed, "worker_failed"),
            (PoolError::Unavailable, "worker_unavailable"),
        ] {
            let mapped = pool_error(error);
            assert_eq!(mapped.outcome_code(), outcome);
            let (status, retry, body) = shown(mapped).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(retry.as_deref(), Some("2"));
            assert_eq!(body["code"], "render_unavailable");
        }
    }

    #[tokio::test]
    async fn a_busy_pool_never_says_retry_after_zero() {
        let (_, retry, _) = shown(pool_error(PoolError::Busy {
            retry_after: Duration::from_millis(300),
        }))
        .await;
        assert_eq!(retry.as_deref(), Some("1"));
    }

    fn refusal(code: &str, path: Option<&str>, reason: Option<&str>) -> Refusal {
        Refusal {
            code: code.to_owned(),
            path: path.map(str::to_owned),
            reason: reason.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn an_engine_refusal_is_a_422_with_its_pointer_and_nothing_else() {
        let (status, _, body) = shown(refusal_error(&refusal(
            "footer_overflow",
            Some("/variants/default/footer"),
            None,
        )))
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["code"], "footer_overflow");
        assert_eq!(body["path"], "/variants/default/footer");

        let (_, _, body) = shown(refusal_error(&refusal(
            "header_overflow",
            Some("/variants/first/header"),
            None,
        )))
        .await;
        assert_eq!(body["code"], "header_overflow");

        let (status, _, body) = shown(refusal_error(&refusal("too_many_pages", None, None))).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["code"], "too_many_pages");
        assert_eq!(body["limit"], json!({ "name": "pages", "max": 300 }));

        let (_, _, body) = shown(refusal_error(&refusal(
            "invalid_content",
            Some("/blocks/3/data"),
            Some("svg_script"),
        )))
        .await;
        assert_eq!(
            body["problems"],
            json!([{ "path": "/blocks/3/data", "reason": "svg_script" }])
        );

        let (status, _, body) = shown(refusal_error(&refusal("invalid_pages", None, None))).await;
        assert_eq!(
            (status, body["code"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid_pages"))
        );
    }

    #[tokio::test]
    async fn a_fault_of_the_engine_or_of_a_stored_version_is_a_500_without_detail() {
        for code in [
            "render_failed",
            "unknown_layout",
            "invalid_letterhead",
            "something_new",
        ] {
            let (status, retry, body) =
                shown(refusal_error(&refusal(code, Some("/x"), Some("y")))).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{code}");
            assert_eq!(retry, None);
            assert_eq!(body["code"], "render_failed");
            assert!(
                body.get("path").is_none() && body.get("problems").is_none(),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn the_content_rules_become_422s_that_name_where_and_which_limit() {
        let (status, _, body) = shown(rejection_error(Rejection::InvalidContent(vec![Problem {
            path: "/blocks/12/runs/0".into(),
            reason: Reason::UnknownStyle,
        }])))
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["code"], "invalid_content");
        assert_eq!(
            body["problems"],
            json!([{ "path": "/blocks/12/runs/0", "reason": "unknown_style" }])
        );

        let (_, _, body) = shown(rejection_error(Rejection::ContentTooLarge(Limit::BLOCKS))).await;
        assert_eq!(body["code"], "content_too_large");
        assert_eq!(body["limit"], json!({ "name": "blocks", "max": 5000 }));

        for (rejection, code) in [
            (
                Rejection::UnsupportedContentVersion,
                "unsupported_content_version",
            ),
            (Rejection::UnsupportedLanguage, "unsupported_language"),
            (Rejection::UnknownEntity, "unknown_entity"),
        ] {
            let (status, _, body) = shown(rejection_error(rejection)).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(body["code"], code);
        }
    }

    #[tokio::test]
    async fn a_storage_failure_is_a_503_when_it_may_pass_and_a_500_when_it_will_not() {
        let (status, retry, body) = shown(storage_error(StorageError::Unavailable)).await;
        assert_eq!(
            (status, retry.as_deref()),
            (StatusCode::SERVICE_UNAVAILABLE, Some("2"))
        );
        assert_eq!(body["code"], "render_unavailable");
        for error in [StorageError::Missing, StorageError::Corrupt] {
            let (status, retry, body) = shown(storage_error(error)).await;
            assert_eq!((status, retry), (StatusCode::INTERNAL_SERVER_ERROR, None));
            assert_eq!(body["code"], "render_failed");
        }
    }

    #[test]
    fn the_pages_parameter_is_read_and_a_bad_one_is_refused() {
        let pages =
            |query: &str| pages_of(&format!("/v1/render/preview{query}").parse().expect("uri"));
        assert_eq!(pages("").expect("all"), PageSelection::All);
        assert_eq!(pages("?other=1").expect("all"), PageSelection::All);
        assert_eq!(
            pages("?pages=2").expect("one"),
            PageSelection::Pages(vec![2])
        );
        assert_eq!(
            pages("?pages=3,1,3").expect("sorted, once each"),
            PageSelection::Pages(vec![1, 3])
        );
        // What a browser's URLSearchParams writes for a comma.
        assert_eq!(
            pages("?pages=1%2C2").expect("encoded comma"),
            PageSelection::Pages(vec![1, 2])
        );
        for bad in [
            "?pages=",
            "?pages=0",
            "?pages=x",
            "?pages=1,,2",
            "?pages=301",
            "?pages=1&pages=2",
            "?pages=-1",
        ] {
            let error = pages(bad).expect_err(bad);
            assert_eq!(error.code(), "invalid_pages", "{bad}");
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }

    /// `prepare` is what the handler runs on the body before it takes a worker: the content rules, then the asset
    /// rules over the images. These tests call it without any pool, so they show that a refused image is refused
    /// here, and that what goes on to the worker is the rebuilt SVG and not the caller's bytes.
    mod prepare {
        use letterhead_engine::assets;
        use letterhead_engine::content::Block;

        use super::*;

        const SVG: &str = "<?xml version=\"1.0\"?><!-- editor --><svg xmlns=\"http://www.w3.org/2000/svg\" \
            width=\"10\" height=\"10\"><rect width=\"10\" height=\"10\"/></svg>";

        fn body(blocks: Value) -> Vec<u8> {
            json!({ "contentVersion": 1, "entity": "welld_it", "language": "en", "blocks": blocks })
                .to_string()
                .into_bytes()
        }

        fn image(bytes: &[u8]) -> Value {
            json!({ "type": "image", "data": STANDARD.encode(bytes) })
        }

        #[test]
        fn a_refused_image_is_refused_before_any_worker_is_asked() {
            let script =
                br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script/></svg>"#;
            let refused = prepare(&body(json!([
                { "type": "pageBreak" },
                image(script)
            ])))
            .expect_err("a script");
            let error = rejection_error(refused);
            assert_eq!(error.code(), "invalid_content");
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }

        #[test]
        fn only_the_rebuilt_svg_goes_on_to_the_worker() {
            let request = prepare(&body(json!([image(SVG.as_bytes())]))).expect("a clean SVG");
            let Block::Image(block) = &request.blocks[0] else {
                panic!("an image block");
            };
            let sent = STANDARD.decode(&block.data).expect("base64");
            let rebuilt = assets::ingest(SVG.as_bytes()).expect("clean").bytes;
            assert_eq!(sent, rebuilt);
            assert_ne!(sent, SVG.as_bytes(), "the caller's bytes did not go on");
            assert!(!String::from_utf8_lossy(&sent).contains("editor"));
        }

        #[test]
        fn the_content_rules_come_first() {
            let refused = prepare(b"not json").expect_err("not JSON");
            assert_eq!(rejection_error(refused).code(), "invalid_content");
            let envelope = prepare(
                json!({ "contentVersion": 1, "entity": "welld_de", "language": "en", "blocks": [] })
                    .to_string()
                    .as_bytes(),
            )
            .expect_err("unknown entity");
            assert_eq!(rejection_error(envelope).code(), "unknown_entity");
        }
    }

    #[tokio::test]
    async fn a_body_over_the_limit_is_refused_and_one_under_it_is_read() {
        let small = read_body(Body::from(vec![1u8; 1000]), Some(1000))
            .await
            .expect("read");
        assert_eq!(small.len(), 1000);
        let at_limit = read_body(Body::from(vec![0u8; MAX_BODY_BYTES]), None)
            .await
            .expect("read");
        assert_eq!(at_limit.len(), MAX_BODY_BYTES);
        let over = read_body(Body::from(vec![0u8; MAX_BODY_BYTES + 1]), None)
            .await
            .expect_err("one byte too many");
        assert_eq!(over.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(over.code(), "request_too_large");
    }

    /// A body that never yields, and one that breaks after its first bytes.
    struct Stuck;

    impl http_body::Body for Stuck {
        type Data = bytes::Bytes;
        type Error = std::convert::Infallible;

        fn poll_frame(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            std::task::Poll::Pending
        }
    }

    struct Broken(bool);

    impl http_body::Body for Broken {
        type Data = bytes::Bytes;
        type Error = std::io::Error;

        fn poll_frame(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Result<http_body::Frame<bytes::Bytes>, Self::Error>>> {
            let first = !self.0;
            self.0 = true;
            std::task::Poll::Ready(Some(if first {
                Ok(http_body::Frame::data(bytes::Bytes::from_static(b"{\"a\"")))
            } else {
                Err(std::io::Error::other("connection reset"))
            }))
        }
    }

    #[tokio::test]
    async fn a_body_that_stops_coming_is_a_408() {
        tokio::time::pause();
        let reading = tokio::spawn(read_body(Body::new(Stuck), None));
        tokio::time::advance(BODY_TIMEOUT + Duration::from_secs(1)).await;
        let error = reading.await.expect("join").expect_err("timed out");
        assert_eq!(error.status(), StatusCode::REQUEST_TIMEOUT);
        assert_eq!(error.code(), "request_timeout");
    }

    #[tokio::test]
    async fn a_body_that_breaks_is_a_400_and_says_so_in_the_log_only() {
        let error = read_body(Body::new(Broken(false)), None)
            .await
            .expect_err("broken");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(error.outcome_code(), "body_aborted");
    }

    #[tokio::test]
    async fn draining_stops_at_its_bound_and_at_the_end_of_the_body() {
        drain(Body::from(vec![0u8; 1000])).await;
        drain(Body::from(vec![0u8; DRAIN_BYTES + 10])).await;
    }
}
