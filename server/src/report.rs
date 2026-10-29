use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use jiff::civil::Time;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};
use tokio_util::sync::CancellationToken;

use crate::db::{self, Db, ReportData};
use crate::library::{FileProblem, unix_now};
use crate::notify::Notifier;

const MESSAGE_LIMIT: usize = 3800;
const SEEN_EVENTS_TTL_DAYS: i64 = 400;
const BACKUPS_KEPT: usize = 14;

pub struct Schedule {
    pub at: Time,
    pub tz: TimeZone,
}

impl Schedule {
    pub fn next_after(&self, last: Timestamp) -> Timestamp {
        let local = last.to_zoned(self.tz.clone());
        let mut date = local.date();
        loop {
            let candidate = date
                .to_datetime(self.at)
                .to_zoned(self.tz.clone())
                .map(|z| z.timestamp());
            match candidate {
                Ok(ts) if ts > last => return ts,
                _ => match date.tomorrow() {
                    Ok(d) => date = d,
                    Err(_) => return last.checked_add(24.hours()).unwrap_or(last),
                },
            }
        }
    }

    fn format(&self, unix: i64) -> String {
        Timestamp::from_second(unix)
            .map(|t| {
                t.to_zoned(self.tz.clone())
                    .strftime("%d.%m.%Y %H:%M")
                    .to_string()
            })
            .unwrap_or_default()
    }
}

pub async fn run_reports(
    db: Arc<Db>,
    notifier: Notifier,
    schedule: Schedule,
    cancel: CancellationToken,
) {
    if let Err(e) = db.call(|c| db::init_report_clock(c, unix_now())).await {
        tracing::error!(error = %e, "cannot initialise report clock");
    }
    let schedule = Arc::new(schedule);
    loop {
        let wait = match db.call(|c| db::last_report_at(c)).await {
            Ok(Some(last)) => {
                let due = Timestamp::from_second(last)
                    .map(|t| schedule.next_after(t))
                    .unwrap_or_else(|_| Timestamp::now());
                let now = Timestamp::now();
                if now >= due {
                    let s = Arc::clone(&schedule);
                    match db
                        .call(move |c| {
                            db::close_report_period(c, now.as_second(), |d| render_report(d, &s))
                        })
                        .await
                    {
                        Ok(data) => {
                            tracing::info!(changes = data.changes.len(), "daily report queued");
                            notifier.wake();
                        }
                        Err(e) => tracing::error!(error = %e, "report generation failed"),
                    }
                    Duration::from_secs(1)
                } else {
                    let left = (due.as_second() - now.as_second()).max(1);
                    Duration::from_secs(u64::try_from(left).unwrap_or(1).min(300))
                }
            }
            Ok(None) => Duration::from_secs(60),
            Err(e) => {
                tracing::error!(error = %e, "report clock read failed");
                Duration::from_secs(60)
            }
        };
        tokio::select! {
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(wait) => {}
        }
    }
}

pub fn render_report(d: &ReportData, schedule: &Schedule) -> Vec<String> {
    let period = format!(
        "{} – {}",
        schedule.format(d.period_start),
        schedule.format(d.period_end)
    );
    if d.changes.is_empty() && d.new_completions == 0 {
        let text = if d.period_end - d.period_start <= 26 * 3600 {
            "За сутки изменений нет".to_owned()
        } else {
            format!("Изменений нет\n<i>{}</i>", escape(&period))
        };
        return vec![text];
    }

    let new_plays: i64 = d.changes.iter().map(|c| c.plays).sum();
    let mut lines = vec![
        "<b>MahiEar · отчёт</b>".to_owned(),
        format!("<i>{}</i>", escape(&period)),
        String::new(),
        format!("<b>Новые прослушивания: +{new_plays}</b>"),
    ];
    lines.extend(
        d.changes
            .iter()
            .map(|c| format!("+{} · {}", c.plays, escape(&c.title))),
    );
    lines.push(String::new());
    lines.push(format!(
        "<b>Завершённые прогоны: +{}</b>",
        d.new_completions
    ));
    lines.push(String::new());
    lines.push("<b>Всего</b>".to_owned());
    lines.push(format!("Прослушиваний: {}", d.total_plays));
    lines.push(format!("Завершённых прогонов: {}", d.total_completions));
    chunk(&lines)
}

pub fn render_problems(problems: &[FileProblem]) -> Vec<String> {
    let mut lines = vec![
        format!("<b>MahiEar · файлы не опубликованы: {}</b>", problems.len()),
        String::new(),
    ];
    for p in problems {
        lines.push(format!(
            "• {}\n  <i>{}</i>",
            escape(&p.file),
            escape(&p.reason)
        ));
    }
    chunk(&lines)
}

