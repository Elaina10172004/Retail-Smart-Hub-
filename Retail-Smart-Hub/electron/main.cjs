const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { app, BrowserWindow, shell, ipcMain, safeStorage, session } = electron;

if (!app || !BrowserWindow || !shell) {
  console.error('[desktop-shell] Electron APIs are unavailable. The runtime is likely running with ELECTRON_RUN_AS_NODE enabled.');
  process.exit(1);
}

const isDev = process.env.RETAIL_SMART_HUB_DEV === 'true';
const isDebugMode = process.env.RETAIL_SMART_HUB_DEBUG === 'true';
const runtimeNodeEnv = (process.env.NODE_ENV || '').trim() || (isDev ? 'development' : 'production');
process.env.NODE_ENV = runtimeNodeEnv;
const startUrl = process.env.RETAIL_SMART_HUB_START_URL || 'http://127.0.0.1:3000';
const apiPort = Number(process.env.RETAIL_SMART_HUB_API_PORT || process.env.API_PORT || 4000);
const allowInsecureTokenStorageRequested = process.env.RETAIL_SMART_HUB_ALLOW_INSECURE_TOKEN_STORAGE === 'true';
const allowInsecureTokenStorage = allowInsecureTokenStorageRequested && (isDev || isDebugMode);
const externalAllowList = String(process.env.RETAIL_SMART_HUB_EXTERNAL_ALLOWLIST || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);
const allowedRendererPermissions = new Set(
  String(process.env.RETAIL_SMART_HUB_ALLOWED_PERMISSIONS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
let apiServer = null;
let authTokenFile = '';
let volatileAuthToken = '';
let cspRegistered = false;
let trustedDevOrigin = '';

try {
  trustedDevOrigin = new URL(startUrl).origin.toLowerCase();
} catch {
  trustedDevOrigin = '';
}

function resolveAuthTokenFile() {
  if (!authTokenFile) {
    authTokenFile = path.join(app.getPath('userData'), 'auth-token.dat');
  }
  return authTokenFile;
}

function readStoredAuthToken() {
  if (volatileAuthToken) {
    return volatileAuthToken;
  }

  try {
    const filePath = resolveAuthTokenFile();
    if (!fs.existsSync(filePath)) {
      return '';
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) {
      return '';
    }

    if (raw.startsWith('ENC:')) {
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        const encrypted = Buffer.from(raw.slice(4), 'base64');
        return safeStorage.decryptString(encrypted);
      }

      writeDesktopLog('encrypted token exists but safeStorage is unavailable; ignoring persisted token');
      return '';
    }

    if (raw.startsWith('PLA:')) {
      if (allowInsecureTokenStorage) {
        return Buffer.from(raw.slice(4), 'base64').toString('utf8');
      }

      writeDesktopLog('found insecure token storage file but insecure storage is disabled; token discarded');
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore cleanup error
      }
      return '';
    }

    return '';
  } catch (error) {
    writeDesktopLog(`failed to read auth token: ${error instanceof Error ? error.message : String(error)}`);
    return '';
  }
}

function writeStoredAuthToken(token) {
  volatileAuthToken = token || '';
  const filePath = resolveAuthTokenFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  if (!token) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    fs.writeFileSync(filePath, `ENC:${encrypted.toString('base64')}`, 'utf8');
    return;
  }

  if (!allowInsecureTokenStorage) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    writeDesktopLog('safeStorage unavailable, token is kept in memory only (disk fallback disabled)');
    return;
  }

  writeDesktopLog('safeStorage unavailable, writing token with explicit insecure debug/dev fallback');
  fs.writeFileSync(filePath, `PLA:${Buffer.from(token, 'utf8').toString('base64')}`, 'utf8');
}

function isTrustedAppUrl(rawUrl) {
  if (!rawUrl) {
    return false;
  }

  if (rawUrl.startsWith('file://')) {
    return !isDev;
  }

  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    if (!isDev) {
      return false;
    }
    return Boolean(trustedDevOrigin) && parsed.origin.toLowerCase() === trustedDevOrigin;
  } catch {
    return false;
  }
}

function isAllowedExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    if (externalAllowList.length === 0) {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return externalAllowList.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  } catch {
    return false;
  }
}

function openAllowedExternalUrl(rawUrl, source) {
  if (!isAllowedExternalUrl(rawUrl)) {
    writeDesktopLog(`blocked ${source} URL: ${rawUrl}`);
    return false;
  }

  shell
    .openExternal(rawUrl)
    .catch((error) => writeDesktopLog(`failed to open external URL from ${source}: ${error instanceof Error ? error.message : String(error)}`));
  return true;
}

function getSenderUrl(event) {
  if (event?.senderFrame?.url) {
    return event.senderFrame.url;
  }
  if (event?.sender?.getURL) {
    return event.sender.getURL();
  }
  return '';
}

function assertTrustedIpcSender(event, channel) {
  const senderUrl = getSenderUrl(event);
  if (isTrustedAppUrl(senderUrl)) {
    return;
  }

  writeDesktopLog(`blocked IPC channel "${channel}" from untrusted sender: ${senderUrl || '(empty url)'}`);
  throw new Error('Forbidden IPC sender');
}

function registerSecureIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, channel);
    return handler(event, ...args);
  });
}

function registerPermissionHandlers() {
  const defaultSession = session.defaultSession;
  if (!defaultSession) {
    return;
  }

  defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestUrl = details?.requestingUrl || webContents.getURL();
    const allowed = isTrustedAppUrl(requestUrl) && allowedRendererPermissions.has(permission);

    if (!allowed) {
      writeDesktopLog(`permission denied: ${permission} from ${requestUrl || '(empty url)'}`);
    }

    callback(allowed);
  });

  defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const origin = requestingOrigin || webContents.getURL();
    return isTrustedAppUrl(origin) && allowedRendererPermissions.has(permission);
  });
}

