import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CODEX_MODEL_PATTERN,
  isAskCodeEffort,
  type CodexModelChoice,
} from '../shared/ask-code-models.js';
import { warn as logWarn } from '../log.js';

/** The cache is a few hundred kB of model metadata; more means the path is wrong. */
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

function codexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : path.join(os.homedir(), '.codex');
}

/**
 * One cache entry, if it names a model the CLI itself would list. `visibility`
 * is how Codex hides retired and internal models, so entries that are not
 * `list` are dropped rather than offered.
 */
function toChoice(entry: unknown): CodexModelChoice[] {
  if (typeof entry !== 'object' || entry === null) return [];
  const model = entry as Record<string, unknown>;
  if (model.visibility !== 'list') return [];
  const slug = model.slug;
  if (typeof slug !== 'string' || !CODEX_MODEL_PATTERN.test(slug)) return [];
  const displayName = model.display_name;
  const efforts = supportedEfforts(model.supported_reasoning_levels);
  const level = model.default_reasoning_level;
  // A missing or malformed name must not lose the model; the slug reads fine.
  return [
    {
      slug,
      displayName: typeof displayName === 'string' && displayName ? displayName : slug,
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(isAskCodeEffort('codex', level) ? { defaultEffort: level } : {}),
      ...(model.is_default === true ? { isDefault: true as const } : {}),
    },
  ];
}

/**
 * The levels a model lists that the app knows how to pass. Levels the app does
 * not know, such as Codex's delegating `ultra`, are left out rather than guessed at.
 */
function supportedEfforts(levels: unknown): string[] {
  if (!Array.isArray(levels)) return [];
  return levels.flatMap((level: unknown) => {
    const effort = (level as { effort?: unknown } | null)?.effort;
    return isAskCodeEffort('codex', effort) ? [effort] : [];
  });
}

/**
 * The Codex models the CLI knows about, read from the cache it writes itself
 * (`$CODEX_HOME/models_cache.json`), with the one it runs by default marked.
 * A model the config names but the cache does not list leads the list, so the
 * app can still show and pass it.
 */
export function listCodexModels(): CodexModelChoice[] {
  const config = readConfig();
  const effort = configured(config, 'model_reasoning_effort', isCodexEffort);
  // The config's level applies to every model, over each one's own.
  const listed = readCachedModels().map((model) => withEffort(model, effort));
  const configuredModel = configured(config, 'model', (slug) => CODEX_MODEL_PATTERN.test(slug));
  const chosen = configuredModel ?? (listed.find((model) => model.isDefault) ?? listed[0])?.slug;
  const marked = listed.map(
    ({ isDefault: _, ...model }): CodexModelChoice =>
      model.slug === chosen ? { ...model, isDefault: true } : model,
  );
  if (!chosen || marked.some((model) => model.isDefault)) return marked;
  return [withEffort({ slug: chosen, displayName: chosen, isDefault: true }, effort), ...marked];
}

/** An unusable configured level (`''`) drops the cache's: the CLI runs the config's. */
function withEffort(model: CodexModelChoice, effort: string | undefined): CodexModelChoice {
  if (effort === undefined) return model;
  const { defaultEffort: _, ...rest } = model;
  return effort ? { ...rest, defaultEffort: effort } : rest;
}

/**
 * The model Codex runs when none is named: the config's, else the cache's
 * default, else its first. Empty when that is unknown or not one the app can
 * pass, and then the CLI is left to choose.
 */
export function defaultCodexModel(models = listCodexModels()): string {
  return models.find((model) => model.isDefault)?.slug ?? '';
}

/**
 * The level Codex runs a model at when none is named: the config's
 * `model_reasoning_effort`, else the model's own level from the cache. Empty
 * when neither names one the app can pass, and then the CLI is left to choose.
 */
export function defaultCodexEffort(model: string, models = listCodexModels()): string {
  const listed = models.find((choice) => choice.slug === model);
  if (listed) return listed.defaultEffort ?? '';
  return configured(readConfig(), 'model_reasoning_effort', isCodexEffort) ?? '';
}

function isCodexEffort(level: string): boolean {
  return isAskCodeEffort('codex', level);
}

/**
 * A config value as the CLI reads it, the active profile's over the top level.
 * Undefined when unset; empty when set to something the app cannot pass, so
 * the caller names nothing rather than a value the CLI would not run.
 */
function configured(
  text: string,
  key: 'model' | 'model_reasoning_effort',
  valid: (value: string) => boolean,
): string | undefined {
  const topLevel = text.split(/^\s*\[/m)[0] ?? '';
  const profile = tomlString(topLevel, 'profile');
  const value =
    (profile && tomlString(profileTable(text, profile), key)) || tomlString(topLevel, key);
  if (!value) return undefined;
  return valid(value) ? value : '';
}

/** The body of `[profiles.<name>]`, up to the next table. */
function profileTable(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(`^\\s*\\[profiles\\.(?:"${escaped}"|${escaped})\\]\\s*$`, 'm');
  const match = header.exec(text);
  if (!match) return '';
  return text.slice(match.index + match[0].length).split(/^\s*\[/m)[0] ?? '';
}

/** shortcut: line match, not a TOML parser — enough for quoted string keys. */
function tomlString(text: string, key: string): string {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]+)["']`, 'm').exec(text)?.[1] ?? '';
}

function readConfig(): string {
  try {
    return fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8');
  } catch (error) {
    // No config is the usual case; the cache then names the default.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logWarn('codexModels', 'Could not read the Codex config', { error: String(error) });
    }
    return '';
  }
}

/**
 * The cache's listed models. An unreadable or unparsable cache is not an error
 * the user can act on here, so it yields an empty list and a warning.
 */
function readCachedModels(): CodexModelChoice[] {
  const file = path.join(codexHome(), 'models_cache.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (stat.size > MAX_CACHE_BYTES) throw new Error(`too large (${stat.size} bytes)`);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) throw new Error('no models array');
    // The CLI ranks models by priority; the file's order is not a promise.
    return [...models].sort((a, b) => priority(a) - priority(b)).flatMap(toChoice);
  } catch (error) {
    logWarn('codexModels', 'Could not read the Codex model cache', {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function priority(entry: unknown): number {
  const value = (entry as { priority?: unknown } | null)?.priority;
  return typeof value === 'number' ? value : Number.POSITIVE_INFINITY;
}
