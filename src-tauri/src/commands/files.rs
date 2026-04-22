#[tauri::command]
pub(crate) async fn file_exists(path: String) -> bool {
    crate::file_exists(path).await
}

#[tauri::command]
pub(crate) async fn next_available_path(path: String) -> Result<String, String> {
    crate::next_available_path(path).await
}

#[tauri::command]
pub(crate) async fn open_in_explorer(path: String) -> Result<(), String> {
    crate::open_in_explorer(path).await
}

#[tauri::command]
pub(crate) async fn write_temp_list(contents: String) -> Result<String, String> {
    crate::write_temp_list(contents).await
}

#[tauri::command]
pub(crate) async fn read_file_base64(path: String) -> Result<String, String> {
    crate::read_file_base64(path).await
}

#[tauri::command]
pub(crate) async fn save_base64_image(data: String, path: String) -> Result<(), String> {
    crate::save_base64_image(data, path).await
}

#[tauri::command]
pub(crate) async fn export_logs(app: tauri::AppHandle, destination: String) -> Result<String, String> {
    crate::export_logs(app, destination).await
}
