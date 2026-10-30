use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use arc_swap::ArcSwap;
use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use governor::{DefaultDirectRateLimiter, DefaultKeyedRateLimiter, Quota, RateLimiter};
use serde::{Deserialize, Serialize};
use tower::ServiceExt;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, NotForContentType, Predicate};
use tower_http::services::{ServeDir, ServeFile};

use crate::catalog::{Manifest, is_audio_id};
use crate::db::{self, Db, Event, EventKind};
use crate::library::unix_now;
use crate::pages;

const MAX_EVENTS_PER_BATCH: usize = 200;
const MAX_BODY: usize = 32 * 1024;

pub struct Limits {
    any: DefaultKeyedRateLimiter<IpAddr>,
    requests: DefaultKeyedRateLimiter<IpAddr>,
    plays: DefaultKeyedRateLimiter<IpAddr>,
    completions: DefaultKeyedRateLimiter<IpAddr>,
    logs: DefaultKeyedRateLimiter<IpAddr>,
    plays_total: DefaultDirectRateLimiter,
    completions_total: DefaultDirectRateLimiter,
}

fn quota(per: Duration, burst: u32) -> Quota {
    let burst = NonZeroU32::new(burst).unwrap_or(NonZeroU32::MIN);
    Quota::with_period(per)
        .unwrap_or_else(|| Quota::per_second(NonZeroU32::MIN))
        .allow_burst(burst)
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            any: RateLimiter::keyed(quota(Duration::from_millis(10), 600)),
            requests: RateLimiter::keyed(quota(Duration::from_secs(2), 30)),
            plays: RateLimiter::keyed(quota(Duration::from_secs(4), 60)),
            completions: RateLimiter::keyed(quota(Duration::from_secs(120), 4)),
            logs: RateLimiter::keyed(quota(Duration::from_secs(10), 5)),
            plays_total: RateLimiter::direct(quota(Duration::from_millis(5), 2000)),
            completions_total: RateLimiter::direct(quota(Duration::from_secs(1), 50)),
        }
    }
}

impl Limits {
    pub fn shrink(&self) {
        self.any.retain_recent();
        self.requests.retain_recent();
        self.plays.retain_recent();
        self.completions.retain_recent();
        self.logs.retain_recent();
    }
}

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Db>,
    pub current: Arc<ArcSwap<Manifest>>,
    pub audio_dir: PathBuf,
    pub web_dir: PathBuf,
    pub public_url: Option<Arc<str>>,
    pub limits: Arc<Limits>,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/manifest", get(manifest))
        .route("/api/events", post(events))
        .route("/api/log", post(client_log))
        .route("/api/health", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::max(MAX_BODY));

    let shell_state = state.clone();
    let app_shell = tower::service_fn(move |req: Request| {
        let st = shell_state.clone();
        async move {
            let path = req.uri().path().to_owned();
            if !is_app_route(&path) && looks_like_file(&path) {
                return Ok::<_, std::convert::Infallible>(
                    error_page(&st.web_dir, StatusCode::NOT_FOUND).await,
                );
            }
            Ok(app_page(&st, &path, req.headers()).await)
        }
    });
    let web = ServeDir::new(&state.web_dir)
        .precompressed_br()
        .precompressed_gzip()
        .append_index_html_on_directories(false)
        .fallback(app_shell);

    Router::new()
        .merge(api)
        .route("/", get(index_page))
        .route("/index.html", get(index_page))
        .route("/a/{file}", get(audio))
        .fallback_service(web)
        .layer(middleware::from_fn_with_state(state.clone(), throttle))
        .layer(middleware::from_fn(resolve_client))
        .layer(CatchPanicLayer::custom(
            |_: Box<dyn std::any::Any + Send>| {
                tracing::error!("request handler panicked");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            },
        ))
        .layer(middleware::from_fn_with_state(state.clone(), html_errors))
        .layer(
            CompressionLayer::new().compress_when(
                DefaultPredicate::new()
                    .and(NotForContentType::const_new("audio/"))
                    .and(NotForContentType::const_new("font/")),
            ),
        )
        .layer(middleware::from_fn(headers))
        .with_state(state)
}

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'{STYLES}; img-src 'self' data:; \
     font-src 'self'; media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; connect-src 'self'; \
     frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

async fn index_page(State(st): State<AppState>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    app_page(&st, &path, req.headers()).await
}

fn public_base(st: &AppState, headers: &HeaderMap) -> String {
    if let Some(u) = &st.public_url {
        return u.to_string();
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .filter(|h| {
            h.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
        })
        .unwrap_or("localhost");
    format!("https://{host}")
}

async fn app_page(st: &AppState, path: &str, headers: &HeaderMap) -> Response {
    let shell = match tokio::fs::read_to_string(st.web_dir.join("index.html")).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "app shell missing");
            return error_page(&st.web_dir, StatusCode::SERVICE_UNAVAILABLE).await;
        }
    };
    let meta = pages::meta_for(path);
    let html = pages::render(&shell, &meta, &public_base(st, headers));
    let styles: String = pages::inline_style_hashes(&html)
        .into_iter()
        .map(|h| format!(" {h}"))
        .collect();
    let status = if meta.found {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    };
    let mut res = (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_owned()),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
            (
                header::CONTENT_SECURITY_POLICY,
                CSP.replace("{STYLES}", &styles),
            ),
        ],
        html,
    )
        .into_response();
    if !meta.indexable {
        res.headers_mut()
            .insert("x-robots-tag", HeaderValue::from_static("noindex"));
    }
    res
}

