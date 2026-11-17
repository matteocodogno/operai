//! The HTTP routes of the supervisor.
//!
//! - [`render`] (T12): the service routes, `POST /v1/render/{preview,pdf}` and `GET /v1/letterheads/status`, behind
//!   the service credential.
//! - [`read`] (T14): the person routes that only read, `GET /v1/catalog`, `/v1/letterheads`, the versions of an
//!   entity and `/v1/assets/{id}`, behind the person's token and `letterheads:access`. It is a separate router
//!   with its own authentication (plan § Why this shape: the two families never share a middleware).
//! - [`write`] (T15): the person routes that change something, all of them `POST`: an asset upload, a save and a
//!   restore, which check `letterhead:manage` in the entity's scope themselves (AC-8.2).
//! - [`preview`] (T16): `POST /v1/letterheads/{entity}/preview`, the configurator's preview of the built-in sample
//!   document on an unsaved configuration. It needs `letterheads:access` only, and renders through the worker pool.
//!
//! Every answer of the service routes carries `Cache-Control: no-store` (AC-3.8), and each of them, success or
//! refusal, is written once to the log (AC-3.2) by [`frame`]. Every answer of the person routes is `no-store`
//! too: they hold the names of the people who saved, and what a person may change. Only the person routes are
//! answered to a browser's other origin (see [`cors`]); the service routes are for servers.

pub mod preview;
pub mod read;
pub mod render;
pub mod write;

use std::sync::Arc;
use std::time::Instant;

use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Map, Value, json};

use crate::auth::person::{self, PersonAuth};
use crate::auth::service::{ServiceAuth, require};
use crate::authz::{self, resolve::AuthzClient};
use crate::db::Repo;
use crate::log::{self, Facts, Route};
use crate::pool::Pool;
use crate::registry::Registry;
use crate::storage::Storage;

/// What the routes use. Cheap to clone: clones share the connections, the workers and the cache.
#[derive(Clone)]
pub struct AppState {
    pub repo: Repo,
    pub pool: Pool,
    pub storage: Arc<Storage>,
    /// The legal entities registry (T21): the issuer's details the documents print, under the cache rule.
    pub registry: Registry,
}

/// The service routes, with their authentication, the `no-store` header and the log line.
pub fn service_router(state: AppState, auth: Arc<ServiceAuth>) -> Router {
    Router::new()
        .route("/v1/render/preview", post(render::preview))
        .route("/v1/render/pdf", post(render::pdf))
        .route("/v1/letterheads/status", get(render::status))
        // A known path with another method: a problem like every other answer, no-store, and a line in the log.
        .method_not_allowed_fallback(method_not_allowed)
        // On the matched routes only, and attached here, never with a blanket `use` (as crm-api's system routes).
        .route_layer(middleware::from_fn_with_state(auth, require))
        .layer(middleware::from_fn(frame))
        .with_state(state)
}

/// The person routes: the person's token (`auth::person`), then what `auth` says they may do (`authz`), then the
/// handler. Add a route here and it is behind both; no handler is reachable without them.
///
/// There is no `PUT`, `PATCH` or `DELETE` anywhere (AC-4.3, 4.6): a version is saved or restored, never changed.
pub fn person_router(
    state: AppState,
    auth: Arc<PersonAuth>,
    authorization: Arc<AuthzClient>,
) -> Router {
    Router::new()
        .route("/v1/catalog", get(read::catalog))
        .route("/v1/letterheads", get(read::list))
        .route(
            "/v1/letterheads/{entity}/versions",
            get(read::versions).post(write::save),
        )
        .route("/v1/letterheads/{entity}/versions/{n}", get(read::version))
        .route(
            "/v1/letterheads/{entity}/versions/{n}/restore",
            post(write::restore),
        )
        .route("/v1/letterheads/{entity}/assets", post(write::upload))
        .route("/v1/assets/{id}", get(read::asset))
        .route("/v1/letterheads/{entity}/preview", post(preview::preview))
        // `route_layer`, the last added is the outermost: the token is verified, then the permissions are asked.
        .route_layer(middleware::from_fn_with_state(
            authorization,
            authz::require_access,
        ))
        .route_layer(middleware::from_fn_with_state(auth, person::require))
        // After the layers, so it is not behind them: a method that no route has (PUT, PATCH, DELETE: AC-4.3) is
        // a 405 for everyone, whatever credential they hold, not a 401 that suggests one would help.
        .method_not_allowed_fallback(method_not_allowed)
        .layer(middleware::from_fn(no_store))
        .with_state(state)
}

