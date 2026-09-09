use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::prompts::{PI_PROMPT_VERSION, REALTIME_PROMPT_VERSION};

const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "json", "yaml", "yml", "toml", "rst", "csv",
];
const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
];

#[derive(Clone, Copy)]
pub enum ContextKind {
    Realtime,
    Pi,
}

#[derive(Clone)]
pub struct ContextPack {
    pub info: ContextInfo,
    pub text: String,
}

#[derive(Clone, Serialize)]
pub struct ContextInfo {
    pub version: String,
    pub hash: String,
    pub file_count: usize,
    pub byte_count: usize,
}

/// Load every supported UTF-8 document below the exact directory selected by
/// the user. Filenames and directory layout are deliberately not prescribed.
/// Both answer lanes receive the packed text up front; Pi may still inspect an
/// external repository later when the user's context points it there.
pub fn load_context(context_root: &Path, kind: ContextKind) -> Result<ContextPack, String> {
    if !context_root.is_dir() {
        return Err(format!(
            "Context folder does not exist or is not a directory: {}",
            context_root.display()
        ));
    }

    let files = discover_context_files(context_root)?;
    if files.is_empty() {
        return Err(format!(
            "No supported context documents were found in {}. Add UTF-8 Markdown, text, JSON, YAML, TOML, RST, or CSV files anywhere inside this folder.",
            context_root.display()
        ));
    }

    let version = match kind {
        ContextKind::Realtime => format!("context-realtime-v1+{REALTIME_PROMPT_VERSION}"),
        ContextKind::Pi => format!("context-pi-v1+{PI_PROMPT_VERSION}"),
    };
    build_pack(context_root, &version, files)
}

fn discover_context_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_context_files(root, &mut files)?;
    files.sort_by(|left, right| {
        left.strip_prefix(root)
            .unwrap_or(left)
            .cmp(right.strip_prefix(root).unwrap_or(right))
    });
    Ok(files)
}

fn collect_context_files(directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| {
            format!(
                "Failed to read context folder {}: {error}",
                directory.display()
            )
        })?
        .map(|entry| entry.map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();

        // Do not follow symlinks out of the folder or ingest hidden/build data.
        if file_type.is_symlink() || name.starts_with('.') {
            continue;
        }
        if file_type.is_dir() {
            if !IGNORED_DIRECTORIES.contains(&name.as_ref()) {
                collect_context_files(&path, files)?;
            }
            continue;
        }
        if file_type.is_file() && is_supported_text_file(&path) {
            files.push(path);
        }
    }
    Ok(())
}

fn is_supported_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            TEXT_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

fn build_pack(root: &Path, version: &str, files: Vec<PathBuf>) -> Result<ContextPack, String> {
    let mut text = String::new();
    let mut hasher = Sha256::new();
    hasher.update(version.as_bytes());
    for path in &files {
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let contents = fs::read_to_string(path).map_err(|error| {
            format!(
                "Failed to read {} as UTF-8 context: {error}",
                path.display()
            )
        })?;
        let relative = relative.to_string_lossy();
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(contents.as_bytes());
        hasher.update([0]);
        text.push_str("\n\n===== FILE: ");
        text.push_str(&relative);
        text.push_str(" =====\n");
        text.push_str(&contents);
    }
    let hash = format!("{:x}", hasher.finalize());
    Ok(ContextPack {
        info: ContextInfo {
            version: version.to_string(),
            hash,
            file_count: files.len(),
            byte_count: text.len(),
        },
        text,
    })
}
