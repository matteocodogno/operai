//! Environment contract of letterhead-api, for the whole feature (specs/20261116-letterhead-service).
//!
//! `Config::from_env()` reads and validates every variable once, at startup, and reports ALL problems
//! together; `main` prints them and exits non-zero. Nothing else in the service reads the environment.
//!
//! Rules this module keeps:
//! - An error names the variable and the rule. It never repeats a value, so a secret that is
//!   malformed (a database URL with a password, an access key) cannot reach a log.
//!   The one exception is the residency check, which names the endpoint host and the region, as
//!   `crm-api/src/lib/s3Residency.ts` does: they are not secret and the operator needs them.
//! - Secrets sit in [`Secret`], whose `Debug` is redacted.
//! - EU residency of the bucket is checked here, so a service with a non-EU endpoint does not start (AC-3.8).
//! - No caller is named in the environment or in the code: a caller is a credential at `auth`
//!   (service client with scope `letterhead:render`), so adding one changes no line here (AC-9.3).
//!
//! | Variable | Required | Rule |
//! | --- | --- | --- |
//! | `PORT` | no, 8088 | 1..=65535 |
//! | `DATABASE_URL` | yes | `postgres://` or `postgresql://` URL (secret) |
//! | `AUTH_ISSUER` | yes | http(s) URL of the `auth` service (a name for `iss`, never called) |
//! | `AUTH_JWKS_URL`, `AUTH_BASE_URL` | yes | URLs of the `auth` service: `https`, or `http` only to a loopback, private or internal host (see [`is_internal_host`]) |
//! | `AUTH_AUDIENCE` | yes | `aud` of person tokens |
//! | `SERVICE_AUDIENCE` | yes | `aud` of service tokens; must differ from `AUTH_AUDIENCE` |
//! | `SERVICE_CLIENT_ID` | yes | this service's own client at `auth` (`letterhead-api`, scope `legal-entities:read`); lower-case alphanumerics and single hyphens, at most 64 characters |
//! | `SERVICE_CLIENT_SECRET` | yes | its secret, 32 to 256 characters (secret): exchanged at `AUTH_BASE_URL` for the service token that reads the legal entities registry |
//! | `ALLOWED_ORIGINS` | yes | comma-separated origins (CORS); no wildcard |
//! | `LETTERHEAD_S3_ENDPOINT`, `_REGION`, `_BUCKET`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` | yes | the bucket; the two keys are secrets |
//! | `LETTERHEAD_S3_EU_ENDPOINT_HOSTS` | for a non-AWS endpoint | comma-separated EU host suffixes |
//! | `LH_WORKERS` | no, 2 | worker pool size, 1..=64 |
//! | `LH_QUEUE` | no, 4 | renders that may wait for a worker, 0..=1024 |
//! | `LH_WORKER_RSS_MB` | no, 2048 | resident memory (MiB) at which a worker is killed, 64..=16384 |
//! | `RAILWAY_PRIVATE_DOMAIN` | no | when set, bind `::` (Railway private networking is IPv6-only) |

// What is left of `Config` that the running service does not read: the EU host list, which `from_lookup` uses
// to decide and only the tests look at again. `expect` makes the compiler say so when the last of it is used, so
// this attribute does not outlive its reason; it is off for the tests, which read all of it.
#![cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "S3Config::eu_endpoint_hosts is kept for the residency tests; the service reads only the decision"
    )
)]

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use url::Url;

use crate::pool::DEFAULT_RSS_CAP_MB;

pub const DEFAULT_PORT: u16 = 8088;
pub const DEFAULT_WORKERS: usize = 2;
pub const DEFAULT_QUEUE: usize = 4;
/// Upper bounds catch a typo; the real bound is memory (workers x worker RSS cap must fit the container, plan F4).
pub const MAX_WORKERS: usize = 64;
pub const MAX_QUEUE: usize = 1024;
/// Below this a worker is over its cap before it has rendered anything (the fonts and the engine alone are
/// resident), so every render would answer 503: a typo, not a setting.
pub const MIN_WORKER_RSS_MB: u64 = 64;
/// Upper bound catches a typo (a byte count where MiB were meant); the real bound is the container's memory.
pub const MAX_WORKER_RSS_MB: u64 = 16 * 1024;

/// The limits `auth` puts on a service client (`auth/src/system/serviceClients.ts`).
pub const MAX_CLIENT_ID_CHARS: usize = 64;
pub const MIN_CLIENT_SECRET_CHARS: usize = 32;
pub const MAX_CLIENT_SECRET_CHARS: usize = 256;

/// AWS regions whose physical location is the EU (same list as `crm-api/src/lib/s3Residency.ts`).
pub const EU_AWS_REGIONS: [&str; 8] = [
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
];

/// A value that must never be printed. `Debug` is redacted; `expose` is the only way to the text.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub issuer: Url,
    pub jwks_url: Url,
    pub base_url: Url,
    /// `aud` of person tokens (configurator routes).
    pub audience: String,
}