/// `Cache-Control: no-store` on every answer of the person routes, the refusals included.
async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// CORS for the browser's other origin: letterheads-ui is a remote of the shell and calls this service from the
/// shell's origin (`ALLOWED_ORIGINS`, exact, never `*`).
///
/// - Only a request whose `Origin` is in the list is answered with `Access-Control-Allow-Origin`; every answer
///   of these routes says `Vary: Origin`, so no cache mixes the two.
/// - A preflight (`OPTIONS` with `Access-Control-Request-Method`) from an allowed origin is answered here, before
///   the person's token (a preflight carries none): `GET`, `POST`, `OPTIONS`, and the `Authorization` and
///   `Content-Type` headers. Never `PUT`, `PATCH` or `DELETE` (AC-4.3).
/// - `Access-Control-Allow-Credentials: true`, on the preflight and on the answers, for an allowed origin only
///   (T48): the shell's `apiFetch` always sends `credentials: 'include'`, and a browser blocks the answer to
///   such a request without it. It is safe next to the exact-origin allowlist (never `*`, which a browser would
///   refuse with credentials anyway); the person is still known by the bearer token in a header, and the service
///   sets no cookie.
/// - `Retry-After` is exposed, so the form can say when to try again.
/// - The service routes are not touched: a render is not something a browser asks for.
pub async fn cors(
    State(allowed): State<Arc<Vec<String>>>,
    request: Request,
    next: Next,
) -> Response {
    if Route::of_path(request.uri().path()).is_some() {
        return next.run(request).await;
    }
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .filter(|origin| allowed.iter().any(|a| a == origin))
        .and_then(|origin| HeaderValue::from_str(origin).ok());
    let preflight = request.method() == axum::http::Method::OPTIONS
        && request
            .headers()
            .contains_key(header::ACCESS_CONTROL_REQUEST_METHOD);

    let mut response = match (&origin, preflight) {
        (Some(_), true) => {
            let mut answer = StatusCode::NO_CONTENT.into_response();
            let headers = answer.headers_mut();
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, OPTIONS"),
            );
            headers.insert(
                header::ACCESS_CONTROL_ALLOW_HEADERS,
                HeaderValue::from_static("authorization, content-type"),
            );
            headers.insert(
                header::ACCESS_CONTROL_MAX_AGE,
                HeaderValue::from_static("600"),
            );
            answer
        }
        _ => next.run(request).await,
    };
    let headers = response.headers_mut();
    headers.append(header::VARY, HeaderValue::from_static("Origin"));
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        headers.insert(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            HeaderValue::from_static("Retry-After"),
        );
    }
    response
}

async fn method_not_allowed() -> Response {
    ApiError::new(StatusCode::METHOD_NOT_ALLOWED, "method_not_allowed").respond(Facts::default())
}

/// Outermost layer of the service routes: `Cache-Control: no-store` on every answer, and one log line for each
/// request, read from what the authentication or the handler left in the response's extensions.
async fn frame(request: Request, next: Next) -> Response {
    let started = Instant::now();
    let route = Route::of_path(request.uri().path());
    // If the caller goes away, the connection is closed and this whole future is dropped (the worker with it:
    // the pool kills a worker whose job was dropped half way). The line is still written.
    let mut unanswered = route.map(|route| Unanswered {
        route,
        started,
        answered: false,
    });
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Some(unanswered) = unanswered.as_mut() {
        let status = response.status();
        let mut facts = response
            .extensions()
            .get::<Facts>()
            .cloned()
            .unwrap_or_default();
        if facts.outcome.is_none() {
            // An answer that no handler of ours made: named by its status.
            facts.outcome = Some(if status.is_success() { "ok" } else { "refused" });
        }
        log::emit(&log::format_line(
            unanswered.route,
            &facts,
            status.as_u16(),
            unanswered.started.elapsed(),
        ));
        unanswered.answered = true;
    }
    response
}

