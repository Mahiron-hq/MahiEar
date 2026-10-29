use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrackName {
    pub number: u32,
    pub composer: String,
    pub work: String,
    pub part: Option<String>,
    pub section: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("не MP3-файл")]
    NotMp3,
    #[error("нет порядкового номера в начале")]
    MissingNumber,
    #[error("нужно от 2 до 4 частей через « - », найдено {0}")]
    LevelCount(usize),
    #[error("пустая часть названия")]
    EmptyLevel,
}

impl TrackName {
    pub fn parse(file_name: &str) -> Result<Self, NameError> {
        let name: String = file_name.nfc().collect();
        let stem = strip_suffix_ignore_case(&name, ".mp3").ok_or(NameError::NotMp3)?;

        let digits_end = stem
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(stem.len());
        let number = stem[..digits_end]
            .parse::<u32>()
            .map_err(|_| NameError::MissingNumber)?;
        let rest = stem[digits_end..]
            .strip_prefix('.')
            .ok_or(NameError::MissingNumber)?;
        if !rest.starts_with(char::is_whitespace) {
            return Err(NameError::MissingNumber);
        }

        let levels: Vec<String> = rest
            .split(" - ")
            .map(|s| collapse_spaces(s.trim()))
            .collect();
        if !(2..=4).contains(&levels.len()) {
            return Err(NameError::LevelCount(levels.len()));
        }
        if levels.iter().any(String::is_empty) {
            return Err(NameError::EmptyLevel);
        }
        let mut it = levels.into_iter();
        let (Some(composer), Some(work)) = (it.next(), it.next()) else {
            return Err(NameError::LevelCount(0));
        };
        Ok(Self {
            number,
            composer,
            work,
            part: it.next(),
            section: it.next(),
        })
    }

    pub fn display(&self) -> String {
        [
            Some(&self.composer),
            Some(&self.work),
            self.part.as_ref(),
            self.section.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" - ")
    }
}

fn strip_suffix_ignore_case<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let cut = s.len().checked_sub(suffix.len())?;
    (s.is_char_boundary(cut) && s[cut..].eq_ignore_ascii_case(suffix)).then(|| &s[..cut])
}

fn collapse_spaces(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    pub integrated_lufs: Option<f64>,
    pub true_peak_dbtp: Option<f64>,
}

const TRUE_PEAK_CEILING: f64 = -1.0;
const LOUDEST_TARGET: f64 = -16.0;
const QUIETEST_TARGET: f64 = -23.0;

pub fn normalization_gains(items: &[Loudness]) -> Vec<f64> {
    let reachable = items
        .iter()
        .filter_map(|l| Some(l.integrated_lufs? + headroom(l)))
        .fold(f64::INFINITY, f64::min);
    let target = if reachable.is_finite() {
        reachable.clamp(QUIETEST_TARGET, LOUDEST_TARGET)
    } else {
        LOUDEST_TARGET
    };
    items
        .iter()
        .map(|l| match l.integrated_lufs {
            Some(i) => round2((target - i).min(headroom(l))),
            None => 0.0,
        })
        .collect()
}