/// This service's own credential at `auth` (specs/20261117-legal-entities, plan decision 7): a service client with
/// the scope `legal-entities:read` and nothing else. It is read by the supervisor only; the workers start with an
/// empty environment.
#[derive(Debug, Clone)]
pub struct ServiceClientConfig {
    pub id: String,
    pub secret: Secret,
}

#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: Url,
    pub region: String,
    pub bucket: String,
    pub access_key_id: Secret,
    pub secret_access_key: Secret,
    pub eu_endpoint_hosts: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_ip: IpAddr,
    pub port: u16,
    pub database_url: Secret,
    pub auth: AuthConfig,
    /// `aud` of service tokens (render routes).
    pub service_audience: String,
    /// `SERVICE_CLIENT_ID` / `SERVICE_CLIENT_SECRET`: how this service reads the legal entities registry.
    pub service_client: ServiceClientConfig,
    pub allowed_origins: Vec<String>,
    pub s3: S3Config,
    pub workers: usize,
    pub queue: usize,
    /// `LH_WORKER_RSS_MB`: a worker whose resident memory passes this is killed (503 `render_memory_exceeded`).
    /// Workers x this, plus the supervisor, must fit the container (ADR 20261116-renders-run-in-killable-worker-processes...).
    pub worker_rss_mb: u64,
}

/// Every problem found, one line each. Lines name variables and rules, never values.
#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub Vec<String>);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, problem) in self.0.iter().enumerate() {
            if i > 0 {
                writeln!(f)?;
            }
            write!(f, "  - {problem}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    /// Reads the process environment. A value that is not valid Unicode is read as empty, which every rule refuses.
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|name| {
            std::env::var_os(name).map(|v| v.into_string().unwrap_or_default())
        })
    }

    /// The same validation over any source of variables; what the tests use.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let mut r = Reader {
            get,
            problems: Vec::new(),
        };

        let port = r.number("PORT", DEFAULT_PORT.into(), 1, u16::MAX.into());
        let database_url = r.database_url("DATABASE_URL");
        let auth_issuer = r.url("AUTH_ISSUER");
        // The person's bearer token is sent to `AUTH_BASE_URL` and the signing keys come from `AUTH_JWKS_URL`: neither
        // may travel in clear over a public network (security review F4).
        let auth_jwks_url = r.internal_or_https_url("AUTH_JWKS_URL");
        let auth_base_url = r.internal_or_https_url("AUTH_BASE_URL");
        let auth_audience = r.text("AUTH_AUDIENCE");
        let service_audience = r.text("SERVICE_AUDIENCE");
        let service_client_id = r.client_id("SERVICE_CLIENT_ID");
        let service_client_secret = r.client_secret("SERVICE_CLIENT_SECRET");
        let allowed_origins = r.origins("ALLOWED_ORIGINS");
        let workers = r.number("LH_WORKERS", DEFAULT_WORKERS as u64, 1, MAX_WORKERS as u64);
        let queue = r.number("LH_QUEUE", DEFAULT_QUEUE as u64, 0, MAX_QUEUE as u64);
        let worker_rss_mb = r.number(
            "LH_WORKER_RSS_MB",
            DEFAULT_RSS_CAP_MB,
            MIN_WORKER_RSS_MB,
            MAX_WORKER_RSS_MB,
        );

        // The audiences must differ, or a service token would pass on a person route and the reverse
        // (ADR 20261006-scoped-service-jwt-fourth-notify-caller; `auth` and `notify-api` refuse the same).
        if let (Some(a), Some(s)) = (&auth_audience, &service_audience)
            && a == s
        {
            r.problem("SERVICE_AUDIENCE must differ from AUTH_AUDIENCE");
        }

        let s3_endpoint = r.url("LETTERHEAD_S3_ENDPOINT");
        let s3_region = r.text("LETTERHEAD_S3_REGION");
        let s3_bucket = r.bucket("LETTERHEAD_S3_BUCKET");
        let s3_access_key_id = r.secret("LETTERHEAD_S3_ACCESS_KEY_ID");
        let s3_secret_access_key = r.secret("LETTERHEAD_S3_SECRET_ACCESS_KEY");
        let eu_endpoint_hosts = r.host_list("LETTERHEAD_S3_EU_ENDPOINT_HOSTS");

        if let (Some(endpoint), Some(region)) = (&s3_endpoint, &s3_region)
            && let Err(message) = check_eu_residency(endpoint, region, &eu_endpoint_hosts)
        {
            r.problem(&message);
        }

        let bind_ip = match (r.get)("RAILWAY_PRIVATE_DOMAIN") {
            Some(v) if !v.trim().is_empty() => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
            _ => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        };

        // Each `None` below recorded a problem when it was read, so a missing value always ends in `Err`.
        let built = (|| {
            Some(Config {
                bind_ip,
                port: port as u16,
                database_url: database_url?,
                auth: AuthConfig {
                    issuer: auth_issuer?,
                    jwks_url: auth_jwks_url?,
                    base_url: auth_base_url?,
                    audience: auth_audience?,
                },
                service_audience: service_audience?,
                service_client: ServiceClientConfig {
                    id: service_client_id?,
                    secret: service_client_secret?,
                },
                allowed_origins,
                s3: S3Config {
                    endpoint: s3_endpoint?,
                    region: s3_region?,
                    bucket: s3_bucket?,
                    access_key_id: s3_access_key_id?,
                    secret_access_key: s3_secret_access_key?,
                    eu_endpoint_hosts,
                },
                workers: workers as usize,
                queue: queue as usize,
                worker_rss_mb,
            })
        })();
        match built {
            Some(config) if r.problems.is_empty() => Ok(config),
            _ => {
                if r.problems.is_empty() {
                    r.problem("internal: the environment was refused without a reason");
                }
                Err(ConfigError(r.problems))
            }
        }
    }
}

