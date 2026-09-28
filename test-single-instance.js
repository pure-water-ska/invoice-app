// test-single-instance.js — v1.0.248
//
// Two copies of the desktop app must never run at once: both mount the same HDD store
// in %APPDATA%\<app>\data\, and DB._tauri.write rewrites each wt_*.json WHOLE-FILE, so
// the second process silently clobbers whatever the first wrote. They would also both
// sync to Firestore under the same device id.
//
// crates.io has no Tauri-1-compatible tauri-plugin-single-instance (all published
// versions target Tauri 2), so src-tauri/src/main.rs holds a hand-rolled loopback-port
// lock. `cargo check` proves it compiles; this suite pins the DESIGN DECISIONS that a
// future edit could quietly undo, and verifies the OS behaviour the lock depends on.
//
// Run: node test-single-instance.js

const fs = require('fs');
const net = require('net');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, cond, shown) => {
  if (cond) { pass++; console.log('  PASS  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
  else { fail++; console.log('  FAIL  ' + name + (shown !== undefined ? '  → ' + JSON.stringify(shown) : '')); }
};
const section = s => console.log('\n' + s);
const src = fs.readFileSync(path.join(__dirname, 'src-tauri', 'src', 'main.rs'), 'utf8');
const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

section('the lock exists and runs before any window is created');
{
  t('a lock is taken in main()', /TcpListener::bind\(lock_addr\(\)\)/.test(code));
  // If the guard ran after Builder, the second copy would already have opened a window
  // before discovering it should not exist.
  t('the guard runs BEFORE tauri::Builder',
    code.indexOf('TcpListener::bind') < code.indexOf('tauri::Builder::default()'));
  t('the second copy returns from main instead of building an app',
    /hand_off_to_running_instance\(\) \{\s*return;/.test(code.replace(/\s+/g, ' ').replace(/ \{ /g, ' { ')) ||
    /if lock\.is_err\(\) && hand_off_to_running_instance\(\)/.test(code));
  t('the console-window guard is still present (do-not-remove line)',
    /windows_subsystem = "windows"/.test(src));
}

section('it FAILS OPEN — a foreign occupant must never stop the app starting');
{
  // The port is in the ephemeral range, so an unrelated program could hold it. Refusing
  // to launch the invoicing app over that would be far worse than losing the guard.
  t('a failed bind alone does not exit — our reply is required too',
    /lock\.is_err\(\) && hand_off_to_running_instance\(\)/.test(code));
  t('no answer → returns false (start anyway)', /return false; \/\/|return false;/.test(code));
  t('the handshake reply is compared before exiting', /reply\.trim\(\) == PONG/.test(code));
  t('a wrong/foreign reply is not treated as our app',
    /if line\.trim\(\) != PING \{\s*continue/.test(code.replace(/\s+/g, ' ')) || /line\.trim\(\) != PING/.test(code));
  t('the app still builds when the lock could not be taken (Ok(listener) guard)',
    /if let Ok\(listener\) = lock/.test(code));
}

section('handshake robustness');
{
  // A single read() can return a partial payload and turn a valid ping into a mismatch.
  // Must hold on BOTH sides. Checking the token appears 'somewhere' passed when only
  // one of the two call sites was changed, so count them.
  t('BOTH sides read line-delimited', (code.match(/read_line/g) || []).length === 2,
    (code.match(/read_line/g) || []).length);
  t('nothing reads to EOF (would block until the peer closes)',
    !/read_to_string|read_to_end/.test(code));
  t('…and nothing uses a bare fixed-buffer read', !/\.read\(&mut buf\)/.test(code));
  t('both sides have IO timeouts so neither can hang',
    /set_read_timeout/.test(code) && /set_write_timeout/.test(code));
  t('connect is bounded too', /connect_timeout/.test(code));
  t('ping and pong are distinct tokens',
    /const PING: &str = "([^"]+)"/.exec(code)[1] !== /const PONG: &str = "([^"]+)"/.exec(code)[1]);
}

section('it listens on LOOPBACK only');
{
  // 0.0.0.0 would expose the lock port to the network and can trigger a Windows
  // Firewall prompt on first launch. Loopback-only avoids both.
  t('binds Ipv4Addr::LOCALHOST', /Ipv4Addr::LOCALHOST/.test(code));
  t('does not bind UNSPECIFIED / 0.0.0.0',
    !/UNSPECIFIED/.test(code) && !/0\.0\.0\.0/.test(code));
  const port = parseInt(/const LOCK_PORT: u16 = (\d+)/.exec(code)[1], 10);
  t('the port is in the ephemeral range (not a well-known service)', port >= 49152 && port <= 65535, port);
}

section('the focus path cannot silently become a no-op');
{
  t('it looks up the window', /get_window\("main"\)/.test(code));
  // tauri.conf.json declares no explicit label, so "main" is the default — but a future
  // label change must not turn focusing into nothing.
  t('…with a fallback if the label ever changes', /windows\(\)\.values\(\)\.next\(\)\.cloned\(\)/.test(code));
  t('un-minimises as well as focusing', /unminimize\(\)/.test(code) && /set_focus\(\)/.test(code));
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  t('tauri.conf.json still declares exactly one window', (conf.tauri.windows || []).length === 1,
    (conf.tauri.windows || []).length);
}

section('no new dependency was added for this');
{
  const cargo = fs.readFileSync(path.join(__dirname, 'src-tauri', 'Cargo.toml'), 'utf8');
  t('no tauri-plugin-single-instance dependency', !/tauri-plugin-single-instance/.test(cargo));
  t('no git dependency for CI to fetch', !/\bgit\s*=/.test(cargo));
  t('only std is used for the lock', /use std::net::/.test(src) && /use std::io::/.test(src));
}

section('the OS behaviour the lock relies on');
(async () => {
  const port = parseInt(/const LOCK_PORT: u16 = (\d+)/.exec(code)[1], 10);
  const first = net.createServer();
  const bound = await new Promise(res => {
    first.once('error', () => res(false));
    first.listen(port, '127.0.0.1', () => res(true));
  });
  if (!bound) {
    console.log('  SKIP  port ' + port + ' is busy on this machine right now');
  } else {
    const second = net.createServer();
    const secondFailed = await new Promise(res => {
      second.once('error', e => res(e.code === 'EADDRINUSE'));
      second.listen(port, '127.0.0.1', () => res(false));
    });
    t('a second bind to the same loopback port is refused (EADDRINUSE)', secondFailed);
    try { second.close(); } catch {}
    await new Promise(res => first.close(res));
    // The OS must release the port on close, or a crash would leave a permanent lock.
    const third = net.createServer();
    const rebound = await new Promise(res => {
      third.once('error', () => res(false));
      third.listen(port, '127.0.0.1', () => res(true));
    });
    t('the port is released when the holder goes away — no stale lock after a crash', rebound);
    if (rebound) await new Promise(res => third.close(res));
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
