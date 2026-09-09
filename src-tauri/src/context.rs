use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use crate::prompts::{PI_PROMPT_VERSION, REALTIME_PROMPT_VERSION};

const MERCOR_DIRECTORY: &str = "mercor-interview-prep-2026-08-11";

const REALTIME_FILES: &[&str] = &[
    "Experience/quick-context.md",
    "Experience/resolved-facts.md",
    "Experience/career-timeline.md",
    "Experience/expertise-map.md",
    "13-spoken-project-notes.md",
];

const PI_CORE_FILES: &[&str] = &[
    "Experience/quick-context.md",
    "Experience/resolved-facts.md",
    "Experience/career-timeline.md",
    "Experience/expertise-map.md",
    "13-spoken-project-notes.md",
    "11-interview-answer-scripts.md",
    "Experience/repo-map.md",
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

pub fn load_context(workspace: &Path, kind: ContextKind) -> Result<ContextPack, String> {
    let root = find_mercor_root(workspace)?;
    let (version, files) = match kind {
        ContextKind::Realtime => (
            format!("mercor-realtime-v4+{REALTIME_PROMPT_VERSION}"),
            realtime_files(&root)?,
        ),
        ContextKind::Pi => (
            format!("mercor-pi-keep-v1+{PI_PROMPT_VERSION}"),
            pi_files(&root)?,
        ),
    };
    build_pack(&root, &version, files)
}

fn find_mercor_root(workspace: &Path) -> Result<PathBuf, String> {
    for ancestor in workspace.ancestors() {
        if ancestor.join("Experience/quick-context.md").is_file() {
            return Ok(ancestor.to_path_buf());
        }
    }
    let nested = workspace.join("work").join(MERCOR_DIRECTORY);
    if nested.join("Experience/quick-context.md").is_file() {
        return Ok(nested);
    }
    Err(format!(
        "Interview context was not found from {}. Select a context root containing Experience/quick-context.md or copy the repository's context-template directory and complete it.",
        workspace.display()
    ))
}

fn required_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = root.join(relative);
    path.is_file()
        .then_some(path)
        .ok_or_else(|| format!("Context file is missing: {relative}"))
}

fn realtime_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    REALTIME_FILES
        .iter()
        .map(|relative| required_file(root, relative))
        .collect()
}

fn pi_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for relative in PI_CORE_FILES {
        files.push(required_file(root, relative)?);
    }
    files.extend(child_docs(root, "Experience/companies", &["README.md", "technical-deep-dive.md"])?);
    files.extend(child_docs(root, "Experience/projects", &["README.md"])?);
    files.sort();
    Ok(files)
}

fn child_docs(root: &Path, parent: &str, names: &[&str]) -> Result<Vec<PathBuf>, String> {
    let directory = root.join(parent);
    let mut children = fs::read_dir(&directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .map(|entry| entry.map(|value| value.path()).map_err(|error| error.to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    children.sort();
    let mut files = Vec::new();
    for child in children {
        if !child.is_dir() {
            continue;
        }
        for name in names {
            let path = child.join(name);
            if !path.is_file() {
                return Err(format!(
                    "Context file is missing: {}",
                    path.strip_prefix(root)
                        .unwrap_or(&path)
                        .display()
                ));
            }
            files.push(path);
        }
    }
    if files.is_empty() {
        return Err(format!("No context documents found in {parent}"));
    }
    Ok(files)
}

fn build_pack(root: &Path, version: &str, files: Vec<PathBuf>) -> Result<ContextPack, String> {
    let mut text = String::new();
    let mut hasher = Sha256::new();
    hasher.update(version.as_bytes());
    for path in &files {
        let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
        let contents = fs::read_to_string(path)
            .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
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