/// True when `endpoint` is a real AWS S3 endpoint, where the region string is meaningful.
/// Whether `http` is acceptable to this host: one that is not on a public network. Loopback (`localhost`,
/// `127.0.0.0/8`, `::1`), the private ranges (`10/8`, `172.16/12`, `192.168/16`, link-local, `fc00::/7`), the
/// names of the platforms' private networks (`*.railway.internal`, `host.docker.internal`, `*.internal`,
/// `*.localhost`) and a name with no dot at all (a compose or cluster service name such as `auth`, which cannot
/// be a public DNS name). Anything else needs `https`.
pub fn is_internal_host(host: &url::Host<&str>) -> bool {
    match host {
        url::Host::Ipv4(ip) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        url::Host::Ipv6(ip) => {
            ip.is_loopback()
                || (ip.segments()[0] & 0xfe00) == 0xfc00 // unique local, fc00::/7
                || (ip.segments()[0] & 0xffc0) == 0xfe80 // link-local
        }
        url::Host::Domain(name) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            !name.contains('.')
                || name == "host.docker.internal"
                || name.ends_with(".internal")
                || name.ends_with(".localhost")
        }
    }
}

pub fn is_aws_s3_endpoint(endpoint: &Url) -> bool {
    endpoint
        .host_str()
        .is_some_and(|host| host.ends_with(".amazonaws.com"))
}

/// Ported from `crm-api/src/lib/s3Residency.ts` (`checkEuResidency`), same rule:
/// - an AWS endpoint (`*.amazonaws.com`): the region must be an EU AWS region;
/// - any other host (Railway, Scaleway, R2, MinIO): the region string is a placeholder that does not say where
///   the data is, so the endpoint host must match the operator-declared EU host list. An empty list or a host
///   outside it fails: the start is refused, never a silent pass.
///
/// `eu_endpoint_hosts` are lowercase, as [`Config::from_lookup`] builds them. The host comes from a parsed URL,
/// so `http://allowed@elsewhere.example` is judged by `elsewhere.example`, not by the text before the `@`.
pub fn check_eu_residency(
    endpoint: &Url,
    region: &str,
    eu_endpoint_hosts: &[String],
) -> Result<(), String> {
    if is_aws_s3_endpoint(endpoint) {
        if !EU_AWS_REGIONS.contains(&region) {
            return Err(format!(
                "LETTERHEAD_S3_REGION \"{region}\" is not an EU AWS region (data residency, AC-3.8). Allowed: {}",
                EU_AWS_REGIONS.join(", ")
            ));
        }
        // Stricter than the TypeScript original, in the safe direction: a region named in the host itself
        // (`s3.us-east-1.amazonaws.com`, `bucket.s3-us-west-2.amazonaws.com`) must be an EU one too, so a
        // correct-looking `LETTERHEAD_S3_REGION` cannot hide a US endpoint.
        let host = endpoint.host_str().unwrap_or_default();
        if let Some(named) = region_named_by(host)
            && !EU_AWS_REGIONS.contains(&named)
        {
            return Err(format!(
                "LETTERHEAD_S3_ENDPOINT host names the region \"{named}\", which is not an EU AWS region \
                 (data residency, AC-3.8)"
            ));
        }
        return Ok(());
    }

    if eu_endpoint_hosts.is_empty() {
        return Err("LETTERHEAD_S3_ENDPOINT is a non-AWS endpoint, but LETTERHEAD_S3_EU_ENDPOINT_HOSTS is empty or \
                    unset: residency cannot be verified without an operator-declared EU allowlist (data residency, \
                    AC-3.8). Set it to a comma-separated list of EU endpoint host suffixes."
            .to_owned());
    }

    let host = endpoint.host_str().unwrap_or_default().to_ascii_lowercase();
    let allowed = eu_endpoint_hosts
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")));
    if !allowed {
        return Err(format!(
            "LETTERHEAD_S3_ENDPOINT host \"{host}\" does not match any entry in LETTERHEAD_S3_EU_ENDPOINT_HOSTS \
             ({}): refusing to start with an unverified non-EU endpoint (data residency, AC-3.8).",
            eu_endpoint_hosts.join(", ")
        ));
    }
    Ok(())
}

