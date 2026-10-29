use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::config::Telegram;
use crate::db::{self, Db};
use crate::library::unix_now;

#[derive(Clone)]
pub struct Notifier {
    db: Arc<Db>,
    wake: Arc<Notify>,
}

impl Notifier {
    pub fn new(db: Arc<Db>) -> Self {
        Self {
            db,
            wake: Arc::new(Notify::new()),
        }
    }

    pub async fn send(&self, texts: Vec<String>) {
        let now = unix_now();
        match self
            .db
            .call(move |c| db::enqueue_messages(c, &texts, now))
            .await
        {
            Ok(()) => self.wake.notify_one(),
            Err(e) => tracing::error!(error = %e, "cannot queue admin message"),
        }
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }

    pub async fn run(self, telegram: Option<Telegram>, cancel: CancellationToken) {
        let Some(tg) = telegram else {
            tracing::info!("telegram is not configured, admin messages stay queued");
            return;
        };
        let client = match build_client(&tg) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "cannot build telegram client");
                return;
            }
        };
        let mut failures: u32 = 0;
        loop {
            let next = match self.db.call(|c| db::outbox_next(c)).await {
                Ok(n) => n,
                Err(e) => {
                    tracing::error!(error = %e, "outbox read failed");
                    None
                }
            };
            let wait = match next {
                None => None,
                Some(item) => match deliver(&client, &tg, &item.text).await {
                    Ok(()) => {
                        failures = 0;
                        let id = item.id;
                        if let Err(e) = self.db.call(move |c| db::outbox_done(c, id)).await {
                            tracing::error!(error = %e, "cannot mark message as sent");
                            Some(Duration::from_secs(30))
                        } else {
                            continue;
                        }
                    }
                    Err(DeliveryError::Rejected { status: 400, body })
                        if body.contains("can't parse") =>
                    {
                        tracing::error!(%body, "telegram keeps rejecting a message, dropping it");
                        let id = item.id;
                        let _ = self.db.call(move |c| db::outbox_done(c, id)).await;
                        continue;
                    }
                    Err(e) => {
                        failures = failures.saturating_add(1);
                        let id = item.id;
                        let _ = self.db.call(move |c| db::outbox_failed(c, id)).await;
                        let delay = backoff(failures);
                        tracing::warn!(error = %e, attempt = item.attempts + 1, retry_in = ?delay, "telegram delivery failed");
                        Some(delay)
                    }
                },
            };
            tokio::select! {
                () = cancel.cancelled() => return,
                () = self.wake.notified(), if wait.is_none() => {}
                () = tokio::time::sleep(wait.unwrap_or(Duration::from_secs(3600))) => {}
            }
        }
    }
}

fn build_client(tg: &Telegram) -> Result<reqwest::Client, reqwest::Error> {
    let mut b = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10));
    if let Some(p) = &tg.proxy {
        b = b.proxy(reqwest::Proxy::all(p)?);
    }
    b.build()
}

#[derive(Debug, thiserror::Error)]
enum DeliveryError {
    #[error("network: {0}")]
    Network(reqwest::Error),
    #[error("telegram answered {status}: {body}")]
    Rejected { status: u16, body: String },
}

async fn deliver(client: &reqwest::Client, tg: &Telegram, text: &str) -> Result<(), DeliveryError> {
    let url = format!(
        "{}/bot{}/sendMessage",
        tg.api_base.trim_end_matches('/'),
        tg.token
    );
    let body = serde_json::json!({
        "chat_id": tg.chat_id,
        "text": text,
        "parse_mode": "HTML",
        "link_preview_options": { "is_disabled": true },
    });
    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| DeliveryError::Network(e.without_url()))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    let body: String = resp
        .text()
        .await
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect();
    Err(DeliveryError::Rejected {
        status: status.as_u16(),
        body,
    })
}

fn backoff(failures: u32) -> Duration {
    let secs = 5u64.saturating_mul(1u64 << failures.min(8).saturating_sub(1));
    Duration::from_secs(secs.min(600))
}

#[cfg(test)]
mod tests {
    use super::backoff;
    use std::time::Duration;

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(1), Duration::from_secs(5));
        assert_eq!(backoff(2), Duration::from_secs(10));
        assert_eq!(backoff(7), Duration::from_secs(320));
        assert_eq!(backoff(50), Duration::from_secs(600));
    }
}
