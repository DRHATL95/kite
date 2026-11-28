//! The checked-in C header must match the Rust source.
//! Regenerate: `KITE_UPDATE_HEADER=1 cargo test -p libkite --test header`.

#[test]
fn checked_in_header_matches_the_source() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let config = cbindgen::Config::from_file(dir.join("cbindgen.toml")).expect("cbindgen.toml");
    let mut generated = Vec::new();
    cbindgen::Builder::new()
        .with_crate(dir)
        .with_config(config)
        .generate()
        .expect("cbindgen")
        .write(&mut generated);
    let generated = String::from_utf8(generated).expect("utf-8");
    let path = dir.join("include/kite.h");
    if std::env::var_os("KITE_UPDATE_HEADER").is_some() {
        std::fs::create_dir_all(dir.join("include")).expect("include dir");
        std::fs::write(&path, &generated).expect("write header");
    }
    let on_disk = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        on_disk.replace("\r\n", "\n"),
        generated.replace("\r\n", "\n"),
        "include/kite.h is stale; regenerate with KITE_UPDATE_HEADER=1"
    );
}
