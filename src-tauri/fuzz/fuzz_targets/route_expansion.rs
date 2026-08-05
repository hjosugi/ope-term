#![no_main]

use libfuzzer_sys::fuzz_target;

const MAX_CONFIG_BYTES: usize = 128 * 1024;
const MAX_ROUTE_HOPS: usize = 16;
const MAX_ALIAS_BYTES: usize = 512;

fuzz_target!(|data: &[u8]| {
    let Some(separator) = data.iter().position(|byte| *byte == 0) else {
        return;
    };
    if separator > MAX_CONFIG_BYTES {
        return;
    }
    let Ok(config) = std::str::from_utf8(&data[..separator]) else {
        return;
    };
    let Ok(route_text) = std::str::from_utf8(&data[separator + 1..]) else {
        return;
    };
    let route: Vec<String> = route_text
        .lines()
        .filter(|alias| !alias.is_empty() && alias.len() <= MAX_ALIAS_BYTES)
        .take(MAX_ROUTE_HOPS)
        .map(str::to_owned)
        .collect();
    ope_term_lib::fuzz_route_expansion(config, &route);
});
