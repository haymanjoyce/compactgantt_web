// main.js — Electron scaffold for CompactGantt (desktop packaging).
//
// LOAD-BEARING: the renderer is served over a custom `app://` scheme registered
// as SECURE — never via loadFile()'s file:// origin. file:// is not a secure
// context, so the browser denies the File System Access API there, which would
// leave the in-place Save / Save As / folder-memory feature dormant in the
// package (exactly as it is when index.html is double-clicked today). A secure
// custom scheme restores the secure context those features require. The web app
// (index.html, *.js, vendor/) is served unmodified — no Node dependency at
// runtime, so no preload/IPC.

const { app, protocol, BrowserWindow, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// A fixed, constant authority for every app:// URL. This sidesteps the
// host-vs-pathname ambiguity of standard schemes: `new URL('app://index.html')`
// parses "index.html" as the URL HOST (empty pathname), which would 404 the
// entry file. We always load app://bundle/index.html and resolve purely from
// the pathname, so nested resources (vendor/xlsx-….js, etc.) — which the page
// requests relative to that base and therefore inherit the same host — resolve
// unambiguously too.
const APP_SCHEME = 'app';
const APP_HOST = 'bundle';
const ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;

// Register the scheme's privileges at module load, BEFORE any app-ready work —
// scheme privileges are baked into Chromium's network service as it initialises
// on the `ready` event, so this cannot be deferred into whenReady().
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true, // http-like URL/origin semantics (relative refs, origins)
      secure: true, // marks app:// a secure context -> re-enables the FSAA
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Minimal extension -> MIME map. CSS is inline in index.html and all scripts are
// classic (not modules), so text/html on the document is the only strictly
// required type; the rest are correctness/hygiene.
const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

let mainWindow = null;

// Serve files under app://bundle/ from the app's own root directory. Reads go
// through Node's fs (Electron patches fs to be transparent over app.asar), NOT
// net.fetch — net's file:// loader has been unreliable inside asar across
// Electron versions. Keeps electron-builder's default asar packing.
function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    const appRoot = app.getAppPath();
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '' || pathname === '/') pathname = '/index.html';

    // Resolve against the app root; '.' + pathname keeps the leading-slash path
    // relative so path.resolve can't escape appRoot on its own.
    const resolved = path.resolve(appRoot, '.' + pathname);

    // Guard against path traversal (e.g. app://bundle/../../secret).
    const rel = path.relative(appRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain' } });
    }

    try {
      const data = await fs.promises.readFile(resolved);
      return new Response(data, {
        headers: {
          'content-type': contentTypeFor(resolved),
          'cache-control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
  });
}

// Open the EXISTING #aboutDialog shipped in index.html (Slice B) — the single
// source of third-party attribution. Triggered directly (not by simulating a
// button click), and guarded against: the dialog not existing yet (menu clicked
// before the page finished loading) and the dialog already being open
// (showModal() throws if called while open).
function openAboutDialog() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win) return;
  win.webContents
    .executeJavaScript(
      "(() => { const d = document.getElementById('aboutDialog');" +
        ' if (d && typeof d.showModal === "function" && !d.open) d.showModal(); })();'
    )
    .catch(() => {});
}

// Keep the default menu roles (crucially the View menu: Reload / Toggle
// DevTools / zoom — deliberate ergonomics for a developer-and-sole-user build)
// and add one Help menu with a single About item. The mac app menu is included
// only on darwin so a dev run there isn't broken; the distribution target is
// Windows.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'About CompactGantt',
          click: () => openAboutDialog(),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Title-bar / taskbar icon: the CompactGantt mark, resolved from the bundled
    // asset the same way the app:// handler resolves everything else (relative to
    // app.getAppPath(), asar-transparent). Without this the window shows the
    // default Electron icon.
    icon: path.join(app.getAppPath(), 'assets', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // webSecurity defaults to true — do not disable it.
    },
  });
  mainWindow.loadURL(ENTRY_URL);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerAppProtocol();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Standard non-mac behaviour; on macOS apps stay alive until Cmd+Q.
  if (process.platform !== 'darwin') app.quit();
});
