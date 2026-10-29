use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use tokio::process::Command;

use crate::catalog::Loudness;

const TOOL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("не удалось запустить {tool}: {source}")]
    Spawn {
        tool: String,
        source: std::io::Error,
    },
    #[error("{tool} не уложился в отведённое время")]
    Timeout { tool: String },
    #[error("файл повреждён или не читается: {0}")]
    Corrupt(String),
    #[error("это не MP3 (кодек {0})")]
    WrongCodec(String),
    #[error("нулевая длительность")]
    Empty,
}

#[derive(Clone, Debug)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Analysis {
    pub duration: f64,
    pub loudness: Loudness,
}

impl Tools {
    pub async fn strip_tags(&self, src: &Path, dst: &Path) -> Result<(), MediaError> {
        let out = self
            .run(
                &self.ffmpeg,
                &[
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-f",
                    "mp3",
                    "-protocol_whitelist",
                    "file",
                    "-i",
                ],
                src,
                &[
                    "-map",
                    "0:a:0",
                    "-c:a",
                    "copy",
                    "-map_metadata",
                    "-1",
                    "-map_chapters",
                    "-1",
                    "-id3v2_version",
                    "0",
                    "-write_id3v1",
                    "0",
                    "-fflags",
                    "+bitexact",
                    "-flags:a",
                    "+bitexact",
                    "-f",
                    "mp3",
                ],
                Some(dst),
            )
            .await?;
        if !out.status.success() {
            return Err(MediaError::Corrupt(first_line(&out.stderr)));
        }
        Ok(())
    }

    pub async fn analyze(&self, path: &Path) -> Result<Analysis, MediaError> {
        let probe = self
            .run(
                &self.ffprobe,
                &[
                    "-v",
                    "error",
                    "-f",
                    "mp3",
                    "-protocol_whitelist",
                    "file",
                    "-show_entries",
                    "stream=codec_name:format=duration",
                    "-of",
                    "json",
                    "-i",
                ],
                path,
                &[],
                None,
            )
            .await?;
        if !probe.status.success() {
            return Err(MediaError::Corrupt(first_line(&probe.stderr)));
        }
        let probed: Probe = serde_json::from_slice(&probe.stdout)
            .map_err(|e| MediaError::Corrupt(e.to_string()))?;
        let codec = probed
            .streams
            .first()
            .map(|s| s.codec_name.clone())
            .unwrap_or_default();
        if codec != "mp3" {
            return Err(MediaError::WrongCodec(codec));
        }

        let decode = self
            .run(
                &self.ffmpeg,
                &[
                    "-nostdin",
                    "-hide_banner",
                    "-nostats",
                    "-loglevel",
                    "level+info",
                    "-xerror",
                    "-f",
                    "mp3",
                    "-protocol_whitelist",
                    "file",
                    "-i",
                ],
                path,
                &["-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"],
                None,
            )
            .await?;
        let log = String::from_utf8_lossy(&decode.stderr);
        if !decode.status.success() {
            return Err(MediaError::Corrupt(
                error_lines(&log).unwrap_or_else(|| "ошибка декодирования".into()),
            ));
        }
        if let Some(err) = error_lines(&log) {
            return Err(MediaError::Corrupt(err));
        }

        let duration = probed
            .format
            .duration
            .as_deref()
            .and_then(|d| d.parse::<f64>().ok())
            .unwrap_or(0.0);
        if !(duration.is_finite() && duration > 0.0) {
            return Err(MediaError::Empty);
        }
        Ok(Analysis {
            duration,
            loudness: parse_ebur128(&log),
        })
    }

    async fn run(
        &self,
        tool: &Path,
        before: &[&str],
        input: &Path,
        after: &[&str],
        output: Option<&Path>,
    ) -> Result<std::process::Output, MediaError> {
        let name = tool.display().to_string();
        let mut cmd = Command::new(tool);
        cmd.args(before).arg(input).args(after);
        if let Some(o) = output {
            cmd.arg(o);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let child = cmd.spawn().map_err(|source| MediaError::Spawn {
            tool: name.clone(),
            source,
        })?;
        match tokio::time::timeout(TOOL_TIMEOUT, child.wait_with_output()).await {
            Ok(res) => res.map_err(|source| MediaError::Spawn { tool: name, source }),
            Err(_) => Err(MediaError::Timeout { tool: name }),
        }
    }
}

#[derive(Deserialize)]
struct Probe {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}

#[derive(Deserialize)]
struct ProbeStream {
    codec_name: String,
}

#[derive(Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
}

fn parse_ebur128(log: &str) -> Loudness {
    let summary = log.rfind("Summary:").map_or("", |i| &log[i..]);
    let value = |label: &str| {
        summary
            .lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix(label))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite())
    };
    Loudness {
        integrated_lufs: value("I:"),
        true_peak_dbtp: value("Peak:"),
    }
}

fn error_lines(log: &str) -> Option<String> {
    let errors: Vec<String> = log
        .lines()
        .filter(|l| l.contains("[error]") || l.contains("[fatal]"))
        .take(3)
        .map(clean)
        .collect();
    (!errors.is_empty()).then(|| errors.join("; "))
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(clean)
        .find(|l| !l.is_empty())
        .unwrap_or_else(|| "неизвестная ошибка".into())
}

// ffmpeg prefixes carry addresses that change every run
fn clean(line: &str) -> String {
    let mut rest = line.trim();
    while let Some(after) = rest
        .strip_prefix('[')
        .and_then(|r| r.split_once(']'))
        .map(|(_, a)| a.trim_start())
    {
        rest = after;
    }
    rest.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ebur128_summary() {
        let log = "[info] t: 1.0 M: -20
[Parsed_ebur128_0 @ 0x1] [info] Summary:

  Integrated loudness:
    I:         -27.1 LUFS
    Threshold: -37.5 LUFS

  True peak:
    Peak:       -8.7 dBFS
";
        let l = parse_ebur128(log);
        assert_eq!(l.integrated_lufs, Some(-27.1));
        assert_eq!(l.true_peak_dbtp, Some(-8.7));
    }

    #[test]
    fn silent_input_has_no_loudness() {
        let log = "Summary:
    I:         -inf LUFS
    Peak:      -inf dBFS
";
        assert_eq!(
            parse_ebur128(log),
            Loudness {
                integrated_lufs: None,
                true_peak_dbtp: None
            }
        );
    }

    #[test]
    fn finds_decoder_errors() {
        assert!(error_lines("[info] ok\n[mp3float @ 0x1] [error] Header missing\n").is_some());
        assert!(error_lines("[info] ok\n[warning] meh\n").is_none());
    }
}
