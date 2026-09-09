use codex_overlay_lib::context::{build_prompt_context, ContextKind};

#[test]
fn direct_context_is_trimmed_deterministic_and_lane_specific() {
    let quick = build_prompt_context("  Preferred answer: concise.  ", ContextKind::Realtime);
    let quick_again = build_prompt_context("Preferred answer: concise.", ContextKind::Realtime);
    let pi = build_prompt_context("Preferred answer: concise.", ContextKind::Pi);

    assert_eq!(quick.text, "Preferred answer: concise.");
    assert_eq!(quick.info.file_count, 1);
    assert_eq!(quick.info.byte_count, quick.text.len());
    assert_eq!(quick.info.hash, quick_again.info.hash);
    assert_ne!(quick.info.hash, pi.info.hash);
}

#[test]
fn empty_direct_context_is_allowed() {
    let pack = build_prompt_context("  \n\t", ContextKind::Realtime);
    assert!(pack.text.is_empty());
    assert_eq!(pack.info.file_count, 0);
    assert_eq!(pack.info.byte_count, 0);
}