fn headroom(l: &Loudness) -> f64 {
    l.true_peak_dbtp.map_or(0.0, |tp| TRUE_PEAK_CEILING - tp)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Track {
    pub id: String,
    pub composer: String,
    pub work: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub part: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub section: Option<String>,
    pub duration: f64,
    pub gain: f64,
}

impl Track {
    pub fn title(&self) -> String {
        [
            Some(&self.composer),
            Some(&self.work),
            self.part.as_ref(),
            self.section.as_ref(),
        ]
        .into_iter()
        .flatten()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(" - ")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    pub composer: String,
    pub work: String,
    pub tracks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub version: String,
    pub tracks: Vec<Track>,
    pub blocks: Vec<Block>,
}

impl Manifest {
    pub fn new(tracks: Vec<Track>) -> Self {
        let mut blocks: Vec<Block> = Vec::new();
        for t in &tracks {
            match blocks
                .iter_mut()
                .find(|b| b.composer == t.composer && b.work == t.work)
            {
                Some(b) => b.tracks.push(t.id.clone()),
                None => blocks.push(Block {
                    composer: t.composer.clone(),
                    work: t.work.clone(),
                    tracks: vec![t.id.clone()],
                }),
            }
        }
        let mut hasher = Sha256::new();
        hasher.update(serde_json::to_vec(&tracks).unwrap_or_default());
        let version = hex::encode(&hasher.finalize()[..8]);
        Self {
            version,
            tracks,
            blocks,
        }
    }

    pub fn empty() -> Self {
        Self {
            version: "empty".to_owned(),
            tracks: Vec::new(),
            blocks: Vec::new(),
        }
    }

    pub fn contains(&self, id: &str) -> bool {
        self.tracks.iter().any(|t| t.id == id)
    }
}

pub fn is_audio_id(id: &str) -> bool {
    id.len() == 24 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_level_counts() {
        let t = TrackName::parse("13. Шуберт - Гретхен за прялкой (Gretchen am Spinnrade).mp3")
            .expect("valid");
        assert_eq!(t.number, 13);
        assert_eq!(t.composer, "Шуберт");
        assert_eq!(t.work, "Гретхен за прялкой (Gretchen am Spinnrade)");
        assert_eq!(t.part, None);

        let t =
            TrackName::parse("38. Шуберт - Музыкальный момент фа минор, op. 94 №3 - Начало.mp3")
                .expect("valid");
        assert_eq!(t.work, "Музыкальный момент фа минор, op. 94 №3");
        assert_eq!(t.part.as_deref(), Some("Начало"));

        let t = TrackName::parse(
            "06. Вебер - Вольный стрелок - №3 Сцена и ария Макса - 1-й раздел, Es-dur (Durch die Wälder, durch die Auen).MP3",
        )
        .expect("valid");
        assert_eq!(t.part.as_deref(), Some("№3 Сцена и ария Макса"));
        assert_eq!(
            t.section.as_deref(),
            Some("1-й раздел, Es-dur (Durch die Wälder, durch die Auen)")
        );
    }

    #[test]
    fn normalizes_decomposed_unicode() {
        let t = TrackName::parse("1. Weber - Wa\u{0308}lder.mp3").expect("valid");
        assert_eq!(t.work, "W\u{00e4}lder");
    }

    #[test]
    fn rejects_bad_names() {
        assert_eq!(
            TrackName::parse("Шуберт - Липа.mp3"),
            Err(NameError::MissingNumber)
        );
        assert_eq!(
            TrackName::parse("01 Шуберт - Липа.mp3"),
            Err(NameError::MissingNumber)
        );
        assert_eq!(
            TrackName::parse("01. Шуберт.mp3"),
            Err(NameError::LevelCount(1))
        );
        assert_eq!(
            TrackName::parse("01. A - B - C - D - E.mp3"),
            Err(NameError::LevelCount(5))
        );
        assert_eq!(
            TrackName::parse("01. A -  - C.mp3"),
            Err(NameError::EmptyLevel)
        );
        assert_eq!(TrackName::parse("01. A - B.wav"), Err(NameError::NotMp3));
    }

    #[test]
    fn display_round_trips_levels() {
        let src = "Вебер - Вольный стрелок - Увертюра - Тема леса";
        let t = TrackName::parse(&format!("01. {src}.mp3")).expect("valid");
        assert_eq!(t.display(), src);
    }

    #[test]
    fn gains_share_a_target_and_respect_peaks() {
        let items = [
            Loudness {
                integrated_lufs: Some(-14.0),
                true_peak_dbtp: Some(-0.5),
            },
            Loudness {
                integrated_lufs: Some(-24.0),
                true_peak_dbtp: Some(-10.0),
            },
            Loudness {
                integrated_lufs: Some(-20.0),
                true_peak_dbtp: Some(-2.0),
            },
        ];
        let gains = normalization_gains(&items);
        assert_eq!(gains, vec![-5.0, 5.0, 1.0]);
        for (l, g) in items.iter().zip(&gains) {
            assert!(l.true_peak_dbtp.expect("set") + g <= TRUE_PEAK_CEILING + 1e-9);
        }
    }

    #[test]
    fn gains_cap_when_target_is_clamped() {
        let items = [
            Loudness {
                integrated_lufs: Some(-30.0),
                true_peak_dbtp: Some(-1.5),
            },
            Loudness {
                integrated_lufs: Some(-20.0),
                true_peak_dbtp: Some(-8.0),
            },
            Loudness {
                integrated_lufs: None,
                true_peak_dbtp: None,
            },
        ];
        assert_eq!(normalization_gains(&items), vec![0.5, -3.0, 0.0]);
    }

    #[test]
    fn manifest_groups_blocks_in_order() {
        let track = |id: &str, work: &str| Track {
            id: id.into(),
            composer: "C".into(),
            work: work.into(),
            part: None,
            section: None,
            duration: 1.0,
            gain: 0.0,
        };
        let m = Manifest::new(vec![track("a", "X"), track("b", "X"), track("c", "Y")]);
        assert_eq!(m.blocks.len(), 2);
        assert_eq!(m.blocks[0].tracks, vec!["a", "b"]);
        assert_eq!(m.version.len(), 16);
    }

    #[test]
    fn audio_id_shape() {
        assert!(is_audio_id("0123456789abcdef01234567"));
        assert!(!is_audio_id("../../etc/passwd"));
        assert!(!is_audio_id("0123456789ABCDEF01234567"));
    }
}
