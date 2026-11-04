import { spawn } from 'child_process';
import process from 'process';

// Independent steps run in parallel and every failure is reported in one run,
// so a type error does not hide lint or format errors until the next attempt.
// Passing steps print one line; only failing steps print their output.
const STEPS = ['typecheck:electron', 'typecheck', 'lint', 'format:check'];
const children = new Set();

// A harness or CI timeout kills only this process; take the steps down with it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exit(1);
  });
}

function runStep(name) {
  const started = Date.now();
  return new Promise((resolve) => {
    // --silent drops npm's script banners; the step name is printed instead.
    // Windows resolves `npm` to npm.cmd only through a shell; the arguments are fixed.
    const child = spawn('npm', ['run', '--silent', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    children.add(child);
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ name, ok: false, output: String(error), started }));
    child.on('close', (code, signal) => {
      children.delete(child);
      // A step killed without output (e.g. by the OOM killer) still says why it failed.
      if (code !== 0 && !output.trim()) output = `exited with ${signal ?? code}`;
      resolve({ name, ok: code === 0, output, started });
    });
  });
}

function report({ name, ok, output, started }) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name} (${seconds}s)\n`);
  if (!ok) process.stdout.write(`${output.trimEnd()}\n\n`);
  return ok;
}

// Report each step as it finishes rather than waiting for the slowest one.
const passed = await Promise.all(STEPS.map((name) => runStep(name).then(report)));
if (passed.includes(false)) process.exitCode = 1;
