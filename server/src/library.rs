use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use arc_swap::ArcSwap;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::catalog::{Loudness, Manifest, Track, TrackName, normalization_gains};
use crate::db::{self, CachedAnalysis, Db, DbError};
use crate::media::{MediaError, Tools};
use crate::notify::Notifier;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Entry {
    size: u64,
    modified: Option<SystemTime>,
}

type Snapshot = BTreeMap<String, Entry>;

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("manifest encoding: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileProblem {
    pub file: String,
    pub reason: String,
}

pub struct Library {
    pub tools: Tools,
    pub source_dir: PathBuf,
    pub data_dir: PathBuf,
    pub db: Arc<Db>,
    pub current: Arc<ArcSwap<Manifest>>,
    pub notifier: Notifier,
}

impl Library {
    pub fn audio_dir(&self) -> PathBuf {
        self.data_dir.join("audio")
    }

    fn manifest_path(&self) -> PathBuf {
        self.data_dir.join("manifest.json")
    }

    fn previous_path(&self) -> PathBuf {
        self.data_dir.join("manifest.previous.json")
    }

    pub fn load_published(&self) -> Option<Manifest> {
        let bytes = std::fs::read(self.manifest_path()).ok()?;
        match serde_json::from_slice(&bytes) {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!(error = %e, "stored manifest unreadable, rebuilding");
                None
            }
        }
    }

    pub async fn run(self: Arc<Self>, interval: Duration, cancel: CancellationToken) {
        let mut published: Option<Snapshot> = None;
        let mut pending: Option<Snapshot> = None;
        if self.current.load().tracks.is_empty() {
            match scan(&self.source_dir) {
                Ok(snap) => match self.publish(&snap).await {
                    Ok(()) => published = Some(snap),
                    Err(e) => tracing::error!(error = %e, "initial processing failed"),
                },
                Err(e) => {
                    tracing::error!(error = %e, dir = %self.source_dir.display(), "cannot read library")
                }
            }
        }
        loop {
            match scan(&self.source_dir) {
                Ok(snap) if published.as_ref() == Some(&snap) => pending = None,
                // let half-copied uploads finish first
                Ok(snap) if pending.as_ref() == Some(&snap) => {
                    match self.publish(&snap).await {
                        Ok(()) => published = Some(snap),
                        Err(e) => tracing::error!(error = %e, "publishing failed, will retry"),
                    }
                    pending = None;
                }
                Ok(snap) => pending = Some(snap),
                Err(e) => {
                    tracing::error!(error = %e, dir = %self.source_dir.display(), "cannot read library")
                }
            }
            tokio::select! {
                () = cancel.cancelled() => return,
                () = tokio::time::sleep(interval) => {}
            }
        }
    }

    pub async fn publish_now(self: &Arc<Self>) -> Result<(), LibraryError> {
        let snap = scan(&self.source_dir)?;
        self.publish(&snap).await
    }

    async fn publish(self: &Arc<Self>, snap: &Snapshot) -> Result<(), LibraryError> {
        tokio::fs::create_dir_all(self.audio_dir()).await?;
        let mut problems = Vec::new();
        let mut items: Vec<(TrackName, CachedAnalysis)> = Vec::new();

        let mut jobs = tokio::task::JoinSet::new();
        let permits = Arc::new(tokio::sync::Semaphore::new(workers()));
        for file in snap.keys() {
            let name = match TrackName::parse(file) {
                Ok(n) => n,
                Err(e) => {
                    problems.push(FileProblem {
                        file: file.clone(),
                        reason: format!("неправильное название: {e}"),
                    });
                    continue;
                }
            };
            let this = Arc::clone(self);
            let permits = Arc::clone(&permits);
            let file = file.clone();
            jobs.spawn(async move {
                let _permit = permits.acquire_owned().await;
                let res = this.prepare(&this.source_dir.join(&file)).await;
                (file, name, res)
            });
        }
        while let Some(joined) = jobs.join_next().await {
            let (file, name, res) =
                joined.map_err(|e| LibraryError::Io(std::io::Error::other(e)))?;
            match res {
                Ok(a) => items.push((name, a)),
                Err(PrepareError::Media(e)) => problems.push(FileProblem {
                    file,
                    reason: e.to_string(),
                }),
                Err(PrepareError::Other(e)) => return Err(e),
            }
        }
        problems.sort_by(|a, b| a.file.cmp(&b.file));

        items.sort_by(|(a, _), (b, _)| {
            a.number
                .cmp(&b.number)
                .then_with(|| a.display().cmp(&b.display()))
        });
        let mut seen = HashSet::new();
        items.retain(|(name, a)| {
            let fresh = seen.insert(a.audio_id.clone());
            if !fresh {
                problems.push(FileProblem {
                    file: name.display(),
                    reason: "дубликат: такой же звук уже есть в наборе".to_owned(),
                });
            }
            fresh
        });

        let loudness: Vec<Loudness> = items.iter().map(|(_, a)| a.loudness).collect();
        let gains = normalization_gains(&loudness);
        let tracks: Vec<Track> = items
            .into_iter()
            .zip(gains)
            .map(|((n, a), gain)| Track {
                id: a.audio_id,
                composer: n.composer,
                work: n.work,
                part: n.part,
                section: n.section,
                duration: (a.duration * 1000.0).round() / 1000.0,
                gain,
            })
            .collect();

        self.report_problems(&problems).await;

        if tracks.is_empty() {
            tracing::warn!("no valid excerpts found, keeping the previous set");
            return Ok(());
        }
        let manifest = Manifest::new(tracks);
        if manifest.version == self.current.load().version {
            return Ok(());
        }

        let old = self.current.load_full();
        let json = serde_json::to_vec(&manifest)?;
        if old.version != "empty" {
            write_atomic(&self.previous_path(), &serde_json::to_vec(&*old)?)?;
        }
        write_atomic(&self.manifest_path(), &json)?;
        let now = unix_now();
        let for_db = manifest.clone();
        self.db
            .call(move |c| db::apply_set(c, &for_db, now))
            .await?;
        tracing::info!(version = %manifest.version, tracks = manifest.tracks.len(), "published set");
        let keep: HashSet<String> = manifest
            .tracks
            .iter()
            .chain(old.tracks.iter())
            .map(|t| t.id.clone())
            .collect();
        self.current.store(Arc::new(manifest));
        if let Err(e) = collect_garbage(&self.audio_dir(), &keep) {
            tracing::warn!(error = %e, "audio cleanup failed");
        }
        Ok(())
    }

    async fn prepare(&self, path: &Path) -> Result<CachedAnalysis, PrepareError> {
        let bytes = tokio::fs::read(path)
            .await
            .map_err(|e| PrepareError::Other(e.into()))?;
        let source_hash = hex::encode(Sha256::digest(&bytes));
        let hash = source_hash.clone();
        let cached = self
            .db
            .call(move |c| db::analysis_get(c, &hash))
            .await
            .map_err(|e| PrepareError::Other(e.into()))?;
        if let Some(a) = cached
            && self
                .audio_dir()
                .join(format!("{}.mp3", a.audio_id))
                .is_file()
        {
            return Ok(a);
        }

        let tmp = self
            .audio_dir()
            .join(format!(".{}.tmp.mp3", &source_hash[..16]));
        let result = self.strip_and_analyze(path, &tmp).await;
        let analysis = match result {
            Ok(a) => a,
            Err(e) => {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(e);
            }
        };
        let hash = source_hash;
        let stored = analysis.clone();
        let now = unix_now();
        self.db
            .call(move |c| db::analysis_put(c, &hash, &stored, now))
            .await
            .map_err(|e| PrepareError::Other(e.into()))?;
        Ok(analysis)
    }

    async fn strip_and_analyze(
        &self,
        src: &Path,
        tmp: &Path,
    ) -> Result<CachedAnalysis, PrepareError> {
        self.tools.strip_tags(src, tmp).await?;
        let analysis = self.tools.analyze(tmp).await?;
        let stripped = tokio::fs::read(tmp)
            .await
            .map_err(|e| PrepareError::Other(e.into()))?;
        let audio_id = hex::encode(&Sha256::digest(&stripped)[..12]);
        let dst = self.audio_dir().join(format!("{audio_id}.mp3"));
        if dst.is_file() {
            tokio::fs::remove_file(tmp)
                .await
                .map_err(|e| PrepareError::Other(e.into()))?;
        } else {
            sync_file(tmp).map_err(|e| PrepareError::Other(e.into()))?;
            tokio::fs::rename(tmp, &dst)
                .await
                .map_err(|e| PrepareError::Other(e.into()))?;
        }
        Ok(CachedAnalysis {
            audio_id,
            duration: analysis.duration,
            loudness: analysis.loudness,
        })
    }

    async fn report_problems(&self, problems: &[FileProblem]) {
        for p in problems {
            tracing::warn!(file = %p.file, reason = %p.reason, "excerpt not published");
        }
        let fingerprint = hex::encode(Sha256::digest(
            problems
                .iter()
                .map(|p| format!("{}\n{}\n", p.file, p.reason))
                .collect::<String>(),
        ));
        let known = self
            .db
            .call(|c| db::meta_get(c, "problems_fingerprint"))
            .await
            .ok()
            .flatten();
        if known.as_deref() == Some(fingerprint.as_str()) {
            return;
        }
        if !problems.is_empty() {
            self.notifier
                .send(crate::report::render_problems(problems))
                .await;
        }
        let fp = fingerprint;
        if let Err(e) = self
            .db
            .call(move |c| db::meta_set(c, "problems_fingerprint", &fp))
            .await
        {
            tracing::warn!(error = %e, "cannot store problem fingerprint");
        }
    }
}

