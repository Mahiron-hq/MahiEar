use std::net::SocketAddr;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use arc_swap::ArcSwap;
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use tower::ServiceExt;

use mahiear_server::catalog::Manifest;
use mahiear_server::db::{self, Db};
use mahiear_server::http::{AppState, Limits, router};
use mahiear_server::library::Library;
use mahiear_server::media::Tools;
use mahiear_server::notify::Notifier;

fn tone(path: &Path, freq: u32, volume: f32, title: &str) {
    let status = Command::new("ffmpeg")
        .args(["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i"])
        .arg(format!("sine=frequency={freq}:duration=3"))
        .args([
            "-af",
            &format!("volume={volume}"),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            "-metadata",
        ])
        .arg(format!("title={title}"))
        .arg(path)
        .status()
        .expect("ffmpeg must be installed to run these tests");
    assert!(status.success());
}

struct Fixture {
    _dir: tempfile::TempDir,
    library: Arc<Library>,
    state: AppState,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let src = dir.path().join("library");
    let data = dir.path().join("data");
    std::fs::create_dir_all(&src).expect("mkdir");
    std::fs::create_dir_all(&data).expect("mkdir");
    tone(
        &src.join("01. Вебер - Вольный стрелок - Увертюра.mp3"),
        440,
        0.05,
        "Вебер секрет",
    );
    tone(
        &src.join("02. Вебер - Вольный стрелок - Хор.mp3"),
        660,
        0.8,
        "Вебер секрет 2",
    );
    tone(
        &src.join("03. Шуберт - Липа.mp3"),
        330,
        0.3,
        "Шуберт секрет",
    );
    std::fs::write(
        src.join("04. Шуберт - Битый файл.mp3"),
        b"definitely not audio",
    )
    .expect("write");
    tone(&src.join("без номера - x.mp3"), 500, 0.3, "x");

    let db = Db::open(&data.join("stats.sqlite")).expect("db");
    let current = Arc::new(ArcSwap::from_pointee(Manifest::empty()));
    let library = Arc::new(Library {
        tools: Tools {
            ffmpeg: "ffmpeg".into(),
            ffprobe: "ffprobe".into(),
        },
        source_dir: src,
        data_dir: data,
        db: Arc::clone(&db),
        current: Arc::clone(&current),
        notifier: Notifier::new(Arc::clone(&db)),
    });
    let state = AppState {
        db,
        current,
        audio_dir: library.audio_dir(),
        web_dir: dir.path().join("web"),
        public_url: Some(Arc::from("https://ear.example")),
        limits: Arc::new(Limits::default()),
    };
    Fixture {
        _dir: dir,
        library,
        state,
    }
}

async fn send(
    state: &AppState,
    req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut req = req;
    req.extensions_mut()
        .insert(ConnectInfo(SocketAddr::from(([203, 0, 113, 9], 4000))));
    let res = router(state.clone())
        .oneshot(req)
        .await
        .expect("infallible");
    let status = res.status();
    let headers = res.headers().clone();
    let body = res
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes()
        .to_vec();
    (status, headers, body)
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).expect("request")
}

fn post_json(uri: &str, json: serde_json::Value) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json.to_string()))
        .expect("request")
}

#[tokio::test]
async fn publishes_valid_files_and_reports_bad_ones() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let m = f.state.current.load_full();
    assert_eq!(m.tracks.len(), 3);
    assert_eq!(m.blocks.len(), 2);
    assert_eq!(m.tracks[0].part.as_deref(), Some("Увертюра"));
    assert!(
        m.tracks[0].gain > m.tracks[1].gain,
        "quiet track should get more gain"
    );

    let msg = f
        .state
        .db
        .call(|c| db::outbox_next(c))
        .await
        .expect("db")
        .expect("problem report queued");
    assert!(msg.text.contains("файлы не опубликованы: 2"));
    assert!(msg.text.contains("Битый файл"));
    assert!(msg.text.contains("без номера"));

    f.library.publish_now().await.expect("republish");
    let first = f
        .state
        .db
        .call(|c| db::outbox_next(c))
        .await
        .expect("db")
        .expect("item");
    f.state
        .db
        .call(move |c| db::outbox_done(c, first.id))
        .await
        .expect("db");
    assert!(
        f.state
            .db
            .call(|c| db::outbox_next(c))
            .await
            .expect("db")
            .is_none(),
        "same problems are not resent"
    );
}