/// The AWS region a host label names, if it has the shape of one (`us-east-1`, `eu-west-3`, `ap-southeast-2`,
/// or the legacy `s3-us-west-2`); `None` for any other label.
fn aws_region_label(label: &str) -> Option<&str> {
    let label = label.strip_prefix("s3-").unwrap_or(label);
    let (head, number) = label.rsplit_once('-')?;
    let words: Vec<&str> = head.split('-').collect();
    let lowercase = |w: &&str| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase());
    let shaped = words.len() >= 2
        && words[0].len() == 2
        && words.iter().all(lowercase)
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit());
    shaped.then_some(label)
}

/// The region an AWS S3 host names, looking only at the labels from the `s3` one on, so that a bucket name
/// in front of it (`my-bucket-1.s3.eu-west-1.amazonaws.com`) is never taken for a region.
fn region_named_by(host: &str) -> Option<&str> {
    let labels: Vec<&str> = host.split('.').collect();
    let from = labels
        .iter()
        .rposition(|l| *l == "s3" || l.starts_with("s3-"))?;
    labels[from..].iter().find_map(|l| aws_region_label(l))
}

/// Collects problems while reading, so one start reports every one of them.
struct Reader<F> {
    get: F,
    problems: Vec<String>,
}

impl<F: Fn(&str) -> Option<String>> Reader<F> {
    fn problem(&mut self, message: &str) {
        self.problems.push(message.to_owned());
    }

    /// The raw value, or a problem when it is unset or blank.
    fn raw(&mut self, name: &str) -> Option<String> {
        match (self.get)(name) {
            Some(v) if !v.trim().is_empty() => Some(v),
            _ => {
                self.problems.push(format!("{name} is required"));
                None
            }
        }
    }

    /// A non-secret string, trimmed (a stray newline from a secret manager must not become part of an audience).
    fn text(&mut self, name: &str) -> Option<String> {
        self.raw(name).map(|v| v.trim().to_owned())
    }

    /// A secret, kept exactly as given.
    fn secret(&mut self, name: &str) -> Option<Secret> {
        self.raw(name).map(Secret)
    }

    fn url(&mut self, name: &str) -> Option<Url> {
        let value = self.text(name)?;
        match Url::parse(&value) {
            Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {
                Some(url)
            }
            _ => {
                self.problems
                    .push(format!("{name} must be an http(s) URL with a host"));
                None
            }
        }
    }

    /// An `https` URL, or an `http` one to a host that is not on a public network ([`is_internal_host`]).
    fn internal_or_https_url(&mut self, name: &str) -> Option<Url> {
        let url = self.url(name)?;
        let allowed = url.scheme() == "https" || url.host().as_ref().is_some_and(is_internal_host);
        if allowed {
            Some(url)
        } else {
            self.problems.push(format!(
                "{name} must be https, or http only to a loopback, private or internal host"
            ));
            None
        }
    }

