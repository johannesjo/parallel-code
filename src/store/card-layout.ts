import { BRIEF_MODELS } from '../../electron/shared/task-name-model';
import { buildLayoutPrompt, parseLayoutResponse } from '../lib/card-layout';
import type { CardDefinition } from '../lib/cards';
import { startModelRequest } from '../lib/model-request';
import { getProjectChecks } from './check-suite-state';
import { store } from './core';

/** Every project's checks, one per id: a card names a check by id and runs the one its task's project has. */
export function allProjectChecks() {
  const byId = new Map(
    store.projects.flatMap((project) => getProjectChecks(project.id)).map((c) => [c.id, c]),
  );
  return [...byId.values()];
}

/**
 * Drafts a card from the user's description with one call to the default AI
 * model. Sends only the description and the check names, never task content.
 */
export async function draftCard(description: string): Promise<CardDefinition> {
  const text = description.trim();
  if (!text) throw new Error('Describe the card first.');
  // The CLI needs a working directory; no task is involved, so any project will do.
  const cwd = store.projects[0]?.path;
  if (!cwd) throw new Error('Add a project first.');
  const checks = allProjectChecks();
  const response = await startModelRequest({
    prompt: buildLayoutPrompt(text, checks),
    cwd,
    settings: BRIEF_MODELS[store.briefModel],
    agentEnvFiles: store.agentEnvFiles,
    projectId: undefined,
    purpose: 'card-layout',
  }).result;
  return parseLayoutResponse(response, {
    description: text,
    checks,
    taken: new Set(store.cardDefinitions.map((card) => card.id)),
  });
}
