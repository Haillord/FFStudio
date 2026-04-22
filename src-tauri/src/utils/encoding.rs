pub(crate) fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

pub(crate) fn decode_base64_image_data(data: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let trimmed = data.trim();
    let b64 = if let Some((_, tail)) = trimmed.split_once(',') {
        tail
    } else {
        trimmed
    };
    base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| e.to_string())
}