pub fn is_app_route(path: &str) -> bool {
    let p = if path.len() > 1 {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    matches!(
        p,
        "/" | "/index.html"
            | "/prep"
            | "/prep/selective"
            | "/prep/result"
            | "/prep/selective/result"
            | "/select"
            | "/playlist"
            | "/settings"
            | "/stats"
            | "/data"
    ) || p.strip_prefix("/playlist/").is_some_and(is_audio_id)
}

fn looks_like_file(path: &str) -> bool {
    path.rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'))
        || ["/assets/", "/a/", "/api/", "/errors/"]
            .iter()
            .any(|p| path.starts_with(p))
}

fn error_file(status: StatusCode) -> u16 {
    match status.as_u16() {
        403 => 403,
        404 | 410 => 404,
        429 => 429,
        502..=504 => 503,
        500..=599 => 500,
        _ => 400,
    }
}

async fn error_page(web_dir: &std::path::Path, status: StatusCode) -> Response {
    let file = web_dir
        .join("errors")
        .join(format!("{}.html", error_file(status)));
    match tokio::fs::read(&file).await {
        Ok(html) => (
            status,
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-store"),
                (header::HeaderName::from_static("x-robots-tag"), "noindex"),
            ],
            html,
        )
            .into_response(),
        Err(_) => (status, status.canonical_reason().unwrap_or("Error")).into_response(),
    }
}

async fn html_errors(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let wants_html = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/html"));
    let path = req.uri().path().to_owned();
    let res = next.run(req).await;
    let status = res.status();
    let empty = axum::body::HttpBody::size_hint(res.body()).exact() == Some(0);
    if !wants_html
        || !empty
        || status.as_u16() < 400
        || path.starts_with("/api/")
        || path.starts_with("/a/")
    {
        return res;
    }
    let mut page = error_page(&st.web_dir, status).await;
    if let Some(v) = res.headers().get(header::RETRY_AFTER) {
        page.headers_mut().insert(header::RETRY_AFTER, v.clone());
    }
    page
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientIp(pub IpAddr);

async fn resolve_client(mut req: Request, next: Next) -> Response {
    let ip = match req.extensions().get::<ConnectInfo<SocketAddr>>() {
        Some(ConnectInfo(peer)) => client_ip(*peer, req.headers()),
        // unix socket: only the reverse proxy can connect
        None => proxied_ip(req.headers()).map_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED), group),
    };
    req.extensions_mut().insert(ClientIp(ip));
    next.run(req).await
}

async fn throttle(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let ip = req.extensions().get::<ClientIp>().map(|c| c.0);
    if let Some(ip) = ip
        && st.limits.any.check_key(&ip).is_err()
    {
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "5")]).into_response();
    }
    next.run(req).await
}

async fn headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    if !h.contains_key(header::CONTENT_SECURITY_POLICY) {
        let csp = CSP.replace("{STYLES}", "");
        if let Ok(v) = HeaderValue::from_str(&csp) {
            h.insert(header::CONTENT_SECURITY_POLICY, v);
        }
    }
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    h.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
        ),
    );
    if !h.contains_key(header::CACHE_CONTROL) {
        let cache = if path.starts_with("/assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    res
}

async fn manifest(State(st): State<AppState>, req_headers: HeaderMap) -> Response {
    let m = st.current.load_full();
    let etag = format!("\"{}\"", m.version);
    if req_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }
    (
        [
            (header::ETAG, etag),
            (header::CACHE_CONTROL, "no-cache".to_owned()),
        ],
        Json(&*m),
    )
        .into_response()
}

async fn audio(State(st): State<AppState>, Path(file): Path<String>, req: Request) -> Response {
    let Some(id) = file.strip_suffix(".mp3").filter(|id| is_audio_id(id)) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let path = st.audio_dir.join(format!("{id}.mp3"));
    match ServeFile::new(&path).oneshot(req).await {
        Ok(mut res) => {
            if res.status().is_success() {
                res.headers_mut().insert(
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("public, max-age=31536000, immutable"),
                );
            } else {
                res.headers_mut()
                    .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            }
            res.map(Body::new)
        }
        Err(never) => match never {},
    }
}

pub fn client_ip(peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    let forwarded = peer
        .ip()
        .to_canonical()
        .is_loopback()
        .then(|| proxied_ip(headers))
        .flatten();
    group(forwarded.unwrap_or(peer.ip()))
}

