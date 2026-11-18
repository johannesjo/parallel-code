#!/usr/bin/env node
/* global process, setInterval, setTimeout */

import { Buffer } from 'node:buffer';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const profile = argValue('--profile', 'codex');
const capturePath = argValue('--capture');
const transientReady = process.argv.includes('--transient-ready');
const minEnterDelayMs = Number(argValue('--min-enter-delay-ms', '0'));
const bracketedPaste = process.argv.includes('--bracketed-paste');
// Showcase recordings: print a canned session instead of the test banner.
const transcriptPath = argValue('--transcript');
const busyLabel = argValue('--busy');
// Reliability benchmark: steady output of this many bytes per second, like a
// busy agent printing build and test logs.
const floodBytesPerSecond = Number(argValue('--flood', '0'));

function write(text) {
  process.stdout.write(text);
}

function capture(payload) {
  if (!capturePath) return;
  const safeCapturePath = resolve(capturePath);
  if (!safeCapturePath.includes(`${sep}.captures${sep}`)) {
    throw new Error('--capture must point inside a .captures fixture directory');
  }
  mkdirSync(dirname(safeCapturePath), { recursive: true });
  appendFileSync(safeCapturePath, `${JSON.stringify({ profile, payload, at: Date.now() })}\n`);
}

function prompt() {
  if (bracketedPaste) write('\x1b[?2004h');
  if (profile === 'codex') {
    write('gpt-5 default  ~/fake-worktree\n› ');
    return;
  }
  write(`${profile} ready\n❯ `);
}

function settledPrompt() {
  write(`\r\n${'ready '.repeat(70)}\r\n`);
  prompt();
}

function transientPromptRedraw() {
  write(`\r\n${'ready '.repeat(70)}\r\n`);
  prompt();
  setTimeout(() => {
    write(`\r\n${`${profile} redraw `.repeat(500)}\r\n`);
  }, 250);
}

const FLOOD_TICK_MS = 50;

function flood() {
  const perTick = Math.max(1, Math.round((floodBytesPerSecond * FLOOD_TICK_MS) / 1000));
  let line = 0;
  let written = 0;
  // Bytes still owed: a tick's last line overshoots, and the next tick pays it back.
  let budget = 0;
  setInterval(() => {
    let chunk = '';
    budget += perTick;
    while (budget > 0) {
      line++;
      const text = `\x1b[2m${new Date().toISOString()}\x1b[0m \x1b[32m✓\x1b[0m test ${line} passed in ${line % 97} ms\r\n`;
      chunk += text;
      budget -= Buffer.byteLength(text);
    }
    // Terminal writes block while the app holds the PTY paused (its flow
    // control), so the count is what the app actually took in.
    write(chunk);
    written += Buffer.byteLength(chunk);
  }, FLOOD_TICK_MS);
  // Temp file and rename, so the benchmark never reads a half-written count.
  setInterval(() => {
    writeFileSync(`${transcriptPath}.written.tmp`, String(written));
    renameSync(`${transcriptPath}.written.tmp`, `${transcriptPath}.written`);
  }, 1000);
}

function replayTranscript() {
  write(readFileSync(transcriptPath, 'utf8').replace(/\r?\n/g, '\r\n'));
  if (floodBytesPerSecond > 0) {
    flood();
    return;
  }
  if (!busyLabel) return;
  const frames = ['·', '✢', '✳', '✶', '✻', '✽'];
  let frame = 0;
  // Steady output keeps the app reading the agent as working; silence turns idle.
  setInterval(() => {
    write(`\r\x1b[2K\x1b[33m${frames[frame++ % frames.length]}\x1b[0m ${busyLabel}`);
  }, 150);
}

function boot() {
  if (transcriptPath) {
    replayTranscript();
    return;
  }

  if (profile === 'codex') {
    write('>_ OpenAI Codex (fake)\r\n› Explain this codebase\r\n');
    setTimeout(transientReady ? transientPromptRedraw : prompt, 100);
    return;
  }

  if (profile === 'claude') {
    write('Claude Code (fake)\r\nDo you trust the files in this folder?\r\n❯ Yes  No\r\n');
    setTimeout(() => {
      write('\r\nTrust accepted by fake harness\r\n');
      if (transientReady) {
        transientPromptRedraw();
      } else {
        settledPrompt();
      }
    }, 120);
    return;
  }

  if (profile === 'gemini') {
    write('Gemini CLI (fake)\r\nStarting MCP servers (0/1): parallel-code\r\n');
    setTimeout(() => {
      write('Starting MCP servers complete\r\n');
      if (transientReady) {
        transientPromptRedraw();
      } else {
        settledPrompt();
      }
    }, 120);
    return;
  }

  if (profile === 'copilot') {
    write('Copilot CLI (fake)\r\nConfirm folder trust\r\n❯ Yes  No\r\n');
    setTimeout(() => {
      write('\r\nInitializing instructions\r\n');
      setTimeout(transientReady ? transientPromptRedraw : settledPrompt, 120);
    }, 120);
    return;
  }

  write(`${profile} fake agent\r\n`);
  setTimeout(transientReady ? transientPromptRedraw : prompt, 100);
}

let inputBuffer = '';
let lastBodyAt = 0;

process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (chunk && !/^\r+$/.test(chunk)) lastBodyAt = Date.now();
  inputBuffer += chunk;
  let submitIdx = inputBuffer.indexOf('\r');
  while (submitIdx >= 0) {
    if (minEnterDelayMs > 0 && Date.now() - lastBodyAt < minEnterDelayMs) {
      inputBuffer = inputBuffer.replace('\r', '');
      submitIdx = inputBuffer.indexOf('\r');
      continue;
    }
    const payload = inputBuffer.slice(0, submitIdx);
    inputBuffer = inputBuffer.slice(submitIdx + 1);
    if (payload.trim()) {
      capture(payload);
      write('\r\nworking...\r\n');
      setTimeout(prompt, 50);
    }
    submitIdx = inputBuffer.indexOf('\r');
  }
});

boot();
