use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::catalog::{Loudness, Manifest};

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("database task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
    #[error("database lock poisoned")]
    Poisoned,
}

pub struct Db {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CachedAnalysis {
    pub audio_id: String,
    pub duration: f64,
    pub loudness: Loudness,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventKind {
    Play { track: String },
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub kind: EventKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackDelta {
    pub title: String,
    pub plays: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportData {
    pub period_start: i64,
    pub period_end: i64,
    pub changes: Vec<TrackDelta>,
    pub new_completions: i64,
    pub total_plays: i64,
    pub total_completions: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboxItem {
    pub id: i64,
    pub text: String,
    pub attempts: i64,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS analysis(
    source_hash TEXT PRIMARY KEY,
    audio_id TEXT NOT NULL,
    duration REAL NOT NULL,
    loudness REAL,
    true_peak REAL,
    analyzed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plays(
    track_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    ord INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS archived_plays(
    set_version TEXT NOT NULL,
    track_id TEXT NOT NULL,
    title TEXT NOT NULL,
    count INTEGER NOT NULL,
    archived_at INTEGER NOT NULL,
    PRIMARY KEY(set_version, track_id)
);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seen_events(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS seen_events_at ON seen_events(at);
CREATE TABLE IF NOT EXISTS report_snapshot(track_id TEXT PRIMARY KEY, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);
";

impl Db {
    pub fn open(path: &Path) -> Result<Arc<Self>, DbError> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Arc<Self>, DbError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Arc<Self>, DbError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Arc::new(Self {
            conn: Mutex::new(conn),
        }))
    }

    pub async fn call<R, F>(self: &Arc<Self>, f: F) -> Result<R, DbError>
    where
        R: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<R, DbError> + Send + 'static,
    {
        let db = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let mut conn = db.conn.lock().map_err(|_| DbError::Poisoned)?;
            f(&mut conn)
        })
        .await?
    }
}

pub fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, DbError> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()?)
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn meta_i64(conn: &Connection, key: &str) -> Result<i64, DbError> {
    Ok(meta_get(conn, key)?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0))
}

pub fn analysis_get(
    conn: &Connection,
    source_hash: &str,
) -> Result<Option<CachedAnalysis>, DbError> {
    Ok(conn
        .query_row(
            "SELECT audio_id, duration, loudness, true_peak FROM analysis WHERE source_hash = ?1",
            [source_hash],
            |r| {
                Ok(CachedAnalysis {
                    audio_id: r.get(0)?,
                    duration: r.get(1)?,
                    loudness: Loudness {
                        integrated_lufs: r.get(2)?,
                        true_peak_dbtp: r.get(3)?,
                    },
                })
            },
        )
        .optional()?)
}

pub fn analysis_put(
    conn: &Connection,
    source_hash: &str,
    a: &CachedAnalysis,
    now: i64,
) -> Result<(), DbError> {
    conn.execute(
        "INSERT OR REPLACE INTO analysis(source_hash, audio_id, duration, loudness, true_peak, analyzed_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![source_hash, a.audio_id, a.duration, a.loudness.integrated_lufs, a.loudness.true_peak_dbtp, now],
    )?;
    Ok(())
}

pub fn apply_set(conn: &mut Connection, manifest: &Manifest, now: i64) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    let previous = meta_get(&tx, "current_set")?.unwrap_or_else(|| "initial".to_owned());
    if previous != manifest.version {
        let keep: HashSet<&str> = manifest.tracks.iter().map(|t| t.id.as_str()).collect();
        let existing: Vec<(String, String, i64)> = {
            let mut st = tx.prepare("SELECT track_id, title, count FROM plays")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<Result<_, _>>()?
        };
        for (id, title, count) in existing
            .into_iter()
            .filter(|(id, _, _)| !keep.contains(id.as_str()))
        {
            tx.execute(
                "INSERT INTO archived_plays(set_version, track_id, title, count, archived_at) VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(set_version, track_id) DO UPDATE SET count = count + excluded.count",
                params![previous, id, title, count, now],
            )?;
            tx.execute("DELETE FROM plays WHERE track_id = ?1", [&id])?;
        }
    }
    for (ord, t) in manifest.tracks.iter().enumerate() {
        tx.execute(
            "INSERT INTO plays(track_id, title, ord, count) VALUES(?1, ?2, ?3, 0)
             ON CONFLICT(track_id) DO UPDATE SET title = excluded.title, ord = excluded.ord",
            params![t.id, t.title(), i64::try_from(ord).unwrap_or(i64::MAX)],
        )?;
    }
    meta_set(&tx, "current_set", &manifest.version)?;
    tx.commit()?;
    Ok(())
}

pub fn record_events(conn: &mut Connection, events: &[Event], now: i64) -> Result<usize, DbError> {
    let tx = conn.transaction()?;
    let mut applied = 0;
    for e in events {
        if tx.execute(
            "INSERT OR IGNORE INTO seen_events(id, at) VALUES(?1, ?2)",
            params![e.id, now],
        )? == 0
        {
            continue;
        }
        match &e.kind {
            EventKind::Play { track } => {
                tx.execute(
                    "UPDATE plays SET count = count + 1 WHERE track_id = ?1",
                    [track],
                )?;
            }
            EventKind::Complete => {
                let total = meta_i64(&tx, "completions")? + 1;
                meta_set(&tx, "completions", &total.to_string())?;
            }
        }
        applied += 1;
    }
    tx.commit()?;
    Ok(applied)
}

pub fn prune_seen(conn: &Connection, before: i64) -> Result<usize, DbError> {
    Ok(conn.execute("DELETE FROM seen_events WHERE at < ?1", [before])?)
}

pub fn last_report_at(conn: &Connection) -> Result<Option<i64>, DbError> {
    Ok(meta_get(conn, "last_report_at")?.and_then(|v| v.parse().ok()))
}

pub fn init_report_clock(conn: &mut Connection, now: i64) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    if last_report_at(&tx)?.is_none() {
        snapshot(&tx)?;
        meta_set(&tx, "last_report_at", &now.to_string())?;
    }
    tx.commit()?;
    Ok(())
}

pub fn close_report_period(
    conn: &mut Connection,
    now: i64,
    render: impl FnOnce(&ReportData) -> Vec<String>,
) -> Result<ReportData, DbError> {
    let tx = conn.transaction()?;
    let period_start = last_report_at(&tx)?.unwrap_or(now);

    let snap: HashMap<String, i64> = {
        let mut st = tx.prepare("SELECT track_id, count FROM report_snapshot")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    let mut rows: Vec<(String, String, i64)> = {
        let mut st = tx.prepare("SELECT track_id, title, count FROM plays ORDER BY ord")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?
    };
    let total_plays = rows.iter().map(|(_, _, c)| c).sum();
    {
        let mut st = tx.prepare(
            "SELECT track_id, title, SUM(count) FROM archived_plays WHERE archived_at >= ?1 GROUP BY track_id, title",
        )?;
        let archived = st.query_map([period_start], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        for row in archived {
            rows.push(row?);
        }
    }
    let changes = rows
        .into_iter()
        .filter_map(|(id, title, count)| {
            let plays = count - snap.get(&id).copied().unwrap_or(0);
            (plays > 0).then_some(TrackDelta { title, plays })
        })
        .collect();

    let total_completions = meta_i64(&tx, "completions")?;
    let new_completions = (total_completions - meta_i64(&tx, "completions_snapshot")?).max(0);
    let data = ReportData {
        period_start,
        period_end: now,
        changes,
        new_completions,
        total_plays,
        total_completions,
    };

    for text in render(&data) {
        enqueue(&tx, &text, now)?;
    }
    snapshot(&tx)?;
    meta_set(&tx, "last_report_at", &now.to_string())?;
    tx.commit()?;
    Ok(data)
}

fn snapshot(tx: &Transaction<'_>) -> Result<(), DbError> {
    tx.execute("DELETE FROM report_snapshot", [])?;
    tx.execute(
        "INSERT INTO report_snapshot(track_id, count) SELECT track_id, count FROM plays",
        [],
    )?;
    let completions = meta_i64(tx, "completions")?;
    meta_set(tx, "completions_snapshot", &completions.to_string())?;
    Ok(())
}

fn enqueue(conn: &Connection, text: &str, now: i64) -> Result<(), DbError> {
    conn.execute(
        "INSERT INTO outbox(text, created_at) VALUES(?1, ?2)",
        params![text, now],
    )?;
    Ok(())
}

pub fn enqueue_messages(conn: &mut Connection, texts: &[String], now: i64) -> Result<(), DbError> {
    let tx = conn.transaction()?;
    for t in texts {
        enqueue(&tx, t, now)?;
    }
    tx.commit()?;
    Ok(())
}

pub fn outbox_next(conn: &Connection) -> Result<Option<OutboxItem>, DbError> {
    Ok(conn
        .query_row(
            "SELECT id, text, attempts FROM outbox ORDER BY id LIMIT 1",
            [],
            |r| {
                Ok(OutboxItem {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    attempts: r.get(2)?,
                })
            },
        )
        .optional()?)
}

pub fn outbox_done(conn: &Connection, id: i64) -> Result<(), DbError> {
    conn.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
    Ok(())
}

pub fn outbox_failed(conn: &Connection, id: i64) -> Result<(), DbError> {
    conn.execute(
        "UPDATE outbox SET attempts = attempts + 1 WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

pub fn backup_to(conn: &Connection, path: &Path) -> Result<(), DbError> {
    conn.execute("VACUUM INTO ?1", [path.to_string_lossy()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Track;

    fn manifest(ids: &[&str]) -> Manifest {
        Manifest::new(
            ids.iter()
                .map(|id| Track {
                    id: (*id).into(),
                    composer: "C".into(),
                    work: format!("W{id}"),
                    part: None,
                    section: None,
                    duration: 10.0,
                    gain: 0.0,
                })
                .collect(),
        )
    }

    fn play(id: &str, track: &str) -> Event {
        Event {
            id: id.into(),
            kind: EventKind::Play {
                track: track.into(),
            },
        }
    }

    fn with_conn<R>(f: impl FnOnce(&mut Connection) -> R) -> R {
        let db = Db::open_in_memory().expect("in-memory db");
        let mut conn = db.conn.lock().expect("unpoisoned");
        f(&mut conn)
    }

    #[test]
    fn events_are_counted_once() {
        with_conn(|c| {
            apply_set(c, &manifest(&["a", "b"]), 0).expect("apply");
            let batch = [
                play("e1", "a"),
                play("e2", "a"),
                Event {
                    id: "e3".into(),
                    kind: EventKind::Complete,
                },
            ];
            assert_eq!(record_events(c, &batch, 1).expect("record"), 3);
            assert_eq!(record_events(c, &batch, 2).expect("record"), 0);
            let count: i64 = c
                .query_row("SELECT count FROM plays WHERE track_id='a'", [], |r| {
                    r.get(0)
                })
                .expect("row");
            assert_eq!(count, 2);
            assert_eq!(meta_i64(c, "completions").expect("meta"), 1);
        });
    }

    #[test]
    fn report_reflects_only_new_activity() {
        with_conn(|c| {
            apply_set(c, &manifest(&["a", "b"]), 0).expect("apply");
            init_report_clock(c, 0).expect("init");
            record_events(c, &[play("e1", "a"), play("e2", "a"), play("e3", "b")], 1)
                .expect("record");
            let r = close_report_period(c, 100, |_| vec!["r1".into()]).expect("report");
            assert_eq!(r.period_start, 0);
            assert_eq!(r.changes.len(), 2);
            assert_eq!(r.changes[0].plays, 2);
            assert_eq!(r.total_plays, 3);

            record_events(c, &[play("e4", "b")], 101).expect("record");
            let r = close_report_period(c, 200, |_| vec!["r2".into()]).expect("report");
            assert_eq!(r.period_start, 100);
            assert_eq!(
                r.changes,
                vec![TrackDelta {
                    title: "C - Wb".into(),
                    plays: 1
                }]
            );
            assert_eq!(r.new_completions, 0);

            let r = close_report_period(c, 300, |_| Vec::new()).expect("report");
            assert!(r.changes.is_empty());
            let first = outbox_next(c).expect("outbox").expect("item");
            assert_eq!(first.text, "r1");
        });
    }

    #[test]
    fn removed_tracks_are_archived_and_still_reported() {
        with_conn(|c| {
            apply_set(c, &manifest(&["a", "b"]), 0).expect("apply");
            init_report_clock(c, 0).expect("init");
            record_events(c, &[play("e1", "a"), play("e2", "b")], 1).expect("record");
            apply_set(c, &manifest(&["b", "c"]), 5).expect("apply");
            let archived: i64 = c
                .query_row(
                    "SELECT count FROM archived_plays WHERE track_id='a'",
                    [],
                    |r| r.get(0),
                )
                .expect("row");
            assert_eq!(archived, 1);
            record_events(c, &[play("e3", "a")], 6).expect("record");
            let r = close_report_period(c, 10, |_| Vec::new()).expect("report");
            assert_eq!(r.total_plays, 1);
            assert_eq!(r.changes.len(), 2);
        });
    }

    #[test]
    fn outbox_is_fifo() {
        with_conn(|c| {
            enqueue_messages(c, &["one".into(), "two".into()], 0).expect("enqueue");
            let first = outbox_next(c).expect("next").expect("item");
            outbox_failed(c, first.id).expect("fail");
            let again = outbox_next(c).expect("next").expect("item");
            assert_eq!((again.text.as_str(), again.attempts), ("one", 1));
            outbox_done(c, again.id).expect("done");
            assert_eq!(outbox_next(c).expect("next").expect("item").text, "two");
        });
    }
}
