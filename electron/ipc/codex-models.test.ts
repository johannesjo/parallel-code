import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ warn: vi.fn() }));

import { defaultCodexEffort, defaultCodexModel, listCodexModels } from './codex-models.js';

let home: string;
const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-models-'));
  process.env.CODEX_HOME = home;
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeCache(contents: unknown): void {
  fs.writeFileSync(
    path.join(home, 'models_cache.json'),
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  );
}

describe('listCodexModels', () => {
  it('keeps the listed models in cache order and drops hidden ones', () => {
    writeCache({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
      ],
    });

    expect(listCodexModels()).toEqual([
      { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true },
      { slug: 'gpt-5.5', displayName: 'GPT-5.5' },
    ]);
  });

  it('drops entries whose slug could not be a CLI argument and names the rest by slug', () => {
    writeCache({
      models: [
        { slug: '-- rm -rf', display_name: 'Injected', visibility: 'list' },
        { slug: 'GPT-Upper', display_name: 'Upper case', visibility: 'list' },
        { slug: 42, display_name: 'Not a string', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        'not an object',
      ],
    });

    expect(listCodexModels()).toEqual([
      { slug: 'gpt-5.5', displayName: 'gpt-5.5', isDefault: true },
    ]);
  });

  it('keeps the reasoning levels a model lists that the app can pass to the CLI', () => {
    writeCache({
      models: [
        {
          slug: 'gpt-6-sol',
          display_name: 'GPT-6-Sol',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'ultra' },
            { effort: '"; rm' },
            'max',
            { effort: 'max' },
          ],
        },
        { slug: 'gpt-5.5', visibility: 'list', supported_reasoning_levels: 'all' },
      ],
    });

    expect(listCodexModels()).toEqual([
      { slug: 'gpt-6-sol', displayName: 'GPT-6-Sol', efforts: ['low', 'max'], isDefault: true },
      { slug: 'gpt-5.5', displayName: 'gpt-5.5' },
    ]);
  });

  it('returns nothing when the cache is missing, malformed or not a model list', () => {
    expect(listCodexModels()).toEqual([]);

    writeCache('{ not json');
    expect(listCodexModels()).toEqual([]);

    writeCache({ models: 'all of them' });
    expect(listCodexModels()).toEqual([]);

    writeCache(null);
    expect(listCodexModels()).toEqual([]);
  });
});

describe('defaultCodexModel', () => {
  const listed = {
    models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
      { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list' },
    ],
  };
  const writeConfig = (text: string) => fs.writeFileSync(path.join(home, 'config.toml'), text);

  it("takes the model the CLI's own config names, as the CLI would", () => {
    writeCache(listed);
    writeConfig(
      'approval_policy = "never"\nmodel = "gpt-6-sol"\n\n[profiles.fast]\nmodel = "gpt-6-astra"\n',
    );

    expect(defaultCodexModel()).toBe('gpt-6-sol');
    expect(listCodexModels().filter((model) => model.isDefault)).toEqual([
      { slug: 'gpt-6-sol', displayName: 'GPT-6-Sol', isDefault: true },
    ]);
  });

  it('offers a configured model the cache does not list, by its slug', () => {
    writeCache(listed);
    writeConfig("model = 'gpt-7'\n");

    expect(listCodexModels()[0]).toEqual({ slug: 'gpt-7', displayName: 'gpt-7', isDefault: true });
  });

  it('falls back to the first listed model without a top-level model', () => {
    writeCache(listed);
    writeConfig('[profiles.fast]\nmodel = "gpt-6-sol"\n');
    expect(defaultCodexModel()).toBe('gpt-6-astra');

    // One the app cannot pass is the CLI's to resolve, not a cue to name another.
    writeConfig('model = "-- rm"\n');
    expect(defaultCodexModel()).toBe('');
  });

  it('has none when the CLI has neither config nor cache', () => {
    expect(defaultCodexModel()).toBe('');
  });
});

describe('defaultCodexEffort', () => {
  const listed = {
    models: [
      { slug: 'gpt-6-astra', visibility: 'list', default_reasoning_level: 'medium' },
      { slug: 'gpt-6-sol', visibility: 'list', default_reasoning_level: 'ultra' },
    ],
  };
  const writeConfig = (text: string) => fs.writeFileSync(path.join(home, 'config.toml'), text);

  it("takes each model's own level from the cache, where the app can pass it", () => {
    writeCache(listed);
    expect(listCodexModels().map((model) => model.defaultEffort)).toEqual(['medium', undefined]);
    expect(defaultCodexEffort('gpt-6-astra')).toBe('medium');
    expect(defaultCodexEffort('gpt-6-sol')).toBe('');
  });

  it("lets the CLI's own config override every model's level, as the CLI does", () => {
    writeCache(listed);
    writeConfig('model_reasoning_effort = "high"\n[profiles.x]\nmodel_reasoning_effort = "low"\n');
    expect(listCodexModels().map((model) => model.defaultEffort)).toEqual(['high', 'high']);
    expect(defaultCodexEffort('gpt-7')).toBe('high');
  });
});

describe('the default Codex runs', () => {
  const writeConfig = (text: string) => fs.writeFileSync(path.join(home, 'config.toml'), text);

  it("takes the cache's own default, else its highest priority, over list order", () => {
    writeCache({
      models: [
        { slug: 'gpt-6-luna', visibility: 'list', priority: 4 },
        { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
      ],
    });
    expect(defaultCodexModel()).toBe('gpt-6-astra');
    expect(listCodexModels().map((model) => model.slug)).toEqual(['gpt-6-astra', 'gpt-6-luna']);

    writeCache({
      models: [
        { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
        { slug: 'gpt-6-luna', visibility: 'list', priority: 4, is_default: true },
      ],
    });
    expect(defaultCodexModel()).toBe('gpt-6-luna');
  });

  it("follows the config's active profile, as the CLI does", () => {
    writeCache({ models: [{ slug: 'gpt-6-astra', visibility: 'list' }] });
    writeConfig(
      'profile = "fast"\nmodel = "gpt-6-sol"\nmodel_reasoning_effort = "high"\n' +
        '[profiles.slow]\nmodel = "gpt-6-luna"\n[profiles.fast]\nmodel = "gpt-7"\n',
    );
    expect(defaultCodexModel()).toBe('gpt-7');
    // The profile sets no level, so the top-level one still applies.
    expect(defaultCodexEffort('gpt-7')).toBe('high');
  });

  it('leaves the CLI to choose when the config names what the app cannot pass', () => {
    writeCache({
      models: [{ slug: 'gpt-6-astra', visibility: 'list', default_reasoning_level: 'low' }],
    });
    writeConfig('model = "Odd Model"\nmodel_reasoning_effort = "ultra"\n');
    expect(defaultCodexModel()).toBe('');
    expect(listCodexModels().some((model) => model.isDefault)).toBe(false);
    expect(defaultCodexEffort('gpt-6-astra')).toBe('');
  });
});
