// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::time::Duration;
use tauri::Manager;

// ── Single instance (v1.0.248) ──────────────────────────────────────────────
// Two copies of this app must never run at once. Both would mount the same HDD
// store in %APPDATA%\<app>\data\, and DB._tauri.write rewrites each wt_*.json
// WHOLE-FILE — so the second process silently clobbers whatever the first wrote.
// They would also both sync to Firestore under the same device id.
//
// The lock is a loopback TCP listener rather than a lock file, because the OS
// releases a socket when the process dies: a crash can never leave a stale lock
// that keeps the user out of their own invoicing app. crates.io has no
// Tauri-1-compatible tauri-plugin-single-instance (all 51 published versions
// target Tauri 2), so this is hand-rolled rather than a git dependency.
//
// A port in the ephemeral range could in principle be held by an unrelated
// program. That must NOT stop the app starting, so a failed bind is not trusted
// on its own: we connect and require OUR magic reply before concluding another
// copy is running. Anything else — foreign occupant, no answer, refused
// connection — and we start normally WITHOUT the lock. Failing open is
// deliberate: refusing to launch would be far worse than losing the guard for
// one session.
//
// The handshake is newline-delimited and read with read_line rather than a
// single read() so a partial TCP delivery cannot truncate it into a mismatch.
const PING: &str = "WTINV-FOCUS";
const PONG: &str = "WTINV-OK";
const IO_TIMEOUT: Duration = Duration::from_millis(600);

/// The lock port is DERIVED FROM THE BUNDLE IDENTIFIER rather than fixed (v1.0.264).
///
/// A fixed port meant every build of this app shared one lock, so the side-by-side
/// TEST build (com.wt.invoice.test) would have found the production app holding it,
/// answered its own handshake, focused the production window and exited — making the
/// test build impossible to launch while the real one runs. Deriving the port means
/// two different identifiers can never collide, and two copies of the SAME identifier
/// still do, which is the whole point of the lock.
///
/// FNV-1a over the identifier, mapped into the ephemeral range. Stable across runs,
/// because it depends only on the identifier string.
fn port_for(identifier: &str) -> u16 {
    let mut h: u32 = 2166136261;
    for b in identifier.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    49152 + (h % 16384) as u16 // 49152..=65535
}

fn lock_addr(port: u16) -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
}

/// Ask an already-running copy to show itself.
/// Returns true ONLY when our app answered — i.e. this process should now exit.
fn hand_off_to_running_instance(port: u16) -> bool {
    let addr = lock_addr(port);
    let Ok(stream) = TcpStream::connect_timeout(&addr, IO_TIMEOUT) else {
        return false; // nothing listening any more (e.g. mid-update relaunch)
    };
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let Ok(mut write_half) = stream.try_clone() else { return false };
    if writeln!(write_half, "{}", PING).is_err() {
        return false;
    }
    let mut reply = String::new();
    if BufReader::new(stream).read_line(&mut reply).is_err() {
        return false;
    }
    reply.trim() == PONG
}

/// Serve focus requests from later launches, for as long as this process lives.
fn serve_focus_requests(listener: TcpListener, handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
            let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

            let Ok(mut write_half) = stream.try_clone() else { continue };
            let mut line = String::new();
            if BufReader::new(stream).read_line(&mut line).is_err() {
                continue;
            }
            if line.trim() != PING {
                continue; // not our protocol — ignore rather than act on it
            }
            let _ = writeln!(write_half, "{}", PONG);

            // "main" is the default label for the single window in
            // tauri.conf.json, which declares no explicit one. Fall back to
            // whatever window exists so a future label change cannot silently
            // turn this into a no-op.
            let window = handle
                .get_window("main")
                .or_else(|| handle.windows().values().next().cloned());
            if let Some(w) = window {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });
}

fn main() {
    // The context is built first so the identifier can pick the lock port; it is then
    // handed to run() unchanged.
    let ctx = tauri::generate_context!();
    let port = port_for(&ctx.config().tauri.bundle.identifier);

    let lock = TcpListener::bind(lock_addr(port));
    if lock.is_err() && hand_off_to_running_instance(port) {
        return; // another copy is up and has been brought to the front
    }

    tauri::Builder::default()
        .setup(move |app| {
            if let Ok(listener) = lock {
                serve_focus_requests(listener, app.handle());
            }
            Ok(())
        })
        .run(ctx)
        .expect("error while running tauri application");
}