enum PrepareError {
    Media(MediaError),
    Other(LibraryError),
}

impl From<MediaError> for PrepareError {
    fn from(e: MediaError) -> Self {
        match e {
            MediaError::Spawn { .. } | MediaError::Timeout { .. } => {
                Self::Other(LibraryError::Io(std::io::Error::other(e.to_string())))
            }
            other => Self::Media(other),
        }
    }
}

fn workers() -> usize {
    std::thread::available_parallelism().map_or(2, |n| (n.get() / 2).clamp(1, 4))
}

fn scan(dir: &Path) -> Result<Snapshot, std::io::Error> {
    let mut snap = Snapshot::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if name.starts_with('.') || !name.to_ascii_lowercase().ends_with(".mp3") {
            continue;
        }
        snap.insert(
            name,
            Entry {
                size: meta.len(),
                modified: meta.modified().ok(),
            },
        );
    }
    Ok(snap)
}

fn collect_garbage(audio_dir: &Path, keep: &HashSet<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(audio_dir)? {
        let path = entry?.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !stem.starts_with('.') && !keep.contains(stem) {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    sync_file(&tmp)?;
    std::fs::rename(&tmp, path)
}

fn sync_file(path: &Path) -> std::io::Result<()> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

pub fn unix_now() -> i64 {
    jiff::Timestamp::now().as_second()
}
