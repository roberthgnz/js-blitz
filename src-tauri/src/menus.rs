use serde_json::json;
use tauri::{
    menu::{Menu, MenuEvent, MenuItem, Submenu},
    AppHandle, Emitter, Manager, State, WebviewWindow, Wry,
};
use tauri_plugin_opener::OpenerExt;

use crate::service::DesktopEvent;

pub struct DesktopMenu(pub Menu<Wry>);

const THEMES: &[(&str, &str)] = &[
    ("ayu-dark", "Ayu Dark"),
    ("dracula", "Dracula"),
    ("github-dark", "GitHub Dark"),
    ("monokai-classic", "Monokai Classic"),
    ("night-owl", "Night Owl"),
    ("noctis", "Noctis"),
];

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let themes = Submenu::new(app, "Color Theme", true)?;
    for (name, label) in THEMES {
        themes.append(&MenuItem::with_id(
            app,
            format!("theme:{name}"),
            label,
            true,
            None::<&str>,
        )?)?;
    }
    let github = MenuItem::with_id(app, "github", "GitHub", true, None::<&str>)?;
    let releases = MenuItem::with_id(app, "releases", "Check for Updates…", true, None::<&str>)?;
    Menu::with_items(app, &[&themes, &github, &releases])
}

pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if let Some(name) = id.strip_prefix("theme:") {
        if THEMES.iter().any(|(theme, _)| *theme == name) {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "desktop-event",
                    DesktopEvent {
                        event: "set-theme".into(),
                        args: vec![json!(name)],
                    },
                );
            }
        }
    } else {
        let url = match id {
            "github" => "https://github.com/roberthgnz/js-blitz",
            "releases" => "https://github.com/roberthgnz/js-blitz/releases",
            _ => return,
        };
        // Only these hard-coded HTTPS destinations can reach the opener.
        if app.opener().open_url(url, None::<&str>).is_err() {
            eprintln!("JSBlitz could not open the browser.");
        }
    }
}

#[tauri::command]
pub fn show_context_menu(
    window: WebviewWindow,
    menu: State<'_, DesktopMenu>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This command is only available in the main window.".into());
    }
    window
        .popup_menu(&menu.0)
        .map_err(|error| error.to_string())
}
