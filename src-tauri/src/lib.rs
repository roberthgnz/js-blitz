mod credentials;
mod menus;
mod process_guard;
mod service;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let host = Arc::new(service::DesktopHost::default());
    let setup_host = host.clone();
    let exit_started = AtomicBool::new(false);
    let exit_ready = Arc::new(AtomicBool::new(false));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            service::desktop_invoke,
            menus::show_context_menu
        ])
        .setup(move |app| {
            app.manage(menus::DesktopMenu(menus::build(app.handle())?));
            app.on_menu_event(menus::handle_event);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Requests share this initialization future, so none can reach
                // the service before its initialize response has arrived.
                let _ = setup_host.service(&handle).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to initialize JSBlitz");

    app.run(move |app, event| match event {
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if !exit_ready.load(Ordering::Acquire) {
                api.prevent_exit();
                if !exit_started.swap(true, Ordering::AcqRel) {
                    let host = host.clone();
                    let app = app.clone();
                    let exit_ready = exit_ready.clone();
                    tauri::async_runtime::spawn(async move {
                        host.shutdown().await;
                        exit_ready.store(true, Ordering::Release);
                        app.exit(code.unwrap_or(0));
                    });
                }
            }
        }
        tauri::RunEvent::Exit => host.force_stop(),
        _ => {}
    });
}
