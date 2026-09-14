import { spawn } from 'node:child_process';
import process from 'node:process';
import electron from 'electron';

const child = spawn(electron, ['--no-sandbox', 'dist-electron/main.js'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: 'http://localhost:1421' },
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
