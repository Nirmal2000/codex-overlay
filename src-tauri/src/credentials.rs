use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub fn load_secret(app: Option<&AppHandle>, name: &str) -> Result<String, String> {
    if let Ok(value) = std::env::var(name) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return Ok(value);
        }
    }

    let mut candidates = Vec::new();
    if let Some(app) = app {
        if let Ok(path) = app.path().app_config_dir() {
            candidates.push(path.join(".env"));
        }
        if let Ok(path) = app.path().app_data_dir() {
            candidates.push(path.join(".env"));
        }
    }
    candidates.extend(repository_env_files());

    for path in &candidates {
        if let Some(value) = read_env_file_key(path, name) {
            return Ok(value);
        }
    }

    let searched = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "{name} is not configured. Set it in the environment or in one of: {searched}"
    ))
}

pub fn repository_env_files() -> [PathBuf; 2] {
    [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".env"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.env"),
    ]
}

pub fn read_env_file_key(path: &Path, name: &str) -> Option<String> {
    let contents = std::fs::read_to_string(path).ok()?;
    let prefix = format!("{name}=");
    contents.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        line.strip_prefix(&prefix)
            .map(|value| value.trim().trim_matches(['\'', '"']).to_string())
            .filter(|value| !value.is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::read_env_file_key;

    #[test]
    fn reads_named_secret_without_matching_comments_or_other_keys() {
        let path = std::env::temp_dir().join("codex-overlay-credentials-test.env");
        std::fs::write(
            &path,
            "# OPENROUTER_API_KEY=ignored\nOTHER=value\nOPENROUTER_API_KEY='secret-value'\n",
        )
        .unwrap();
        assert_eq!(
            read_env_file_key(&path, "OPENROUTER_API_KEY").as_deref(),
            Some("secret-value")
        );
        std::fs::remove_file(path).unwrap();
    }
}
