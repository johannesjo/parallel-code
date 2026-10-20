#!/usr/bin/env node
/* global console, process */
// Edit screen recordings into a showcase video with ffmpeg.
// Usage: node scripts/showcase/edit.mjs <timeline.json>
// See scripts/showcase/README.md for the timeline format.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
// 0.4 s dissolves read as transitions; 0.2 s flashed like glitches between layouts.
const TRANSITION = 0.4;
const FADE_IN = 0.4;
const FADE_OUT = 0.6;
const CUE_FADE = 0.3;
const SCRIM_HEIGHT = 340;
const DEFAULT_FONTS = {
  regular: '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
  bold: '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
};

function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`);
}

/** Quote a path for an ffmpeg filter option; a single quote cannot be escaped there. */
function filterPath(path) {
  if (path.includes("'")) throw new Error(`Path cannot contain a single quote: ${path}`);
  return `'${path}'`;
}

const overlapAfter = (clip) => clip.transitionAfter ?? TRANSITION;
const optionalNumber = (value) => value === undefined || Number.isFinite(value);

/** Fail before rendering: a bad camera value otherwise surfaces only in the final encode. */
function validateCamera(camera, index) {
  const settings = [camera.startZoom, camera.clockOffset, camera.focusX, camera.focusY];
  if (!settings.every(optionalNumber) || (camera.startZoom ?? 1) < 1) {
    throw new Error(`Clip ${index} camera settings must be numbers, with startZoom >= 1`);
  }
  let zoom = camera.startZoom ?? 1;
  for (const move of camera.moves ?? []) {
    const valid =
      Number.isFinite(move.at) &&
      move.seconds > 0 &&
      move.zoom >= 1 &&
      optionalNumber(move.focusX) &&
      optionalNumber(move.focusY);
    if (!valid) throw new Error(`Clip ${index} camera moves need at, seconds > 0 and zoom >= 1`);
    // At zoom 1 zoompan does not crop, so only there is a focus switch invisible.
    const switchesFocus = move.focusX !== undefined || move.focusY !== undefined;
    if (switchesFocus && zoom !== 1) {
      throw new Error(`Clip ${index} camera can change focus only on a move from zoom 1`);
    }
    zoom = move.zoom;
  }
}

function validateClip(clip, index, clips) {
  const valid =
    typeof clip.file === 'string' &&
    Number.isFinite(clip.start) &&
    clip.start >= 0 &&
    Number.isFinite(clip.duration) &&
    (clip.transitionAfter === undefined || clip.transitionAfter >= 0);
  if (!valid) {
    throw new Error(`Clip ${index} needs file, start >= 0, duration and transitionAfter >= 0`);
  }
  // xfade needs each clip to outlast its incoming and outgoing dissolves.
  const incoming = index > 0 ? overlapAfter(clips[index - 1]) : 0;
  const outgoing = index < clips.length - 1 ? overlapAfter(clip) : 0;
  if (clip.duration <= incoming + outgoing) {
    throw new Error(`Clip ${index} must be longer than its ${incoming + outgoing} s of dissolves`);
  }
  if (clip.camera) validateCamera(clip.camera, index);
}

function loadTimeline(path) {
  const timeline = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(timeline.clips) || timeline.clips.length === 0) {
    throw new Error('timeline.clips must be a non-empty array');
  }
  timeline.clips.forEach(validateClip);
  // Relative paths resolve from the timeline file, so a timeline can live beside its footage.
  const base = dirname(resolve(path));
  return {
    clips: timeline.clips,
    cues: timeline.cues ?? [],
    footage: resolve(base, timeline.footage ?? '.'),
    work: resolve(base, timeline.work ?? 'work'),
    output: resolve(base, timeline.output ?? 'showcase.mp4'),
    fonts: { ...DEFAULT_FONTS, ...timeline.fonts },
    posterAt: timeline.posterAt ?? 1,
  };
}

/**
 * Eased zoom keyframes, timed to UI events rather than to the clip length.
 * A move may change the focus only when it starts from zoom 1, where the
 * switch is invisible. The 2x upscale halves zoompan's pixel jitter.
 */
function cameraFilters(camera) {
  const clock = `(on/${FPS}+${camera.clockOffset ?? 0})`;
  let previousZoom = camera.startZoom ?? 1;
  let zoom = String(previousZoom);
  let focusX = String(camera.focusX ?? 0.5);
  let focusY = String(camera.focusY ?? 0.5);
  for (const move of camera.moves ?? []) {
    const ease = `(1-cos(PI*min(max((${clock}-${move.at})/${move.seconds},0),1)))/2`;
    zoom += `+(${move.zoom - previousZoom})*${ease}`;
    previousZoom = move.zoom;
    if (move.focusX !== undefined) focusX = `if(gte(${clock},${move.at}),${move.focusX},${focusX})`;
    if (move.focusY !== undefined) focusY = `if(gte(${clock},${move.at}),${move.focusY},${focusY})`;
  }
  return [
    `scale=${WIDTH * 2}:${HEIGHT * 2}:flags=lanczos`,
    `zoompan=z='${zoom}':x='(iw-iw/zoom)*${focusX}':y='(ih-ih/zoom)*${focusY}':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
  ];
}

