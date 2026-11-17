//! The real [`Source`]: `GET {AUTH_BASE_URL}/system/legal-entities` with this service's own service token.
//!
//! The Rust port of `crm-api/src/lib/serviceToken.ts` (same rules) and of the call in
//! `crm-api/src/lib/legalEntities.ts`:
//!
//! - the token is `POST {AUTH_BASE_URL}/system/service-token` with `{clientId, clientSecret}`; it is cached, refetched
//!   once it is within 60 s of its expiry, and exchanged by one caller at a time. A failed exchange is not remembered;
//! - the secret goes to that one URL, in that one body: no redirect is followed (`Policy::none()`; the answer of a
//!   redirect is a failed read), the body of a failed exchange is never read (it could echo what was sent), and the
//!   secret is in no log, no error and no `Debug` ([`ServiceClient`]);
//! - the call carries `Authorization: Bearer <token>`; a 401 drops that token (if it is still the cached one) and
//!   retries once with a fresh one; a second 401 is a failed read;
//! - the answer is read up to 64 KiB (refused by its announced length first, then by what actually arrives) and must
//!   be the contract's ([`super::parse_legal_entities`]);
//! - the instant the request goes out is taken after the token is had, and is what the cache counts ages from.
//!
//! The 5 s bound over all of it is the cache's ([`super::Registry`] wraps every fetch in it); a dropped fetch drops
//! its connection.

use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use url::Url;

use super::cache::{Clock, Failure, FetchFuture, Fetched, Source};
use super::{MAX_BODY_BYTES, parse_legal_entities};

/// A token is refetched this long before its own expiry.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);
/// A token answer is a short JWT and a number.
const MAX_TOKEN_BODY_BYTES: usize = 16 * 1024;

/// This service's credential at `auth`. `Debug` hides the secret; there is no `Display`.
pub struct ServiceClient {
    id: String,
    secret: String,
}

impl ServiceClient {
    pub fn new(id: impl Into<String>, secret: impl Into<String>) -> ServiceClient {
        ServiceClient {
            id: id.into(),
            secret: secret.into(),
        }
    }
}

impl fmt::Debug for ServiceClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServiceClient")
            .field("id", &self.id)
            .field("secret", &"<redacted>")
            .finish()
    }
}

struct CachedToken {
    token: String,
    usable_until: Duration,
}

/// The service token, cached; one exchange at a time.
struct TokenProvider {
    http: reqwest::Client,
    url: Url,
    client: ServiceClient,
    clock: Clock,
    cached: Mutex<Option<CachedToken>>,
    /// Held across an exchange: the callers that wait for it find its token in the cache afterwards.
    exchange_gate: tokio::sync::Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenAnswer {
    token: String,
    expires_in_seconds: u64,
}

impl TokenProvider {
    fn cache(&self) -> MutexGuard<'_, Option<CachedToken>> {
        self.cached.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn cached_token(&self) -> Option<String> {
        let now = (self.clock)();
        self.cache()
            .as_ref()
            .filter(|cached| cached.usable_until > now)
            .map(|cached| cached.token.clone())
    }

    async fn get(&self) -> Result<String, Failure> {
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        let _one_at_a_time = self.exchange_gate.lock().await;
        // The exchange that we waited for may have brought one.
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        self.exchange().await
    }

    /// Forget `token` (a 401 said it is no good). A no-op when another token is cached now, so a late 401 about an
    /// old token cannot discard a fresh one.
    fn invalidate(&self, token: &str) {
        let mut cached = self.cache();
        if cached.as_ref().is_some_and(|c| c.token == token) {
            *cached = None;
        }
    }

    async fn exchange(&self) -> Result<String, Failure> {
        let body = serde_json::json!({
            "clientId": self.client.id,
            "clientSecret": self.client.secret,
        })
        .to_string();
        let response = self
            .http
            .post(self.url.clone())
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| Failure::Token)?;
        // Not read on a failure: it could echo what was sent.
        if !response.status().is_success() {
            return Err(Failure::Token);
        }
        let bytes = read_bounded(response, MAX_TOKEN_BODY_BYTES)
            .await
            .map_err(|_| Failure::Token)?;
        let answer: TokenAnswer = serde_json::from_slice(&bytes).map_err(|_| Failure::Token)?;
        if answer.token.is_empty() || answer.expires_in_seconds == 0 {
            return Err(Failure::Token);
        }
        let now = (self.clock)();
        let lifetime = Duration::from_secs(answer.expires_in_seconds);
        // A token that lives no longer than the margin is good for this use only.
        let usable_until = now.saturating_add(lifetime).saturating_sub(TOKEN_MARGIN);
        *self.cache() = (usable_until > now).then(|| CachedToken {
            token: answer.token.clone(),
            usable_until,
        });
        Ok(answer.token)
    }
}

/// The body of `response`, refusing more than `limit` bytes: by the announced length first, then by what arrives.
async fn read_bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|announced| announced > limit as u64)
    {
        return Err(Failure::TooLarge);
    }
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Network)? {
        if body.len() + chunk.len() > limit {
            return Err(Failure::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads the registry at `auth`, as this service.
pub struct HttpSource {
    http: reqwest::Client,
    url: Url,
    tokens: TokenProvider,
    clock: Clock,
}

impl fmt::Debug for HttpSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HttpSource")
            .field("url", &self.url.as_str())
            .field("client", &self.tokens.client)
            .finish()
    }
}

impl HttpSource {
    /// `base` is `AUTH_BASE_URL` (validated at startup); the token and the registry are both read there. `clock` is
    /// the registry's, so that the send time is on the same scale as the ages.
    pub fn new(
        base: &Url,
        client: ServiceClient,
        clock: Clock,
    ) -> Result<HttpSource, reqwest::Error> {
        let http = reqwest::Client::builder()
            // The secret and the token go to the configured address and nowhere else.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("letterhead-api")
            .build()?;
        let root = base.as_str().trim_end_matches('/');
        // The base was validated at startup as an http(s) URL; this only appends a path.
        let join =
            |path: &str| Url::parse(&format!("{root}{path}")).unwrap_or_else(|_| base.clone());
        Ok(HttpSource {
            http: http.clone(),
            url: join("/system/legal-entities"),
            tokens: TokenProvider {
                http,
                url: join("/system/service-token"),
                client,
                clock: clock.clone(),
                cached: Mutex::new(None),
                exchange_gate: tokio::sync::Mutex::new(()),
            },
            clock,
        })
    }

    async fn read(&self) -> Result<Fetched, Failure> {
        let mut retried = false;
        loop {
            let token = self.tokens.get().await?;
            // Stamped as the call goes out: `auth` reads the table after this instant (the proof of AC-3.3).
            let sent_at = (self.clock)();
            let response = self
                .http
                .get(self.url.clone())
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .header(ACCEPT, "application/json")
                .send()
                .await
                .map_err(|_| Failure::Network)?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && !retried {
                drop(response);
                self.tokens.invalidate(&token);
                retried = true;
                continue;
            }
            if !status.is_success() {
                return Err(Failure::Status(status.as_u16()));
            }
            let body = read_bounded(response, MAX_BODY_BYTES).await?;
            let entities = parse_legal_entities(&body).ok_or(Failure::Unexpected)?;
            return Ok(Fetched { entities, sent_at });
        }
    }
}

impl Source for HttpSource {
    fn fetch(&self) -> FetchFuture<'_> {
        Box::pin(self.read())
    }
}