fn chunk(lines: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for line in lines {
        if !cur.is_empty() && cur.len() + line.len() + 1 > MESSAGE_LIMIT {
            out.push(std::mem::take(&mut cur).trim_end().to_owned());
        }
        if !cur.is_empty() {
            cur.push('\n');
        }
        cur.push_str(line);
    }
    if !cur.trim().is_empty() {
        out.push(cur.trim_end().to_owned());
    }
    out
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub async fn run_maintenance(db: Arc<Db>, backup_dir: PathBuf, cancel: CancellationToken) {
    loop {
        if let Err(e) = tokio::fs::create_dir_all(&backup_dir).await {
            tracing::error!(error = %e, dir = %backup_dir.display(), "cannot create backup dir");
        } else {
            let name = format!(
                "stats-{}.sqlite",
                Timestamp::now().strftime("%Y%m%d-%H%M%S")
            );
            let path = backup_dir.join(name);
            let before = unix_now() - SEEN_EVENTS_TTL_DAYS * 86_400;
            let target = path.clone();
            let res = db
                .call(move |c| {
                    db::prune_seen(c, before)?;
                    db::backup_to(c, &target)
                })
                .await;
            match res {
                Ok(()) => {
                    restrict(&path);
                    tracing::info!(file = %path.display(), "backup written");
                    if let Err(e) = prune_backups(&backup_dir) {
                        tracing::warn!(error = %e, "old backups not removed");
                    }
                }
                Err(e) => tracing::error!(error = %e, "backup failed"),
            }
        }
        tokio::select! {
            () = cancel.cancelled() => return,
            () = tokio::time::sleep(Duration::from_secs(24 * 3600)) => {}
        }
    }
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!(error = %e, "cannot restrict backup permissions");
    }
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {}

fn prune_backups(dir: &std::path::Path) -> std::io::Result<()> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("stats-") && n.ends_with(".sqlite"))
        })
        .collect();
    files.sort();
    let excess = files.len().saturating_sub(BACKUPS_KEPT);
    for f in files.into_iter().take(excess) {
        std::fs::remove_file(f)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::TrackDelta;

    fn moscow() -> Schedule {
        Schedule {
            at: Time::constant(21, 0, 0, 0),
            tz: TimeZone::get("Europe/Moscow").expect("tzdb"),
        }
    }

    fn ts(s: &str) -> Timestamp {
        s.parse().expect("timestamp")
    }

    #[test]
    fn next_report_time() {
        let s = moscow();
        assert_eq!(
            s.next_after(ts("2026-10-30T10:00:00Z")),
            ts("2026-10-30T18:00:00Z")
        );
        assert_eq!(
            s.next_after(ts("2026-10-30T18:00:00Z")),
            ts("2026-10-31T18:00:00Z")
        );
        assert_eq!(
            s.next_after(ts("2026-10-30T19:00:00Z")),
            ts("2026-10-31T18:00:00Z")
        );
    }

    #[test]
    fn next_report_time_across_dst() {
        let s = Schedule {
            at: Time::constant(2, 30, 0, 0),
            tz: TimeZone::get("Europe/Berlin").expect("tzdb"),
        };
        let next = s.next_after(ts("2026-03-28T12:00:00Z"));
        assert!(next > ts("2026-03-28T12:00:00Z"));
        assert!(next < ts("2026-03-29T12:00:00Z"));
    }

    fn data(changes: Vec<TrackDelta>, completions: i64, span: i64) -> ReportData {
        ReportData {
            period_start: 1_790_000_000,
            period_end: 1_790_000_000 + span,
            changes,
            new_completions: completions,
            total_plays: 10,
            total_completions: 3,
        }
    }

    #[test]
    fn quiet_day_is_one_short_message() {
        assert_eq!(
            render_report(&data(vec![], 0, 86_400), &moscow()),
            vec!["За сутки изменений нет"]
        );
        let long = render_report(&data(vec![], 0, 3 * 86_400), &moscow());
        assert!(long[0].starts_with("Изменений нет"));
    }

    #[test]
    fn report_lists_changes_escaped() {
        let msg = render_report(
            &data(
                vec![TrackDelta {
                    title: "Вебер - <Ария> & хор".into(),
                    plays: 3,
                }],
                1,
                86_400,
            ),
            &moscow(),
        );
        assert_eq!(msg.len(), 1);
        assert!(msg[0].contains("+3 · Вебер - &lt;Ария&gt; &amp; хор"));
        assert!(msg[0].contains("Новые прослушивания: +3"));
        assert!(msg[0].contains("Завершённые прогоны: +1"));
        assert!(msg[0].contains("Завершённых прогонов: 3"));
    }

    #[test]
    fn long_reports_are_split() {
        let changes = (0..300)
            .map(|i| TrackDelta {
                title: format!("Отрывок номер {i} с длинным названием"),
                plays: 1,
            })
            .collect();
        let msgs = render_report(&data(changes, 0, 86_400), &moscow());
        assert!(msgs.len() > 1);
        assert!(msgs.iter().all(|m| m.len() <= MESSAGE_LIMIT));
    }
}
