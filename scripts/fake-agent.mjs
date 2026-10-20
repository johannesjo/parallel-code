#!/usr/bin/env node
/* global process, setInterval, setTimeout */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
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

function replayTranscript() {
  write(readFileSync(transcriptPath, 'utf8').replace(/\r?\n/g, '\r\n'));
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
