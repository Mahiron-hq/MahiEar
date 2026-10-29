use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use jiff::civil::Time;
use jiff::tz::TimeZone;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{name}: {reason}")]
    Invalid { name: &'static str, reason: String },
}

#[derive(Clone)]
pub struct Telegram {
    pub token: String,
    pub chat_id: i64,
    pub api_base: String,
    pub proxy: Option<String>,
}

impl std::fmt::Debug for Telegram {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Telegram")
            .field("token", &"<redacted>")
            .field("chat_id", &self.chat_id)
            .field("api_base", &self.api_base)
            .field("proxy", &self.proxy.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub listen: SocketAddr,
    pub library_dir: PathBuf,
    pub data_dir: PathBuf,
    pub web_dir: PathBuf,
    pub backup_dir: PathBuf,
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub scan_interval: Duration,
    pub telegram: Option<Telegram>,
    pub report_time: Time,
    pub timezone: TimeZone,
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let var = |name: &str| {
            get(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let path = |name: &'static str, default: &str| {
            PathBuf::from(var(name).unwrap_or_else(|| default.to_owned()))
        };

        let listen = match var("MAHIEAR_LISTEN") {
            Some(v) => v.parse().map_err(|e| invalid("MAHIEAR_LISTEN", e))?,
            None => SocketAddr::from(([127, 0, 0, 1], 8080)),
        };
        let data_dir = path("MAHIEAR_DATA_DIR", "data");
        let backup_dir = var("MAHIEAR_BACKUP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("backups"));
        let scan_interval = match var("MAHIEAR_SCAN_SECONDS") {
            Some(v) => {
                let secs: u64 = v.parse().map_err(|e| invalid("MAHIEAR_SCAN_SECONDS", e))?;
                if secs == 0 {
                    return Err(invalid("MAHIEAR_SCAN_SECONDS", "must be positive"));
                }
                Duration::from_secs(secs)
            }
            None => Duration::from_secs(10),
        };

        let telegram = match (var("MAHIEAR_TELEGRAM_TOKEN"), var("MAHIEAR_ADMIN_CHAT_ID")) {
            (Some(token), Some(chat)) => Some(Telegram {
                token,
                chat_id: chat
                    .parse()
                    .map_err(|e| invalid("MAHIEAR_ADMIN_CHAT_ID", e))?,
                api_base: var("MAHIEAR_TELEGRAM_API")
                    .unwrap_or_else(|| "https://api.telegram.org".to_owned()),
                proxy: var("MAHIEAR_TELEGRAM_PROXY"),
            }),
            (None, None) => None,
            _ => {
                return Err(invalid(
                    "MAHIEAR_TELEGRAM_TOKEN",
                    "token and MAHIEAR_ADMIN_CHAT_ID must be set together",
                ));
            }
        };

        let report_time = match var("MAHIEAR_REPORT_TIME") {
            Some(v) => v.parse().map_err(|e| invalid("MAHIEAR_REPORT_TIME", e))?,
            None => Time::constant(21, 0, 0, 0),
        };
        let timezone = match var("MAHIEAR_TIMEZONE") {
            Some(v) => TimeZone::get(&v).map_err(|e| invalid("MAHIEAR_TIMEZONE", e))?,
            None => TimeZone::get("Europe/Moscow").map_err(|e| invalid("MAHIEAR_TIMEZONE", e))?,
        };

        Ok(Self {
            listen,
            library_dir: path("MAHIEAR_LIBRARY_DIR", "library"),
            web_dir: path("MAHIEAR_WEB_DIR", "web"),
            ffmpeg: path("MAHIEAR_FFMPEG", "ffmpeg"),
            ffprobe: path("MAHIEAR_FFPROBE", "ffprobe"),
            data_dir,
            backup_dir,
            scan_interval,
            telegram,
            report_time,
            timezone,
        })
    }
}

fn invalid(name: &'static str, reason: impl std::fmt::Display) -> ConfigError {
    ConfigError::Invalid {
        name,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(pairs: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    #[test]
    fn defaults_without_telegram() {
        let cfg = load(&[]).expect("defaults are valid");
        assert!(cfg.telegram.is_none());
        assert_eq!(cfg.report_time, Time::constant(21, 0, 0, 0));
        assert!(cfg.listen.ip().is_loopback());
    }

    #[test]
    fn telegram_requires_both_values() {
        assert!(load(&[("MAHIEAR_TELEGRAM_TOKEN", "x")]).is_err());
        let cfg = load(&[
            ("MAHIEAR_TELEGRAM_TOKEN", "x"),
            ("MAHIEAR_ADMIN_CHAT_ID", "42"),
        ])
        .expect("valid");
        assert_eq!(cfg.telegram.expect("set").chat_id, 42);
    }

    #[test]
    fn rejects_bad_values() {
        assert!(load(&[("MAHIEAR_REPORT_TIME", "25:00")]).is_err());
        assert!(load(&[("MAHIEAR_TIMEZONE", "Mars/Base")]).is_err());
        assert!(load(&[("MAHIEAR_SCAN_SECONDS", "0")]).is_err());
    }
}