    /// A client id as `auth` accepts it in `SERVICE_CLIENTS`: lower-case alphanumerics and single hyphens, at most 64.
    fn client_id(&mut self, name: &str) -> Option<String> {
        let value = self.text(name)?;
        let shaped = value.len() <= MAX_CLIENT_ID_CHARS
            && value.split('-').all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            });
        if shaped {
            Some(value)
        } else {
            self.problems.push(format!(
                "{name} must be lower-case alphanumerics and single hyphens, at most {MAX_CLIENT_ID_CHARS} characters"
            ));
            None
        }
    }

    /// A client secret, exactly as given, of the length `auth` accepts (the value is never repeated).
    fn client_secret(&mut self, name: &str) -> Option<Secret> {
        let secret = self.secret(name)?;
        let length = secret.expose().chars().count();
        if (MIN_CLIENT_SECRET_CHARS..=MAX_CLIENT_SECRET_CHARS).contains(&length) {
            Some(secret)
        } else {
            self.problems.push(format!(
                "{name} must be {MIN_CLIENT_SECRET_CHARS} to {MAX_CLIENT_SECRET_CHARS} characters"
            ));
            None
        }
    }

    fn database_url(&mut self, name: &str) -> Option<Secret> {
        let value = self.raw(name)?;
        match Url::parse(value.trim()) {
            Ok(url) if matches!(url.scheme(), "postgres" | "postgresql") => {
                Some(Secret(value.trim().to_owned()))
            }
            _ => {
                self.problems
                    .push(format!("{name} must be a postgres:// or postgresql:// URL"));
                None
            }
        }
    }

    /// An integer in `min..=max`, `default` when the variable is not set. Set but empty or malformed is a problem.
    fn number(&mut self, name: &str, default: u64, min: u64, max: u64) -> u64 {
        let Some(value) = (self.get)(name) else {
            return default;
        };
        match value.trim().parse::<u64>() {
            Ok(n) if (min..=max).contains(&n) => n,
            _ => {
                self.problems
                    .push(format!("{name} must be an integer between {min} and {max}"));
                default
            }
        }
    }

    /// A bucket name: letters, digits, `.`, `_` and `-` only, so it can never carry a path or a space into a key.
    fn bucket(&mut self, name: &str) -> Option<String> {
        let value = self.text(name)?;
        if value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            Some(value)
        } else {
            self.problems.push(format!(
                "{name} may hold only letters, digits, '.', '_' and '-'"
            ));
            None
        }
    }

    /// CORS origins, each exactly as a browser sends it in `Origin` (`scheme://host[:port]`, lowercase, no path,
    /// no default port), so that the entry can match. No wildcard.
    fn origins(&mut self, name: &str) -> Vec<String> {
        let Some(value) = self.text(name) else {
            return Vec::new();
        };
        let entries: Vec<&str> = value
            .split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .collect();
        if entries.is_empty() {
            self.problems.push(format!("{name} is empty"));
        }
        let mut origins = Vec::new();
        for (i, entry) in entries.iter().enumerate() {
            let position = i + 1;
            if *entry == "*" {
                self.problems.push(format!(
                    "{name} must not contain a wildcard (entry {position})"
                ));
                continue;
            }
            let canonical = Url::parse(entry)
                .ok()
                .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
                .map(|url| url.origin().ascii_serialization())
                .filter(|origin| origin == entry);
            match canonical {
                Some(origin) => origins.push(origin),
                None => self.problems.push(format!(
                    "{name} entry {position} must be an origin as the browser sends it: http(s)://host[:port], \
                     lowercase, no path, no default port"
                )),
            }
        }
        origins
    }

    /// A comma-separated host list, lowercase, empty entries dropped. Optional; an empty list is judged by the residency rule.
    fn host_list(&mut self, name: &str) -> Vec<String> {
        (self.get)(name)
            .unwrap_or_default()
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    const SECRET_DB: &str = "postgresql://letterhead:db-pass-7f3a@postgres:5432/letterhead";
    const SECRET_KEY_ID: &str = "AKID-sentinel-91c2";
    const SECRET_KEY: &str = "SECRET-sentinel-55d0";
    /// 40 characters, so it passes the length rule; a sentinel to look for in any printed text.
    const SECRET_CLIENT: &str = "client-secret-sentinel-0d7b-letterhead-ok";

    /// A complete, valid development environment (what compose sets).
    fn valid() -> HashMap<&'static str, String> {
        HashMap::from([
            ("DATABASE_URL", SECRET_DB.to_owned()),
            ("AUTH_ISSUER", "http://localhost:3001".to_owned()),
            (
                "AUTH_JWKS_URL",
                "http://localhost:3001/auth/jwks".to_owned(),
            ),
            ("AUTH_BASE_URL", "http://localhost:3001".to_owned()),
            ("AUTH_AUDIENCE", "operai-suite".to_owned()),
            ("SERVICE_AUDIENCE", "operai-service".to_owned()),
            ("SERVICE_CLIENT_ID", "letterhead-api".to_owned()),
            ("SERVICE_CLIENT_SECRET", SECRET_CLIENT.to_owned()),
            ("ALLOWED_ORIGINS", "http://localhost:5173".to_owned()),
            ("LETTERHEAD_S3_ENDPOINT", "http://minio:9000".to_owned()),
            ("LETTERHEAD_S3_REGION", "us-east-1".to_owned()),
            ("LETTERHEAD_S3_BUCKET", "letterhead".to_owned()),
            ("LETTERHEAD_S3_ACCESS_KEY_ID", SECRET_KEY_ID.to_owned()),
            ("LETTERHEAD_S3_SECRET_ACCESS_KEY", SECRET_KEY.to_owned()),
            ("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", "minio".to_owned()),
        ])
    }

    fn load(env: &HashMap<&'static str, String>) -> Result<Config, ConfigError> {
        Config::from_lookup(|name| env.get(name).cloned())
    }

    fn with(name: &'static str, value: &str) -> Result<Config, ConfigError> {
        let mut env = valid();
        env.insert(name, value.to_owned());
        load(&env)
    }

    fn problems(result: Result<Config, ConfigError>) -> Vec<String> {
        result
            .expect_err("the environment should have been refused")
            .0
    }

    #[test]
    fn a_complete_environment_loads_with_the_defaults() {
        let config = load(&valid()).expect("valid environment");
        assert_eq!(config.port, 8088);
        assert_eq!(config.workers, 2);
        assert_eq!(config.queue, 4);
        assert_eq!(config.bind_ip, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert_eq!(config.allowed_origins, ["http://localhost:5173"]);
        assert_eq!(config.s3.eu_endpoint_hosts, ["minio"]);
    }

    #[test]
    fn every_missing_variable_is_reported_at_once() {
        let found = problems(Config::from_lookup(|_| None));
        for name in [
            "DATABASE_URL",
            "AUTH_ISSUER",
            "AUTH_JWKS_URL",
            "AUTH_BASE_URL",
            "AUTH_AUDIENCE",
            "SERVICE_AUDIENCE",
            "SERVICE_CLIENT_ID",
            "SERVICE_CLIENT_SECRET",
            "ALLOWED_ORIGINS",
            "LETTERHEAD_S3_ENDPOINT",
            "LETTERHEAD_S3_REGION",
            "LETTERHEAD_S3_BUCKET",
            "LETTERHEAD_S3_ACCESS_KEY_ID",
            "LETTERHEAD_S3_SECRET_ACCESS_KEY",
        ] {
            let expected = format!("{name} is required");
            assert!(
                found.contains(&expected),
                "{name} not reported in {found:?}"
            );
        }
    }

    #[test]
    fn a_blank_value_counts_as_unset() {
        assert_eq!(
            problems(with("AUTH_AUDIENCE", "   ")),
            ["AUTH_AUDIENCE is required"]
        );
    }

    #[test]
    fn the_two_audiences_must_differ() {
        assert_eq!(
            problems(with("SERVICE_AUDIENCE", "operai-suite")),
            ["SERVICE_AUDIENCE must differ from AUTH_AUDIENCE"]
        );
        // A stray newline does not make two equal audiences different.
        assert_eq!(
            problems(with("SERVICE_AUDIENCE", "operai-suite\n")),
            ["SERVICE_AUDIENCE must differ from AUTH_AUDIENCE"]
        );
    }

    #[test]
    fn the_service_client_is_required_and_either_variable_missing_stops_the_start() {
        let config = load(&valid()).expect("valid environment");
        assert_eq!(config.service_client.id, "letterhead-api");
        assert_eq!(config.service_client.secret.expose(), SECRET_CLIENT);
        for name in ["SERVICE_CLIENT_ID", "SERVICE_CLIENT_SECRET"] {
            let mut env = valid();
            env.remove(name);
            assert_eq!(problems(load(&env)), [format!("{name} is required")]);
            assert_eq!(
                problems(with(name, "  ")),
                [format!("{name} is required")],
                "a blank value counts as unset"
            );
        }
    }

    #[test]
    fn the_service_client_follows_the_rules_auth_enforces_and_names_no_value() {
        for bad in [
            "Letterhead-Api",
            "letterhead_api",
            "-letterhead",
            "letterhead-",
            "letter--head",
            "letter head",
            &"a".repeat(65),
        ] {
            let found = problems(with("SERVICE_CLIENT_ID", bad));
            assert_eq!(found.len(), 1, "{bad:?} should be refused");
            assert!(found[0].starts_with("SERVICE_CLIENT_ID"), "{found:?}");
            assert!(!found[0].contains(bad), "the value is never repeated");
        }
        assert!(with("SERVICE_CLIENT_ID", &"a".repeat(64)).is_ok());
        assert!(with("SERVICE_CLIENT_ID", " letterhead-api\n").is_ok());

        for bad in ["short", &"s".repeat(31), &"s".repeat(257)] {
            let found = problems(with("SERVICE_CLIENT_SECRET", bad));
            assert_eq!(
                found,
                ["SERVICE_CLIENT_SECRET must be 32 to 256 characters"],
                "{} characters",
                bad.len()
            );
        }
        assert!(with("SERVICE_CLIENT_SECRET", &"s".repeat(32)).is_ok());
        assert!(with("SERVICE_CLIENT_SECRET", &"s".repeat(256)).is_ok());
    }

    #[test]
    fn the_service_client_secret_is_in_no_debug_output_and_no_problem() {
        let config = load(&valid()).expect("valid environment");
        let printed = format!("{config:?} {:#?}", config.service_client);
        assert!(!printed.contains(SECRET_CLIENT), "{printed}");
        assert!(printed.contains("<redacted>"));
        // A malformed environment reports names and rules only.
        let mut env = valid();
        env.insert("SERVICE_CLIENT_ID", "BAD ID".to_owned());
        env.insert("SERVICE_CLIENT_SECRET", "short-secret-sentinel".to_owned());
        let found = problems(load(&env)).join("\n");
        assert!(!found.contains("short-secret-sentinel"), "{found}");
        assert!(!found.contains("BAD ID"), "{found}");
    }

    #[test]
    fn numbers_are_bounded() {
        assert_eq!(with("LH_WORKERS", "8").expect("8 workers").workers, 8);
        assert_eq!(with("LH_QUEUE", "0").expect("queue 0").queue, 0);
        for (name, value) in [
            ("LH_WORKER_RSS_MB", "63"),
            ("LH_WORKER_RSS_MB", "16385"),
            ("LH_WORKER_RSS_MB", "1.5G"),
            ("LH_WORKER_RSS_MB", "-1"),
            ("LH_WORKER_RSS_MB", ""),
            ("LH_WORKERS", "0"),
            ("LH_WORKERS", "65"),
            ("LH_WORKERS", "two"),
            ("LH_QUEUE", "-1"),
            ("PORT", "0"),
            ("PORT", "70000"),
            ("PORT", ""),
        ] {
            let found = problems(with(name, value));
            assert_eq!(found.len(), 1, "{name}={value:?} should be refused");
        }
    }

    #[test]
    fn the_worker_memory_cap_defaults_to_2_gib_and_can_be_set() {
        // The default is the pool's, so there is one number to change (T41: a table of a little over 300 pages
        // must reach the page check before the cap, which neither 1 GiB nor 1.5 GiB allows on Linux).
        let config = with("PORT", "8088").expect("valid");
        assert_eq!(config.worker_rss_mb, 2048);
        assert_eq!(DEFAULT_RSS_CAP_MB, 2048);
        for (value, mb) in [("64", 64), ("2048", 2048), (" 300 ", 300), ("16384", 16384)] {
            assert_eq!(
                with("LH_WORKER_RSS_MB", value).expect(value).worker_rss_mb,
                mb
            );
        }
        let found = problems(with("LH_WORKER_RSS_MB", "lots"));
        assert_eq!(
            found,
            ["LH_WORKER_RSS_MB must be an integer between 64 and 16384"]
        );
    }

    #[test]
    fn a_railway_private_domain_binds_ipv6() {
        let config =
            with("RAILWAY_PRIVATE_DOMAIN", "letterhead-api.railway.internal").expect("valid");
        assert_eq!(config.bind_ip, IpAddr::V6(Ipv6Addr::UNSPECIFIED));
    }

    #[test]
    fn origins_must_be_exact_and_never_a_wildcard() {
        let config = with(
            "ALLOWED_ORIGINS",
            "https://operai.welld.io, http://localhost:5173,",
        )
        .expect("two origins");
        assert_eq!(
            config.allowed_origins,
            ["https://operai.welld.io", "http://localhost:5173"]
        );
        for bad in [
            "*",
            "https://operai.welld.io/",
            "https://Operai.welld.io",
            "https://operai.welld.io:443",
            "operai.welld.io",
            "ftp://operai.welld.io",
            "",
        ] {
            let found = problems(with("ALLOWED_ORIGINS", bad));
            assert!(!found.is_empty(), "{bad:?} should be refused");
        }
    }

    #[test]
    fn a_public_http_auth_url_stops_the_start_and_an_internal_or_https_one_does_not() {
        for name in ["AUTH_BASE_URL", "AUTH_JWKS_URL"] {
            for bad in [
                "http://auth.example.com/x",
                "http://8.8.8.8:3001",
                "http://172.32.0.1/x",
                "http://[2001:db8::1]/x",
                "http://localhost.example.com/x",
                "http://auth.internal.example.com/x",
            ] {
                let found = problems(with(name, bad));
                assert_eq!(found.len(), 1, "{name}={bad:?} should be refused");
                assert!(
                    found[0].starts_with(name) && found[0].contains("https"),
                    "{found:?}"
                );
                assert!(!found[0].contains("example.com"), "no value in an error");
            }
            for good in [
                "https://auth.example.com",
                "http://localhost:3001",
                "http://127.0.0.1:3001/x",
                "http://[::1]:3001",
                "http://10.1.2.3:3001",
                "http://172.16.0.9",
                "http://192.168.1.5",
                "http://[fd12::1]:3001",
                "http://host.docker.internal:3001",
                "http://auth.railway.internal:3001",
                "http://auth:3001",
            ] {
                with(name, good).unwrap_or_else(|e| panic!("{name}={good:?}: {e:?}"));
            }
        }
    }

    #[test]
    fn urls_and_names_are_checked() {
        for (name, bad) in [
            ("AUTH_JWKS_URL", "not a url"),
            ("AUTH_ISSUER", "ftp://auth"),
            ("DATABASE_URL", "mysql://u:p@h/db"),
            ("LETTERHEAD_S3_BUCKET", "letter/head"),
            ("LETTERHEAD_S3_ENDPOINT", "minio:9000"),
        ] {
            assert_eq!(
                problems(with(name, bad)).len(),
                1,
                "{name}={bad:?} should be refused"
            );
        }
    }

    // ── AC-3.8: a non-EU object store stops the start ────────────────────────────────────────────────────────

    #[test]
    fn a_non_eu_aws_region_stops_the_start() {
        let mut env = valid();
        env.insert(
            "LETTERHEAD_S3_ENDPOINT",
            "https://s3.us-east-1.amazonaws.com".to_owned(),
        );
        env.insert("LETTERHEAD_S3_REGION", "us-east-1".to_owned());
        let found = problems(load(&env));
        assert_eq!(found.len(), 1);
        let expected = "LETTERHEAD_S3_REGION \"us-east-1\" is not an EU AWS region";
        assert!(found[0].contains(expected), "{found:?}");

        env.insert(
            "LETTERHEAD_S3_ENDPOINT",
            "https://s3.eu-central-1.amazonaws.com".to_owned(),
        );
        env.insert("LETTERHEAD_S3_REGION", "eu-central-1".to_owned());
        load(&env).expect("an EU AWS region passes");
    }

    #[test]
    fn a_region_named_in_the_aws_host_must_be_eu_whatever_the_region_variable_says() {
        let accepts = |endpoint: &str, region: &str| {
            let mut env = valid();
            env.insert("LETTERHEAD_S3_ENDPOINT", endpoint.to_owned());
            env.insert("LETTERHEAD_S3_REGION", region.to_owned());
            load(&env).is_ok()
        };
        assert!(!accepts("https://s3.us-east-1.amazonaws.com", "eu-west-1"));
        assert!(!accepts(
            "https://bucket.s3-us-west-2.amazonaws.com",
            "eu-west-1"
        ));
        assert!(!accepts(
            "https://s3.ap-southeast-2.amazonaws.com",
            "eu-west-1"
        ));
        assert!(accepts("https://s3.eu-west-1.amazonaws.com", "eu-west-1"));
        assert!(accepts(
            "https://bucket.s3.dualstack.eu-north-1.amazonaws.com",
            "eu-north-1"
        ));
        assert!(accepts(
            "https://my-bucket-1.s3.eu-west-1.amazonaws.com",
            "eu-west-1"
        ));
        assert!(accepts(
            "https://s3-ab-1.s3.eu-west-1.amazonaws.com",
            "eu-west-1"
        ));
        assert!(!accepts(
            "https://my-bucket-1.s3.us-east-2.amazonaws.com",
            "eu-west-1"
        ));
        assert!(
            accepts("https://s3.amazonaws.com", "eu-west-1"),
            "no region in the host to judge"
        );
        assert!(!accepts("https://s3.amazonaws.com", "us-east-1"));
    }

    #[test]
    fn a_non_aws_endpoint_outside_the_declared_eu_hosts_stops_the_start() {
        let found = problems(with(
            "LETTERHEAD_S3_ENDPOINT",
            "https://s3.us-west-2.example-cloud.com",
        ));
        assert_eq!(found.len(), 1);
        let expected = "does not match any entry in LETTERHEAD_S3_EU_ENDPOINT_HOSTS";
        assert!(found[0].contains(expected), "{found:?}");
    }

    #[test]
    fn a_non_aws_endpoint_without_a_declared_allowlist_stops_the_start() {
        for hosts in ["", " , ,"] {
            let found = problems(with("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", hosts));
            assert_eq!(found.len(), 1, "{hosts:?}");
            let expected = "LETTERHEAD_S3_EU_ENDPOINT_HOSTS is empty or unset";
            assert!(found[0].contains(expected), "{found:?}");
        }
        let mut env = valid();
        env.remove("LETTERHEAD_S3_EU_ENDPOINT_HOSTS");
        assert_eq!(
            problems(load(&env)).len(),
            1,
            "an unset allowlist fails closed too"
        );
    }

    #[test]
    fn the_allowlist_matches_the_host_or_a_subdomain_of_it_only() {
        let allow = |endpoint: &str, hosts: &str| {
            let mut env = valid();
            env.insert("LETTERHEAD_S3_ENDPOINT", endpoint.to_owned());
            env.insert("LETTERHEAD_S3_EU_ENDPOINT_HOSTS", hosts.to_owned());
            load(&env).is_ok()
        };
        assert!(allow("http://minio:9000", "minio"));
        assert!(allow(
            "https://bucket.s3.eu-ams.example.com",
            "s3.eu-ams.example.com"
        ));
        assert!(
            allow("https://S3.EU-Ams.example.com", "S3.EU-AMS.example.com"),
            "case"
        );
        assert!(allow("http://localhost:9000", "s3.example.com, localhost"));
        // Suffix text is not a subdomain.
        assert!(!allow("https://evilminio:9000", "minio"));
        assert!(!allow("https://minio.evil.example", "minio"));
        // The text before an `@` is user info, not the host.
        assert!(!allow("http://minio@evil.example:9000", "minio"));
        // An AWS-looking prefix on another domain is a non-AWS host and needs the allowlist.
        assert!(!allow("https://s3.amazonaws.com.evil.example", "minio"));
    }

    // ── no secret reaches a message ──────────────────────────────────────────────────────────────────────────

    #[test]
    fn no_secret_reaches_an_error_or_a_debug_print() {
        let config = load(&valid()).expect("valid");
        let printed = format!("{config:?}");
        for secret in [SECRET_DB, "db-pass-7f3a", SECRET_KEY_ID, SECRET_KEY] {
            assert!(!printed.contains(secret), "Debug of Config leaks {secret}");
        }

        // Malformed secrets: every error line is built from variable names and rules only.
        let mut env = valid();
        env.insert(
            "DATABASE_URL",
            "mysql://letterhead:db-pass-7f3a@postgres/db".to_owned(),
        );
        let endpoint = format!("https://{SECRET_KEY}@s3.us-east-1.amazonaws.com");
        env.insert("LETTERHEAD_S3_ENDPOINT", endpoint);
        env.insert("LETTERHEAD_S3_REGION", "us-east-1".to_owned());
        let found = ConfigError(problems(load(&env))).to_string();
        for secret in ["db-pass-7f3a", SECRET_KEY, SECRET_KEY_ID] {
            assert!(
                !found.contains(secret),
                "an error line leaks {secret}: {found}"
            );
        }
    }
}
