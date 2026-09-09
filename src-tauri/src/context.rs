use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::prompts::{PI_PROMPT_VERSION, REALTIME_PROMPT_VERSION};

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

/// Build the small user-authored context block that is inserted directly into
/// the model prompt. Workspace files are intentionally not read here: Pi gets
/// the selected folder as its cwd and traverses it on demand, while Quick has
/// no filesystem tools and relies on this direct context.
pub fn build_prompt_context(value: &str, kind: ContextKind) -> ContextPack {
    let text = value.trim().to_string();
    let version = match kind {
        ContextKind::Realtime => format!("direct-realtime-v1+{REALTIME_PROMPT_VERSION}"),
        ContextKind::Pi => format!("direct-pi-v1+{PI_PROMPT_VERSION}"),
    };
    let mut hasher = Sha256::new();
    hasher.update(version.as_bytes());
    hasher.update([0]);
    hasher.update(text.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    ContextPack {
        info: ContextInfo {
            version,
            hash,
            file_count: usize::from(!text.is_empty()),
            byte_count: text.len(),
        },
        text,
    }
}
