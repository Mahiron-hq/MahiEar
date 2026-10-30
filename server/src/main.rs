use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use arc_swap::ArcSwap;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

use mahiear_server::catalog::Manifest;
use mahiear_server::config::Config;
use mahiear_server::db::{self, Db};
use mahiear_server::http::{self, AppState, Limits};
use mahiear_server::library::{Library, unix_now};
use mahiear_server::media::Tools;
use mahiear_server::notify::Notifier;
use mahiear_server::report::{self, Schedule};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("MAHIEAR_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_ansi(false)
        .init();

    let cfg = Config::from_env().context("configuration")?;
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("creating {}", cfg.data_dir.display()))?;
    std::fs::create_dir_all(&cfg.library_dir)
        .with_context(|| format!("creating {}", cfg.library_dir.display()))?;
    let db = Db::open(&cfg.data_dir.join("stats.sqlite")).context("opening statistics database")?;

    let current = Arc::new(ArcSwap::from_pointee(Manifest::empty()));
    let notifier = Notifier::new(Arc::clone(&db));
    let library = Arc::new(Library {
        tools: Tools {
            ffmpeg: cfg.ffmpeg.clone(),
            ffprobe: cfg.ffprobe.clone(),
        },
        source_dir: cfg.library_dir.clone(),
        data_dir: cfg.data_dir.clone(),
        db: Arc::clone(&db),
        current: Arc::clone(&current),
        notifier: notifier.clone(),
    });

    match library.load_published() {
        Some(m) => {
            let for_db = m.clone();
            db.call(move |c| db::apply_set(c, &for_db, unix_now()))
                .await?;
            current.store(Arc::new(m));
        }
        None => tracing::info!("no published set yet, processing the library in the background"),
    }

    let cancel = CancellationToken::new();
    let limits = Arc::new(Limits::default());
    let mut tasks = tokio::task::JoinSet::new();
    tasks.spawn(Arc::clone(&library).run(cfg.scan_interval, cancel.clone()));
    tasks.spawn(notifier.clone().run(cfg.telegram.clone(), cancel.clone()));
    tasks.spawn(report::run_reports(
        Arc::clone(&db),
        notifier,
        Schedule {
            at: cfg.report_time,
            tz: cfg.timezone.clone(),
        },
        cancel.clone(),
    ));
    tasks.spawn(report::run_maintenance(
        Arc::clone(&db),
        cfg.backup_dir.clone(),
        cancel.clone(),
    ));
    {
        let limits = Arc::clone(&limits);
        let cancel = cancel.clone();
        tasks.spawn(async move {
            loop {
                tokio::select! {
                    () = cancel.cancelled() => return,
                    () = tokio::time::sleep(Duration::from_secs(300)) => limits.shrink(),
                }
            }
        });
    }

    let app = http::router(AppState {
        db,
        current,
        audio_dir: library.audio_dir(),
        web_dir: cfg.web_dir.clone(),
        public_url: cfg.public_url.clone().map(Arc::from),
        limits,
    });
    let mut fds = listenfd::ListenFd::from_env();
    let shutdown = cancel.clone();
    let stop = async move {
        wait_for_signal().await;
        shutdown.cancel();
    };
    #[cfg(unix)]
    if let Some(std_listener) = fds.take_unix_listener(0).context("inherited socket")? {
        std_listener.set_nonblocking(true)?;
        let listener = tokio::net::UnixListener::from_std(std_listener)?;
        tracing::info!("listening on inherited unix socket");
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(stop)
            .await
            .context("server")?;
        cancel.cancel();
        while tasks.join_next().await.is_some() {}
        return Ok(());
    }
    let listener = match fds.take_tcp_listener(0).context("inherited socket")? {
        Some(std_listener) => {
            std_listener.set_nonblocking(true)?;
            let l = tokio::net::TcpListener::from_std(std_listener)?;
            tracing::info!(addr = ?l.local_addr().ok(), "listening on inherited socket");
            l
        }
        None => {
            let l = tokio::net::TcpListener::bind(cfg.listen)
                .await
                .with_context(|| format!("binding {}", cfg.listen))?;
            tracing::info!(addr = %cfg.listen, "listening");
            l
        }
    };
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(stop)
    .await
    .context("server")?;

    cancel.cancel();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
