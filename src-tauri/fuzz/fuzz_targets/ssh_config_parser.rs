#![no_main]

use libfuzzer_sys::fuzz_target;

const MAX_CONFIG_BYTES: usize = 128 * 1024;

fuzz_target!(|data: &[u8]| {
    if data.len() > MAX_CONFIG_BYTES {
        return;
    }
    if let Ok(text) = std::str::from_utf8(data) {
        ope_term_lib::fuzz_ssh_config_parser(text);
    }
});