/** Render one clip, reusing an earlier render while its settings and source are unchanged. */
function renderClip(timeline, clip) {
  const source = resolve(timeline.footage, clip.file);
  const { mtimeMs, size } = statSync(source);
  const key = createHash('sha256')
    .update(JSON.stringify([clip.file, mtimeMs, size, clip.start, clip.duration, clip.camera]))
    .digest('hex')
    .slice(0, 16);
  const path = resolve(timeline.work, `clip-${key}.mp4`);
  if (existsSync(path)) return path;
  const filters = [
    'setpts=PTS-STARTPTS',
    `fps=${FPS}`,
    ...(clip.camera ? cameraFilters(clip.camera) : [`scale=${WIDTH}:${HEIGHT}:flags=lanczos`]),
    'setsar=1',
    'format=yuv420p',
  ];
  const partial = `${path}.partial.mp4`;
  ffmpeg([
    ...['-ss', String(clip.start), '-i', source, '-t', String(clip.duration)],
    ...['-vf', filters.join(','), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18'],
    ...['-pix_fmt', 'yuv420p', partial],
  ]);
  // Rename only after success, so an interrupted render is never reused.
  renameSync(partial, path);
  return path;
}

function clipStarts(clips) {
  const starts = [];
  let elapsed = 0;
  for (const [i, clip] of clips.entries()) {
    starts.push(elapsed);
    elapsed += clip.duration - (i < clips.length - 1 ? overlapAfter(clip) : 0);
  }
  // Cue anchors may name clips.length to mean the end of the video.
  return [...starts, elapsed];
}

/** Resolve `[clipIndex, offsetSeconds]` cue anchors to absolute times. */
function resolveCues(cues, starts) {
  const time = (anchor, label) => {
    const [clip, offset] = Array.isArray(anchor) ? anchor : [];
    if (starts[clip] === undefined || !Number.isFinite(offset)) {
      throw new Error(`Cue "${label}" needs at/until anchors like [clipIndex, offsetSeconds]`);
    }
    return starts[clip] + offset;
  };
  return cues.map((cue) => {
    const start = time(cue.at, cue.title);
    const end = time(cue.until, cue.title);
    // Otherwise the caption's fade window is empty and it silently never shows.
    if (end <= start) throw new Error(`Cue "${cue.title}" must end after it starts`);
    return { ...cue, start, end };
  });
}

function transitionGraph(clips, starts) {
  const graph = clips.map((_, i) => `[${i}:v]settb=AVTB,setpts=PTS-STARTPTS[v${i}]`);
  let previous = 'v0';
  for (let i = 1; i < clips.length; i++) {
    const overlap = overlapAfter(clips[i - 1]);
    graph.push(
      overlap === 0
        ? `[${previous}][v${i}]concat=n=2:v=1:a=0,fps=${FPS},settb=AVTB[mix${i}]`
        : `[${previous}][v${i}]xfade=transition=fade:duration=${overlap}:offset=${starts[i].toFixed(6)}[mix${i}]`,
    );
    previous = `mix${i}`;
  }
  return { graph, previous };
}

const cueAlpha = (cue, time) =>
  `max(0,min(1,min((${time}-${cue.start})/${CUE_FADE},(${cue.end}-${time})/${CUE_FADE})))`;

/**
 * A soft bottom-left gradient fades with the captions, so they stay legible
 * over busy UI without a heavy outline. It is computed at quarter size and
 * scaled up: the gradient is smooth, and full-size geq is about 7x slower.
 */
function scrimGraph(cues, duration, input) {
  if (cues.length === 0) return { graph: [], previous: input };
  const alpha = cues.map((cue) => cueAlpha(cue, 'T')).reduce((a, b) => `max(${a},${b})`);
  return {
    graph: [
      `color=c=black:s=${WIDTH / 4}x${SCRIM_HEIGHT / 4}:r=${FPS}:d=${duration.toFixed(6)},format=rgba,` +
        `geq=r=0:g=0:b=0:a='255*0.78*pow(Y/H,1.6)*(1-0.6*X/W)*${alpha}',` +
        `scale=${WIDTH}:${SCRIM_HEIGHT}:flags=bicubic[scrim]`,
      `[${input}][scrim]overlay=0:${HEIGHT - SCRIM_HEIGHT}:eof_action=pass[scrimmed]`,
    ],
    previous: 'scrimmed',
  };
}

function captionFilters(timeline, cues) {
  const filters = [];
  for (const [i, cue] of cues.entries()) {
    const lines = [
      ['title', cue.title, cue.sub ? 50 : 46, cue.sub ? 912 : 966, timeline.fonts.bold, 'white'],
      ['sub', cue.sub, 27, 984, timeline.fonts.regular, 'white@0.85'],
    ];
    for (const [name, text, size, y, font, color] of lines) {
      if (!text) continue;
      // textfile avoids escaping caption punctuation inside the filter graph;
      // expansion=none keeps a literal % from being read as a placeholder.
      const path = resolve(timeline.work, `cue-${i}-${name}.txt`);
      writeFileSync(path, text);
      filters.push(
        `drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(path)}:expansion=none` +
          `:fontsize=${size}:fontcolor=${color}` +
          `:x=64:y=${y}:shadowcolor=black@0.5:shadowx=0:shadowy=2:alpha='${cueAlpha(cue, 't')}'`,
      );
    }
  }
  return filters;
}

function buildGraph(timeline, starts, cues) {
  const duration = starts[timeline.clips.length];
  const transitions = transitionGraph(timeline.clips, starts);
  const scrim = scrimGraph(cues, duration, transitions.previous);
  const finish = [
    ...captionFilters(timeline, cues),
    `fade=t=in:st=0:d=${FADE_IN}`,
    `fade=t=out:st=${(duration - FADE_OUT).toFixed(6)}:d=${FADE_OUT}`,
    `fps=${FPS}`,
    `setpts=N/(${FPS}*TB)`,
    'format=yuv420p',
  ];
  return [...transitions.graph, ...scrim.graph, `[${scrim.previous}]${finish.join(',')}[video]`];
}

/** One final encode gives a single continuous constant-frame-rate timeline. */
function encode(timeline, clipPaths, duration) {
  ffmpeg([
    ...clipPaths.flatMap((path) => ['-i', path]),
    ...[
      '-filter_complex_threads',
      '1',
      '-filter_complex_script',
      resolve(timeline.work, 'filter.txt'),
    ],
    ...['-map', '[video]', '-an', '-sn', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18'],
    ...[
      '-profile:v',
      'high',
      '-level:v',
      '4.1',
      '-fps_mode',
      'cfr',
      '-video_track_timescale',
      '90000',
    ],
    ...['-map_metadata', '-1', '-map_chapters', '-1', '-t', duration.toFixed(6)],
    ...['-movflags', '+faststart', timeline.output],
  ]);
}

function writePoster(timeline) {
  const poster = timeline.output.replace(/\.[^./]+$/, '') + '.jpg';
  ffmpeg([
    ...['-ss', String(timeline.posterAt), '-i', timeline.output],
    ...['-frames:v', '1', '-update', '1', poster],
  ]);
}

function main() {
  const [timelinePath] = process.argv.slice(2);
  if (!timelinePath) {
    console.error('Usage: node scripts/showcase/edit.mjs <timeline.json>');
    process.exit(1);
  }
  const timeline = loadTimeline(timelinePath);
  mkdirSync(timeline.work, { recursive: true });
  mkdirSync(dirname(timeline.output), { recursive: true });
  const clipPaths = timeline.clips.map((clip, i) => {
    console.log(`Clip ${i + 1}/${timeline.clips.length}: ${clip.file} @ ${clip.start}s`);
    return renderClip(timeline, clip);
  });
  const starts = clipStarts(timeline.clips);
  const cues = resolveCues(timeline.cues, starts);
  writeFileSync(
    resolve(timeline.work, 'filter.txt'),
    buildGraph(timeline, starts, cues).join(';\n'),
  );
  const duration = starts[timeline.clips.length];
  encode(timeline, clipPaths, duration);
  writePoster(timeline);
  console.log(`Finished ${timeline.output}: ${duration.toFixed(1)} s`);
}

main();
