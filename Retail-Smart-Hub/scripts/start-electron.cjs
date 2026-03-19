const { spawn } = require('node:child_process');
const path = require('node:path');

const appDir = path.resolve(__dirname, '..');
const electronBinary = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainEntry = path.join(appDir, 'electron', 'main.cjs');

const env = {
  ...process.env,
};

delete env.ELECTRON_RUN_AS_NODE;
env.NODE_ENV = (env.NODE_ENV || '').trim() || (env.RETAIL_SMART_HUB_DEV === 'true' ? 'development' : 'production');

const child = spawn(electronBinary, [mainEntry], {
  cwd: appDir,
  stdio: 'inherit',
  windowsHide: false,
  env,
});

child.on('error', (error) => {
  console.error('[desktop-shell] failed to launch electron runtime:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[desktop-shell] electron exited with signal ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 0);
});