/// A request that has not been answered yet. Dropped before it is, it writes the line of a request whose caller
/// went away (status 499, as proxies write it): there is no answer to carry what the handler knew, so only the
/// route and the time are in it.
struct Unanswered {
    route: Route,
    started: Instant,
    answered: bool,
}

impl Drop for Unanswered {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        let facts = Facts {
            outcome: Some("client_closed"),
            ..Facts::default()
        };
        log::emit(&log::format_line(
            self.route,
            &facts,
            499,
            self.started.elapsed(),
        ));
    }
}

/// An RFC 7807 answer. It never holds text of the request (AC-3.6): the title is the status's own, the `code` and
/// every member are made by this crate from closed lists, numbers and JSON Pointers into our own schema.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    /// What the log says, when it is more exact than `code` (a 503 with several causes).
    outcome: &'static str,
    members: Map<String, Value>,
    retry_after: Option<u64>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str) -> ApiError {
        ApiError {
            status,
            code,
            outcome: code,
            members: Map::new(),
            retry_after: None,
        }
    }

    /// The outcome code of the log line, when it is not the answer's `code`.
    pub fn outcome(mut self, outcome: &'static str) -> ApiError {
        self.outcome = outcome;
        self
    }

    /// An extra member of the body.
    pub fn with(mut self, name: &str, value: Value) -> ApiError {
        self.members.insert(name.to_owned(), value);
        self
    }

    /// `Retry-After`, in seconds.
    pub fn retry_after(mut self, seconds: u64) -> ApiError {
        self.retry_after = Some(seconds);
        self
    }

    #[cfg(test)]
    pub fn status(&self) -> StatusCode {
        self.status
    }

    #[cfg(test)]
    pub fn code(&self) -> &'static str {
        self.code
    }

    #[cfg(test)]
    pub fn outcome_code(&self) -> &'static str {
        self.outcome
    }

    /// The answer, with what the log line is to say about the request.
    pub fn respond(self, mut facts: Facts) -> Response {
        facts.outcome = Some(self.outcome);
        let mut response = self.into_response();
        response.extensions_mut().insert(facts);
        response
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "type": format!("https://httpstatuses.com/{}", self.status.as_u16()),
            "title": self.status.canonical_reason().unwrap_or("Error"),
            "status": self.status.as_u16(),
            "code": self.code,
        });
        if let Some(object) = body.as_object_mut() {
            for (name, value) in self.members {
                object.insert(name, value);
            }
        }
        let mut response = (self.status, body.to_string()).into_response();
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        if let Some(seconds) = self.retry_after {
            headers.insert(header::RETRY_AFTER, HeaderValue::from(seconds));
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;

    use super::*;

    #[tokio::test]
    async fn an_error_is_a_problem_with_a_code_and_what_was_added() {
        let response = ApiError::new(StatusCode::TOO_MANY_REQUESTS, "busy")
            .with("limit", json!({ "name": "blocks", "max": 5000 }))
            .retry_after(2)
            .into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).expect("type"),
            "application/problem+json"
        );
        assert_eq!(
            response.headers().get(header::RETRY_AFTER).expect("retry"),
            "2"
        );
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.expect("body"))
                .expect("json");
        assert_eq!(body["code"], "busy");
        assert_eq!(body["status"], 429);
        assert_eq!(body["title"], "Too Many Requests");
        assert_eq!(body["limit"]["max"], 5000);
    }

    #[test]
    fn the_log_outcome_is_the_code_unless_it_is_said_otherwise() {
        let plain = ApiError::new(StatusCode::NOT_FOUND, "letterhead_version_not_found");
        assert_eq!(plain.outcome_code(), "letterhead_version_not_found");
        let said = ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "render_unavailable")
            .outcome("worker_failed");
        assert_eq!(said.code(), "render_unavailable");
        assert_eq!(said.outcome_code(), "worker_failed");
        let facts = said.respond(Facts::default());
        assert_eq!(
            facts.extensions().get::<Facts>().and_then(|f| f.outcome),
            Some("worker_failed")
        );
    }
}
