//! Headless SSH reliability soak: see docs/RELIABILITY.md.
//!
//! ```text
//! cargo run --locked --release --manifest-path src-tauri/Cargo.toml \
//!   --example reliability_soak -- --route ope-term-soak --duration-seconds 86400
//! ```

fn main() {
    if let Err(error) =
        ope_term_lib::reliability::main_with_args(std::env::args().skip(1).collect())
    {
        eprintln!("reliability soak failed: {error:#}");
        std::process::exit(1);
    }
}
