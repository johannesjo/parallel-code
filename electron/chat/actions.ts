import { assertOptionalString, assertString } from '../ipc/validate.js';
import { isChatDecision, validateChatImages } from '../shared/agent-chat-types.js';
import type { AgentChat } from './types.js';

/**
 * Validate and run one conversation action. Shared by the desktop IPC handler
 * and paired phones, so both accept exactly the same input.
 */
export function runChatAction(chat: AgentChat, args: Record<string, unknown>): unknown {
  if (args.action === 'models') return chat.loadModels();
  if (args.action === 'selectModel') {
    assertString(args.model, 'model');
    assertOptionalString(args.reasoningEffort, 'reasoningEffort');
    return chat.selectModel(args.model, args.reasoningEffort);
  }
  if (args.action === 'send') {
    assertString(args.text, 'text');
    if (!args.text.trim() || args.text.length > 100_000)
      throw new Error('Enter a message of at most 100,000 characters.');
    return chat.send(args.text, validateChatImages(args.images));
  }
  if (args.action === 'interrupt') return chat.interrupt();
  if (args.action === 'respond') return respond(chat, args);
  throw new Error('Unknown agent chat action.');
}

function respond(chat: AgentChat, args: Record<string, unknown>): void {
  if (typeof args.requestId !== 'string' && typeof args.requestId !== 'number')
    throw new Error('Invalid request ID.');
  if (!isChatDecision(args.decision)) throw new Error('Invalid approval decision.');
  let answers: Record<string, string> | undefined;
  if (args.answers !== undefined) {
    if (!args.answers || typeof args.answers !== 'object' || Array.isArray(args.answers))
      throw new Error('Invalid answers.');
    answers = {};
    for (const [key, value] of Object.entries(args.answers)) {
      assertString(value, 'answer');
      answers[key] = value;
    }
  }
  chat.respond(args.requestId, args.decision, answers);
}
