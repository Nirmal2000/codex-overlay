use codex_overlay_lib::context::{load_context, ContextKind};
use std::path::Path;

#[test]
fn bundled_context_template_loads_and_is_deterministic() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let template = manifest_dir.parent().unwrap().join("context-template");
    let quick = load_context(&template, ContextKind::Realtime).unwrap();
    let full = load_context(&template, ContextKind::Pi).unwrap();

    assert_eq!(quick.info.file_count, 5);
    assert!(quick.info.byte_count > 100);
    assert!(full.info.file_count >= quick.info.file_count);
    assert!(full.text.contains("===== FILE: Experience/repo-map.md ====="));
    assert!(full.text.contains("===== FILE: 13-spoken-project-notes.md ====="));
    assert_eq!(
        quick.info.hash,
        load_context(&template, ContextKind::Realtime)
            .unwrap()
            .info
            .hash
    );
}