fn proxied_ip(headers: &HeaderMap) -> Option<IpAddr> {
    headers
        .get("x-forwarded-for")?
        .to_str()
        .ok()?
        .rsplit(',')
        .next()?
        .trim()
        .parse::<IpAddr>()
        .ok()
}

fn group(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V6(v6) => {
            let s = v6.segments();
            IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3] & 0xff00, 0, 0, 0, 0))
        }
        v4 => v4,
    }
}

#[derive(Deserialize)]
struct EventBatch {
    events: Vec<IncomingEvent>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum IncomingEvent {
    Play { id: String, track: String },
    Complete { id: String },
}

#[derive(Serialize)]
struct Ack {
    ack: Vec<String>,
}

async fn events(
    State(st): State<AppState>,
    Extension(ClientIp(ip)): Extension<ClientIp>,
    body: Result<Json<EventBatch>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if st.limits.requests.check_key(&ip).is_err() {
        return (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "30")]).into_response();
    }
    let Ok(Json(batch)) = body else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if batch.events.len() > MAX_EVENTS_PER_BATCH {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }

    let current = st.current.load_full();
    let mut ack = Vec::with_capacity(batch.events.len());
    let mut accepted = Vec::new();
    let mut dropped = 0usize;
    for e in batch.events {
        let (id, kind) = match e {
            IncomingEvent::Play { id, track } => (id, EventKind::Play { track }),
            IncomingEvent::Complete { id } => (id, EventKind::Complete),
        };
        let Ok(uuid) = uuid::Uuid::try_parse(&id) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let id = uuid.hyphenated().to_string();
        let plausible = match &kind {
            EventKind::Play { track } => {
                current.contains(track)
                    && st.limits.plays.check_key(&ip).is_ok()
                    && st.limits.plays_total.check().is_ok()
            }
            EventKind::Complete => {
                !current.tracks.is_empty()
                    && st.limits.completions.check_key(&ip).is_ok()
                    && st.limits.completions_total.check().is_ok()
            }
        };
        ack.push(id.clone());
        if plausible {
            accepted.push(Event { id, kind });
        } else {
            dropped += 1;
        }
    }
    if dropped > 0 {
        tracing::info!(dropped, "implausible or rate-limited events discarded");
    }
    if !accepted.is_empty() {
        let now = unix_now();
        if let Err(e) = st
            .db
            .call(move |c| db::record_events(c, &accepted, now))
            .await
        {
            tracing::error!(error = %e, "cannot store events");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    }
    Json(Ack { ack }).into_response()
}

#[derive(Deserialize)]
struct ClientLog {
    message: String,
    #[serde(default)]
    stack: String,
    #[serde(default)]
    context: String,
}

async fn client_log(
    State(st): State<AppState>,
    Extension(ClientIp(ip)): Extension<ClientIp>,
    body: Result<Json<ClientLog>, axum::extract::rejection::JsonRejection>,
) -> StatusCode {
    if st.limits.logs.check_key(&ip).is_err() {
        return StatusCode::TOO_MANY_REQUESTS;
    }
    let Ok(Json(log)) = body else {
        return StatusCode::BAD_REQUEST;
    };
    tracing::warn!(
        target: "client",
        message = ?sanitize(&log.message, 500),
        context = ?sanitize(&log.context, 100),
        stack = ?sanitize(&log.stack, 2000),
        "client error"
    );
    StatusCode::NO_CONTENT
}

pub fn sanitize(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .map(|w| match w.find('?') {
            Some(i) if w.contains("://") => &w[..i],
            _ => w,
        })
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_ip_only_from_loopback() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("1.1.1.1, 203.0.113.7"),
        );
        let local: SocketAddr = "127.0.0.1:5000".parse().expect("addr");
        let remote: SocketAddr = "198.51.100.2:5000".parse().expect("addr");
        assert_eq!(
            client_ip(local, &h),
            "203.0.113.7".parse::<IpAddr>().expect("ip")
        );
        assert_eq!(
            client_ip(remote, &h),
            "198.51.100.2".parse::<IpAddr>().expect("ip")
        );
    }

    #[test]
    fn ipv6_grouped_by_prefix() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
        );
        let local: SocketAddr = "[::1]:5000".parse().expect("addr");
        assert_eq!(
            client_ip(local, &h),
            "2001:db8:1::".parse::<IpAddr>().expect("ip")
        );
        let mapped: SocketAddr = "[::ffff:127.0.0.1]:5000".parse().expect("addr");
        assert_eq!(
            client_ip(mapped, &h),
            "2001:db8:1::".parse::<IpAddr>().expect("ip")
        );
    }

    #[test]
    fn sanitize_strips_controls_and_queries() {
        let s = sanitize(
            "boom\n\u{1b}[31mfake line https://x.test/a?secret=1 end",
            500,
        );
        assert_eq!(s, "boom [31mfake line https://x.test/a end");
        assert_eq!(sanitize(&"я".repeat(900), 500).chars().count(), 500);
    }
}