function registerCsp() {
  if (cspRegistered) {
    return;
  }
  cspRegistered = true;

  const connectTargets = [`http://127.0.0.1:${apiPort}`];
  if (isDev) {
    connectTargets.push(startUrl);
    try {
      const devOrigin = new URL(startUrl).origin;
      connectTargets.push(devOrigin.replace(/^http/i, 'ws'));
    } catch {
      // ignore invalid dev URL
    }
  }

  const csp = [
    "default-src 'self'",
    isDev ? "script-src 'self' 'unsafe-eval'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${connectTargets.join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

function writeDesktopLog(message) {
  try {
    const logPath = resolveDesktopLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // Ignore logging failures in production diagnostics.
  }
}

function resolveDesktopLogPath() {
  return process.env.RETAIL_SMART_HUB_DESKTOP_LOG || path.join(app.getPath('userData'), 'desktop.log');
}

async function startEmbeddedApi() {
  if (isDev) {
    process.env.RETAIL_SMART_HUB_API_URL = process.env.RETAIL_SMART_HUB_API_URL || `http://127.0.0.1:${apiPort}/api`;
    writeDesktopLog(`desktop shell running in dev mode, API URL=${process.env.RETAIL_SMART_HUB_API_URL}`);
    return;
  }

  process.env.NODE_ENV = 'production';
  process.env.API_PORT = String(apiPort);
  process.env.RETAIL_SMART_HUB_DATA_DIR = process.env.RETAIL_SMART_HUB_DATA_DIR || path.join(app.getPath('userData'), 'data');
  process.env.RETAIL_SMART_HUB_ENV_DIR = process.env.RETAIL_SMART_HUB_ENV_DIR || path.dirname(app.getPath('exe'));
  process.env.CORS_ALLOW_NULL_ORIGIN = process.env.CORS_ALLOW_NULL_ORIGIN || 'true';
  process.env.RETAIL_SMART_HUB_DESKTOP_LOG = process.env.RETAIL_SMART_HUB_DESKTOP_LOG || resolveDesktopLogPath();
  writeDesktopLog(`starting embedded API on preferred port=${apiPort}`);
  writeDesktopLog(`node env=${process.env.NODE_ENV}`);
  writeDesktopLog(`data dir=${process.env.RETAIL_SMART_HUB_DATA_DIR}`);
  writeDesktopLog(`env dir=${process.env.RETAIL_SMART_HUB_ENV_DIR}`);
  writeDesktopLog(`desktop log=${process.env.RETAIL_SMART_HUB_DESKTOP_LOG}`);

  const { createApp } = require(path.join(__dirname, '..', 'dist-server', 'app.js'));
  const expressApp = createApp();

  const actualPort = await new Promise((resolve, reject) => {
    let settled = false;
    let triedFallback = false;

    const tryListen = (port) => {
      const server = expressApp.listen(port, '127.0.0.1', () => {
        if (settled) {
          return;
        }

        settled = true;
        apiServer = server;
        const address = server.address();
        const resolvedPort = typeof address === 'object' && address ? address.port : port;
        writeDesktopLog(`embedded API started on http://127.0.0.1:${resolvedPort}`);
        resolve(resolvedPort);
      });

      server.on('error', (error) => {
        if (settled) {
          return;
        }

        if (!triedFallback && error && error.code === 'EADDRINUSE') {
          triedFallback = true;
          writeDesktopLog(`preferred API port ${apiPort} is already in use, retrying with a random local port`);
          tryListen(0);
          return;
        }

        settled = true;
        writeDesktopLog(`embedded API server error: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        reject(error);
      });
    };

    tryListen(apiPort);
  });

  process.env.API_PORT = String(actualPort);
  process.env.RETAIL_SMART_HUB_API_URL = `http://127.0.0.1:${actualPort}/api`;
}

function createWindow() {
  registerCsp();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f5f8',
    title: 'Retail Smart Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAppUrl(url)) {
      writeDesktopLog(`blocked new app window request: ${url}`);
      return { action: 'deny' };
    }
    openAllowedExternalUrl(url, 'window-open');
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url)) {
      return;
    }
    event.preventDefault();
    openAllowedExternalUrl(url, 'navigation');
  });

  if (isDev) {
    win.loadURL(startUrl);
    return;
  }

  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(async () => {
  try {
    if (allowInsecureTokenStorageRequested && !allowInsecureTokenStorage) {
      writeDesktopLog(
        'RETAIL_SMART_HUB_ALLOW_INSECURE_TOKEN_STORAGE is ignored outside explicit dev/debug mode; using memory-only fallback',
      );
    }

    registerPermissionHandlers();
    registerSecureIpc('auth:get-token', () => readStoredAuthToken());
    registerSecureIpc('auth:set-token', (_event, token) => {
      const normalized = typeof token === 'string' ? token.trim() : '';
      const boundedToken = normalized.slice(0, 8192);
      writeStoredAuthToken(boundedToken);
      return true;
    });
    registerSecureIpc('auth:clear-token', () => {
      writeStoredAuthToken('');
      return true;
    });

    writeDesktopLog('electron app is ready');
    await startEmbeddedApi();
  } catch (error) {
    console.error('[desktop-shell] failed to start embedded API:', error);
    writeDesktopLog(`failed to start embedded API: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    app.quit();
    return;
  }

  createWindow();
  writeDesktopLog('main window created');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  writeDesktopLog('electron app quitting');
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
