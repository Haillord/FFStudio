pub(crate) fn normalize_fs_input(value: &str) -> String {
    let trimmed = value.trim();
    let unquoted = trimmed
        .trim_start_matches('"')
        .trim_end_matches('"')
        .trim_start_matches('\'')
        .trim_end_matches('\'');
    unquoted.trim().to_string()
}
