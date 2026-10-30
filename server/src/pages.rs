use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use sha2::{Digest, Sha256};

use crate::catalog::is_audio_id;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageMeta {
    pub title: &'static str,
    pub description: &'static str,
    pub canonical: Option<&'static str>,
    pub indexable: bool,
    pub found: bool,
}

const SITE_DESCRIPTION: &str = "Узнавайте музыкальные отрывки на слух: полный прогон в случайном порядке, самопроверка, плейлист и работа без интернета.";
const PREP_DESCRIPTION: &str =
    "Тренировка узнавания музыкальных отрывков на слух. Название каждого отрывка скрыто до ответа.";

fn page(
    title: &'static str,
    description: &'static str,
    canonical: &'static str,
    indexable: bool,
) -> PageMeta {
    PageMeta {
        title,
        description,
        canonical: Some(canonical),
        indexable,
        found: true,
    }
}

pub fn meta_for(path: &str) -> PageMeta {
    let p = if path.len() > 1 {
        path.strip_suffix('/').unwrap_or(path)
    } else {
        path
    };
    match p {
        "/" | "/index.html" => page(
            "MahiEar · Подготовка к музыкальной викторине",
            SITE_DESCRIPTION,
            "/",
            true,
        ),
        "/prep" | "/prep/selective" => {
            page("Подготовка · MahiEar", PREP_DESCRIPTION, "/prep", false)
        }
        "/prep/result" | "/prep/selective/result" => {
            page("Итоги · MahiEar", PREP_DESCRIPTION, "/prep", false)
        }
        "/select" => page(
            "Выборочная подготовка · MahiEar",
            "Подготовка только по выбранным композиторам и произведениям: тот же случайный порядок и самопроверка.",
            "/select",
            true,
        ),
        "/playlist" => page(
            "Плейлист · MahiEar",
            "Все отрывки викторины с открытыми названиями: поиск, повтор, перемешивание и работа без интернета.",
            "/playlist",
            true,
        ),
        "/settings" => page(
            "Настройки · MahiEar",
            "Задержка показа названия, автопереход, выравнивание громкости, работа в фоне и без интернета.",
            "/settings",
            false,
        ),
        "/stats" => page(
            "Статистика · MahiEar",
            "Личная статистика подготовки: пройденные прогоны и отрывки, которые чаще всего не удаётся узнать.",
            "/stats",
            false,
        ),
        "/data" => page(
            "О данных · MahiEar",
            "Что MahiEar хранит на устройстве и на сервере и как удалить эти данные.",
            "/data",
            true,
        ),
        _ if p.strip_prefix("/playlist/").is_some_and(is_audio_id) => page(
            "Плейлист · MahiEar",
            "Все отрывки викторины с открытыми названиями: поиск, повтор, перемешивание и работа без интернета.",
            "/playlist",
            false,
        ),
        _ => PageMeta {
            title: "Страница не найдена · MahiEar",
            description: "Такой страницы на сайте MahiEar нет.",
            canonical: None,
            indexable: false,
            found: false,
        },
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
pub fn head_tags(meta: &PageMeta, base: &str) -> String {
    let title = escape(meta.title);
    let desc = escape(meta.description);
    let image = format!("{base}/og-image.png");
    let alt = "Надпись MahiEar и подпись «Подготовка к музыкальной викторине» на тёмном фоне";
    let mut t = vec![
        format!("<title>{title}</title>"),
        format!(r#"<meta name="description" content="{desc}" />"#),
        format!(
            r#"<meta name="robots" content="{}" />"#,
            if meta.indexable {
                "index, follow"
            } else {
                "noindex, follow"
            }
        ),
        r#"<meta property="og:site_name" content="MahiEar" />"#.to_owned(),
        r#"<meta property="og:type" content="website" />"#.to_owned(),
        r#"<meta property="og:locale" content="ru_RU" />"#.to_owned(),
        format!(r#"<meta property="og:title" content="{title}" />"#),
        format!(r#"<meta property="og:description" content="{desc}" />"#),
        format!(r#"<meta property="og:image" content="{image}" />"#),
        r#"<meta property="og:image:type" content="image/png" />"#.to_owned(),
        r#"<meta property="og:image:width" content="1200" />"#.to_owned(),
        r#"<meta property="og:image:height" content="630" />"#.to_owned(),
        format!(r#"<meta property="og:image:alt" content="{alt}" />"#),
        r#"<meta name="twitter:card" content="summary_large_image" />"#.to_owned(),
        format!(r#"<meta name="twitter:title" content="{title}" />"#),
        format!(r#"<meta name="twitter:description" content="{desc}" />"#),
        format!(r#"<meta name="twitter:image" content="{image}" />"#),
        format!(r#"<meta name="twitter:image:alt" content="{alt}" />"#),
    ];
    if let Some(c) = meta.canonical {
        let url = format!("{base}{c}");
        t.push(format!(r#"<meta property="og:url" content="{url}" />"#));
        t.push(format!(r#"<link rel="canonical" href="{url}" />"#));
    }
    t.join("\n    ")
}
pub fn render(shell: &str, meta: &PageMeta, base: &str) -> String {
    let tags = head_tags(meta, base);
    if let (Some(start), Some(end)) = (shell.find("<title>"), shell.find("</title>"))
        && start < end
    {
        let end = end + "</title>".len();
        return format!("{}{}{}", &shell[..start], tags, &shell[end..]);
    }
    match shell.find("</head>") {
        Some(i) => format!("{}{}\n  {}", &shell[..i], tags, &shell[i..]),
        None => shell.to_owned(),
    }
}
pub fn inline_style_hashes(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(open) = rest.find("<style>") {
        let body = &rest[open + "<style>".len()..];
        let Some(close) = body.find("</style>") else {
            break;
        };
        let digest = Sha256::digest(&body.as_bytes()[..close]);
        out.push(format!("'sha256-{}'", STANDARD.encode(digest)));
        rest = &body[close..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: &str =
        "<html><head>\n<title>MahiEar</title>\n<style>a{}</style></head><body></body></html>";

    #[test]
    fn every_page_gets_full_preview_tags() {
        let html = render(SHELL, &meta_for("/playlist"), "https://ear.example");
        for needle in [
            "<title>Плейлист · MahiEar</title>",
            r#"property="og:title" content="Плейлист · MahiEar""#,
            r#"property="og:url" content="https://ear.example/playlist""#,
            r#"rel="canonical" href="https://ear.example/playlist""#,
            r#"property="og:image" content="https://ear.example/og-image.png""#,
            r#"name="twitter:card" content="summary_large_image""#,
            r#"property="og:locale" content="ru_RU""#,
            r#"content="index, follow""#,
        ] {
            assert!(html.contains(needle), "{needle}");
        }
        assert_eq!(html.matches("<title>").count(), 1);
    }

    #[test]
    fn prep_pages_stay_neutral_and_unindexed() {
        for p in ["/prep", "/prep/selective", "/prep/result"] {
            let m = meta_for(p);
            assert!(!m.indexable);
            assert_eq!(m.description, PREP_DESCRIPTION);
            assert_eq!(m.canonical, Some("/prep"));
        }
        let m = meta_for("/playlist/0123456789abcdef01234567");
        assert_eq!(m.canonical, Some("/playlist"));
    }

    #[test]
    fn unknown_pages_are_not_found_and_noindex() {
        let m = meta_for("/wdsf");
        assert!(!m.found && !m.indexable && m.canonical.is_none());
        let html = render(SHELL, &m, "https://ear.example");
        assert!(html.contains(r#"content="noindex, follow""#));
        assert!(!html.contains("og:url"));
    }

    #[test]
    fn hashes_inline_styles() {
        let h = inline_style_hashes(SHELL);
        assert_eq!(h.len(), 1);
        assert!(h[0].starts_with("'sha256-") && h[0].ends_with('\''));
    }

    #[test]
    fn escapes_attribute_values() {
        assert_eq!(escape(r#"a"<b>&"#), "a&quot;&lt;b&gt;&amp;");
    }
}
