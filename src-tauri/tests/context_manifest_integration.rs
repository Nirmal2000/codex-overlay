use codex_overlay_lib::context::{load_context, ContextKind};
use std::fs;
use std::path::Path;

#[test]
fn bundled_context_template_loads_and_is_deterministic() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let template = manifest_dir.parent().unwrap().join("context-template");
    let quick = load_context(&template, ContextKind::Realtime).unwrap();
    let full = load_context(&template, ContextKind::Pi).unwrap();

    assert!(quick.info.file_count >= 2);
    assert!(quick.info.byte_count > 100);
    assert_eq!(full.info.file_count, quick.info.file_count);
    assert!(full.text.contains("===== FILE:"));
    assert_eq!(
        quick.info.hash,
        load_context(&template, ContextKind::Realtime)
            .unwrap()
            .info
            .hash
    );
}

#[test]
fn arbitrary_document_names_and_nested_folders_are_loaded() {
    let root = std::env::temp_dir().join(format!("codex-overlay-context-{}", uuid::Uuid::new_v4()));
    let nested = root.join("anything").join("deeper");
    fs::create_dir_all(&nested).unwrap();
    fs::write(root.join("facts-any-name.txt"), "Preferred answer: concise").unwrap();
    fs::write(
        nested.join("architecture-notes.markdown"),
        "Queue then stream",
    )
    .unwrap();
    fs::write(nested.join("ignored.png"), b"not context").unwrap();

    let quick = load_context(&root, ContextKind::Realtime).unwrap();
    let pi = load_context(&root, ContextKind::Pi).unwrap();
    assert_eq!(quick.info.file_count, 2);
    assert_eq!(pi.info.file_count, 2);
    assert!(quick.text.contains("facts-any-name.txt"));
    assert!(quick
        .text
        .contains("anything/deeper/architecture-notes.markdown"));
    assert!(!quick.text.contains("ignored.png"));

    fs::remove_dir_all(root).unwrap();
}
