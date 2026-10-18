// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;
use handy_app_lib::CliArgs;

fn main() {
    // `hearth.exe --nook-restore-windows`, which puts back the windows Nook arranged (D75). It
    // runs before anything else reads the arguments, so the installer's hooks and a person in a
    // terminal get their windows back even when Hearth is stuck, and single-instance and deep
    // links never see these flags. Hearth's own version goes first, so a flag given later wins.
    #[cfg(windows)]
    {
        let mut args = std::env::args_os();
        let version =
            std::ffi::OsString::from(concat!("--hearth-version=", env!("HEARTH_VERSION")));
        let args = args.next().into_iter().chain([version]).chain(args);
        if let Some(code) = nook_restore::cli::maybe_run(args) {
            std::process::exit(code);
        }
    }

    let cli_args = CliArgs::parse();

    #[cfg(target_os = "linux")]
    {
        // DMABUF renderer causes crashes on various GPU/display server configurations
        // See: https://github.com/tauri-apps/tauri/issues/9394
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    #[cfg(target_os = "windows")]
    {
        // Avoid overlay/capture layer crashes (#2049). Set before backend
        // initialization, preserving user overrides.
        if std::env::var_os("VK_LOADER_LAYERS_DISABLE").is_none()
            && !handy_app_lib::env_flag_enabled("HANDY_KEEP_VULKAN_IMPLICIT_LAYERS")
        {
            std::env::set_var("VK_LOADER_LAYERS_DISABLE", "~implicit~");
        }
    }

    handy_app_lib::run(cli_args)
}