#[tokio::test]
async fn audio_is_served_without_tags_and_with_ranges() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let id = f.state.current.load().tracks[0].id.clone();

    let (status, _, body) = send(&f.state, get(&format!("/a/{id}.mp3"))).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8_lossy(&body);
    assert!(!text.contains("секрет") && !text.contains("TIT2") && !text.contains("Вебер"));

    let req = Request::get(format!("/a/{id}.mp3"))
        .header(header::RANGE, "bytes=0-9")
        .body(Body::empty())
        .expect("req");
    let (status, headers, body) = send(&f.state, req).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(body.len(), 10);
    assert!(
        headers[header::CACHE_CONTROL]
            .to_str()
            .expect("ascii")
            .contains("immutable")
    );

    for bad in [
        "/a/..%2F..%2Fstats.sqlite",
        "/a/0123456789abcdef01234567.mp3",
        "/a/manifest.json",
    ] {
        let (status, _, _) = send(&f.state, get(bad)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
}

#[tokio::test]
async fn manifest_supports_etag() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let (status, headers, body) = send(&f.state, get("/api/manifest")).await;
    assert_eq!(status, StatusCode::OK);
    let m: Manifest = serde_json::from_slice(&body).expect("json");
    assert_eq!(m.tracks.len(), 3);
    assert!(headers.contains_key(header::CONTENT_SECURITY_POLICY));
    let etag = headers[header::ETAG].clone();
    let req = Request::get("/api/manifest")
        .header(header::IF_NONE_MATCH, etag)
        .body(Body::empty())
        .expect("req");
    let (status, _, _) = send(&f.state, req).await;
    assert_eq!(status, StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn events_are_deduplicated_and_validated() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let track = f.state.current.load().tracks[1].id.clone();
    let batch = serde_json::json!({ "events": [
        { "type": "play", "id": "6f9619ff-8b86-d011-b42d-00cf4fc964ff", "track": track },
        { "type": "play", "id": "7f9619ff-8b86-d011-b42d-00cf4fc964ff", "track": "000000000000000000000000" },
        { "type": "complete", "id": "8f9619ff-8b86-d011-b42d-00cf4fc964ff" },
    ]});
    for _ in 0..2 {
        let (status, _, body) = send(&f.state, post_json("/api/events", batch.clone())).await;
        assert_eq!(status, StatusCode::OK);
        let ack: serde_json::Value = serde_json::from_slice(&body).expect("json");
        assert_eq!(ack["ack"].as_array().expect("array").len(), 3);
    }
    let report = f
        .state
        .db
        .call(|c| {
            db::init_report_clock(c, 0)?;
            db::close_report_period(c, 1, |_| Vec::new())
        })
        .await
        .expect("db");
    assert_eq!(report.total_plays, 1);
    assert_eq!(report.total_completions, 1);

    let (status, _, _) = send(
        &f.state,
        post_json(
            "/api/events",
            serde_json::json!({ "events": [{ "type": "play", "id": "nope", "track": track }] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _, _) = send(
        &f.state,
        post_json("/api/events", serde_json::json!({ "x": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn replacing_the_set_archives_removed_tracks() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let old = f.state.current.load_full();
    let removed = old.tracks[2].id.clone();
    let batch = serde_json::json!({ "events": [
        { "type": "play", "id": "9f9619ff-8b86-d011-b42d-00cf4fc964ff", "track": removed },
    ]});
    send(&f.state, post_json("/api/events", batch)).await;

    std::fs::remove_file(f.library.source_dir.join("03. Шуберт - Липа.mp3")).expect("remove");
    tone(
        &f.library.source_dir.join("03. Шуберт - Шарманщик.mp3"),
        880,
        0.3,
        "new",
    );
    f.library.publish_now().await.expect("republish");
    let new = f.state.current.load_full();
    assert_ne!(new.version, old.version);
    assert_eq!(new.tracks.len(), 3);
    assert!(!new.contains(&removed));
    let archived: i64 = f
        .state
        .db
        .call(move |c| {
            Ok(c.query_row(
                "SELECT count FROM archived_plays WHERE track_id = ?1",
                [removed],
                |r| r.get(0),
            )?)
        })
        .await
        .expect("archived row");
    assert_eq!(archived, 1);
}

#[tokio::test]
async fn requests_through_a_unix_socket_proxy_are_accepted() {
    let f = fixture();
    f.library.publish_now().await.expect("publish");
    let track = f.state.current.load().tracks[0].id.clone();
    let req = Request::post("/api/events")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", "198.51.100.7")
        .body(Body::from(
            serde_json::json!({ "events": [
                { "type": "play", "id": "af9619ff-8b86-d011-b42d-00cf4fc964ff", "track": track },
            ]})
            .to_string(),
        ))
        .expect("request");
    let res = router(f.state.clone())
        .oneshot(req)
        .await
        .expect("infallible");
    assert_eq!(res.status(), StatusCode::OK);
    let res = router(f.state.clone())
        .oneshot(get("/api/health"))
        .await
        .expect("infallible");
    assert_eq!(res.status(), StatusCode::OK);
}

fn web_fixture(f: &Fixture) {
    let errors = f.state.web_dir.join("errors");
    std::fs::create_dir_all(&errors).expect("mkdir");
    std::fs::write(
        f.state.web_dir.join("index.html"),
        "<!doctype html><html><head><title>MahiEar</title><style>.x{}</style></head><body>shell</body></html>",
    )
    .expect("write");
    for code in [400, 403, 404, 429, 500, 503] {
        std::fs::write(
            errors.join(format!("{code}.html")),
            format!("<p>page {code}</p>"),
        )
        .expect("write");
    }
}

fn html(uri: &str) -> Request<Body> {
    Request::get(uri)
        .header(header::ACCEPT, "text/html")
        .body(Body::empty())
        .expect("request")
}

#[tokio::test]
async fn app_routes_get_200_and_unknown_addresses_get_404() {
    let f = fixture();
    web_fixture(&f);
    for ok in [
        "/",
        "/prep",
        "/prep/selective/",
        "/select",
        "/playlist",
        "/data",
    ] {
        let (status, headers, body) = send(&f.state, html(ok)).await;
        assert_eq!(status, StatusCode::OK, "{ok}");
        assert!(String::from_utf8_lossy(&body).contains("shell"), "{ok}");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    }
    for unknown in [
        "/wdsf",
        "/prep/123",
        "/playlist/abc",
        "/playlist/0123456789abcdef01234567",
        "/some/deep/link",
    ] {
        let (status, _, body) = send(&f.state, html(unknown)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{unknown}");
        assert!(
            String::from_utf8_lossy(&body).contains("shell"),
            "{unknown} renders the app page"
        );
    }
    for missing in ["/assets/gone-123.js", "/nope.png", "/errors/999.html"] {
        let (status, _, body) = send(&f.state, get(missing)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
        assert!(
            String::from_utf8_lossy(&body).contains("page 404"),
            "{missing} is not the main page"
        );
    }
    let (status, _, body) = send(&f.state, get("/api/unknown")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!String::from_utf8_lossy(&body).contains("shell"));
}

#[tokio::test]
async fn browser_errors_get_styled_pages_with_real_codes() {
    let f = fixture();
    web_fixture(&f);
    let req = Request::post("/settings")
        .header(header::ACCEPT, "text/html")
        .body(Body::empty())
        .expect("req");
    let (status, headers, body) = send(&f.state, req).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(String::from_utf8_lossy(&body).contains("page 400"));
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .expect("ascii")
            .starts_with("text/html")
    );
}

#[tokio::test]
async fn link_previews_are_in_the_html_and_never_name_excerpts() {
    let f = fixture();
    web_fixture(&f);
    f.library.publish_now().await.expect("publish");
    let (status, headers, body) = send(&f.state, html("/playlist")).await;
    assert_eq!(status, StatusCode::OK);
    let page = String::from_utf8_lossy(&body);
    for needle in [
        r#"property="og:title" content="Плейлист · MahiEar""#,
        r#"property="og:url" content="https://ear.example/playlist""#,
        r#"property="og:image" content="https://ear.example/og-image.png""#,
        r#"name="twitter:card" content="summary_large_image""#,
        r#"rel="canonical" href="https://ear.example/playlist""#,
    ] {
        assert!(page.contains(needle), "{needle}");
    }
    let csp = headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .expect("ascii");
    assert!(
        csp.contains("'sha256-"),
        "inline style allowed by hash: {csp}"
    );
    assert!(!csp.contains("unsafe-inline"));

    for p in ["/prep", "/prep/selective", "/prep/result"] {
        let (_, headers, body) = send(&f.state, html(p)).await;
        let page = String::from_utf8_lossy(&body);
        for t in f.state.current.load().tracks.iter() {
            assert!(!page.contains(&t.work), "{p} leaks a title");
            assert!(!page.contains(&t.id), "{p} leaks an id");
        }
        assert!(page.contains("noindex"));
        assert_eq!(headers["x-robots-tag"], "noindex");
    }

    let (status, headers, body) = send(&f.state, html("/wdsf")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(headers["x-robots-tag"], "noindex");
    assert!(String::from_utf8_lossy(&body).contains("Страница не найдена"));
}
