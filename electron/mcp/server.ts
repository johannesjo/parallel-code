#!/usr/bin/env node
// MCP server entry point — standalone Node.js script.
// Speaks MCP over stdio to Claude Code, delegates to the Electron app via HTTP.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { MCPClient } from './client.js';
import { parseMindMapUpdate } from '../shared/mindmap.js';
import { parseReasoningUpdate } from '../shared/reasoning-feed.js';
import { parseCanvasView } from '../shared/canvas-view.js';
import { parseAgentTourPayload } from '../shared/agent-tour.js';
import { parseEvidenceSubmission } from '../shared/evidence.js';
import {
  APP_TASK_INSTRUCTIONS,
  CANVAS_INSTRUCTIONS,
  hasCanvasTools,
  selectTools,
  sessionInstructions,
} from './mcp-tool-list.js';
import { validateBranchName } from './validation.js';
import { formatDiffForTool } from './diff-format.js';
import type { LandSelfInput } from './types.js';
import type { SessionCapabilities, SessionProfile } from '../shared/delegation-types.js';
import { parseSignalDoneInput } from '../shared/completion-report.js';
import { toolOutputSchemas } from './tool-output-schemas.js';

function formatToolResult(name: string, result: unknown, legacyDone = false) {
  if (name === 'signal_done') {
    if (
      !result ||
      typeof result !== 'object' ||
      !('ok' in result) ||
      result.ok !== true ||
      !('completion' in result) ||
      !result.completion
    )
      throw new Error('Completion signal was rejected.');
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: legacyDone
          ? 'Done signal sent. The coordinator has been notified.'
          : JSON.stringify(result, null, 2),
      },
    ],
    ...(name in toolOutputSchemas
      ? {
          structuredContent:
            name === 'list_tasks' ? { tasks: result } : (result as Record<string, unknown>),
        }
      : {}),
  };
}

export interface MCPToolHandlerContext {
  client: MCPClient;
  taskId: string;
  coordinatorId: string;
  canvasOnly?: boolean;
  sessionCapabilities?: SessionCapabilities;
}

export async function handleMCPToolCall(
  { client, taskId, coordinatorId, canvasOnly, sessionCapabilities }: MCPToolHandlerContext,
  name: string,
  params: unknown,
) {
  const canvasTool = [
    'mindmap_read',
    'mindmap_update',
    'reasoning_read',
    'reasoning_update',
    'canvas_open',
    'tour_publish',
    'submit_evidence',
    'get_evidence',
  ].includes(name);
  if (
    sessionCapabilities &&
    !selectTools(taskId, coordinatorId, false, sessionCapabilities).some(
      (tool) => tool.name === name,
    )
  )
    return {
      content: [{ type: 'text', text: `Error: '${name}' is not available to this session.` }],
      isError: true,
    };
  if (!sessionCapabilities && canvasOnly && !canvasTool)
    return {
      content: [{ type: 'text', text: `Error: '${name}' is not available to canvas sessions.` }],
      isError: true,
    };
  if (
    !sessionCapabilities &&
    taskId &&
    !coordinatorId &&
    !canvasTool &&
    !['signal_done', 'land_self'].includes(name)
  )
    return {
      content: [
        {
          type: 'text',
          text: `Error: '${name}' is not available to sub-tasks. Only land_self, signal_done and canvas tools are permitted.`,
        },
      ],
      isError: true,
    };

  try {
    if (sessionCapabilities && !canvasTool) {
      if (params !== undefined && (!params || typeof params !== 'object' || Array.isArray(params)))
        throw new Error('Tool arguments must be an object.');
      const scopedParams: Record<string, unknown> =
        name === 'signal_done'
          ? { ...parseSignalDoneInput(params) }
          : { ...(params as Record<string, unknown> | undefined) };
      if (['wait_for_idle', 'wait_for_signal_done', 'wait_for_agent_prompt'].includes(name)) {
        const timeout = scopedParams.timeoutMs;
        if (
          timeout !== undefined &&
          (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
        )
          throw new Error('timeoutMs must be a positive finite number.');
        scopedParams.timeoutMs = Math.min(typeof timeout === 'number' ? timeout : 30000, 60000);
      }
      const result = await client.callSessionTool(name, scopedParams);
      return formatToolResult(name, result);
    }
    switch (name) {
      case 'reasoning_read':
      case 'reasoning_update': {
        const id = taskId || coordinatorId;
        if (!id) throw new Error('A task-scoped MCP session is required.');
        const result =
          name === 'reasoning_read'
            ? await client.readReasoning(id)
            : await client.updateReasoning(id, parseReasoningUpdate(params));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'canvas_open': {
        const id = taskId || coordinatorId;
        if (!id) throw new Error('A task-scoped MCP session is required.');
        const result = await client.openCanvas(id, parseCanvasView(params));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'tour_publish': {
        const id = taskId || coordinatorId;
        if (!id) throw new Error('A task-scoped MCP session is required.');
        const result = await client.publishTour(id, parseAgentTourPayload(params));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'submit_evidence':
      case 'get_evidence': {
        const id = taskId || coordinatorId;
        if (!id) throw new Error('A task-scoped MCP session is required.');
        const result =
          name === 'get_evidence'
            ? await client.getEvidence(id)
            : await client.submitEvidence(id, parseEvidenceSubmission(params));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'mindmap_read':
      case 'mindmap_update': {
        const id = taskId || coordinatorId;
        if (!id) throw new Error('A task-scoped MCP session is required.');
        const result =
          name === 'mindmap_read'
            ? await client.readMindMap(id)
            : await client.updateMindMap(id, parseMindMapUpdate(params));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'create_task': {
        const p = params as Record<string, unknown>;
        if (typeof p.prompt !== 'string' || !p.prompt.trim()) {
          return {
            content: [{ type: 'text', text: 'Error: prompt must be a non-empty string' }],
            isError: true,
          };
        }
        const rawBranch = p.baseBranch;
        const baseBranch =
          rawBranch !== undefined ? validateBranchName(rawBranch, 'baseBranch') : undefined;
        const result = await client.createTask({
          name: p.name as string,
          prompt: p.prompt,
          coordinatorTaskId: coordinatorId || undefined,
          baseBranch,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'list_tasks': {
        const tasks = await client.listTasks();
        return formatToolResult(name, tasks);
      }

      case 'get_task_status': {
        const result = await client.getTaskStatus(
          (params as Record<string, unknown>).taskId as string,
        );
        return formatToolResult(name, result);
      }

      case 'send_prompt': {
        const p = params as Record<string, unknown>;
        if (typeof p.taskId !== 'string' || !p.taskId.trim()) {
          return {
            content: [{ type: 'text', text: 'Error: taskId must be a non-empty string' }],
            isError: true,
          };
        }
        if (typeof p.prompt !== 'string' || !p.prompt.trim()) {
          return {
            content: [{ type: 'text', text: 'Error: prompt must be a non-empty string' }],
            isError: true,
          };
        }
        const result = await client.sendPrompt(p.taskId, p.prompt);
        return {
          content: [
            {
              type: 'text',
              text: result.queued
                ? 'Prompt queued. It will be sent after the current initial prompt or user hold clears.'
                : 'Prompt sent successfully.',
            },
          ],
        };
      }

      case 'wait_for_idle': {
        const result = await client.waitForIdle(
          (params as Record<string, unknown>).taskId as string,
          (params as Record<string, unknown>).timeoutMs as number | undefined,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_task_diff': {
        const result = await client.getTaskDiff(
          (params as Record<string, unknown>).taskId as string,
        );
        return {
          content: [{ type: 'text', text: formatDiffForTool(result) }],
        };
      }

      case 'get_task_output': {
        const result = await client.getTaskOutput(
          (params as Record<string, unknown>).taskId as string,
        );
        return { content: [{ type: 'text', text: result.output }] };
      }

      case 'merge_task': {
        const p = params as Record<string, unknown>;
        const result = await client.mergeTask(p.taskId as string, {
          squash: p.squash as boolean | undefined,
          message: p.message as string | undefined,
          cleanup: p.cleanup as boolean | undefined,
          skipVerification: p.skipVerification as boolean | undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'close_task': {
        await client.closeTask((params as Record<string, unknown>).taskId as string);
        return { content: [{ type: 'text', text: 'Task closed successfully.' }] };
      }

      case 'wait_for_signal_done': {
        if (!coordinatorId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: wait_for_signal_done is only available to coordinators (no --coordinator-id configured).',
              },
            ],
            isError: true,
          };
        }
        const result = await client.waitForSignalDone(
          coordinatorId,
          (params as Record<string, unknown>).timeoutMs as number | undefined,
        );
        return formatToolResult(name, result);
      }

      case 'review_and_merge_task': {
        const p = params as Record<string, unknown>;
        const result = await client.reviewAndMergeTask(p.taskId as string, {
          squash: p.squash as boolean | undefined,
          message: p.message as string | undefined,
        });
        const mergeInfo = `Merged into ${result.merge.mainBranch}: +${result.merge.linesAdded} -${result.merge.linesRemoved} lines`;
        return {
          content: [
            {
              type: 'text',
              text: formatDiffForTool(result.diff, mergeInfo),
            },
          ],
        };
      }

      case 'signal_done': {
        if (!taskId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: signal_done is only available to sub-tasks (no --task-id configured).',
              },
            ],
            isError: true,
          };
        }
        const result = await client.signalDone(taskId, parseSignalDoneInput(params));
        return formatToolResult(name, result, true);
      }

      case 'land_self': {
        if (!taskId) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: land_self is only available to sub-tasks (no --task-id configured).',
              },
            ],
            isError: true,
          };
        }
        const result = await client.landSelf(taskId, params as unknown as LandSelfInput);
        return formatToolResult(name, result);
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        { type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
}

export function parseArgs(argv: string[]): {
  url: string;
  taskId: string;
  coordinatorId: string;
  canvasOnly: boolean;
  tokenFile: string;
  sessionCapabilities?: SessionCapabilities;
} {
  let profile: SessionProfile | undefined;
  let canCreate = false;
  let peers = false;
  let canvasOnly = false;
  let url = '';
  let tokenFile = ''; // set for Codex: its inline config cannot carry the token privately
  let taskId = ''; // set for sub-tasks: enables signal_done
  let coordinatorId = ''; // set for coordinator: sent as coordinatorTaskId in create_task
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session-profile') {
      const value = argv[++i];
      if (value !== 'ordinary' && value !== 'child-review' && value !== 'child-automatic')
        throw new Error('Invalid --session-profile.');
      profile = value;
    } else if (argv[i] === '--allow-create') {
      canCreate = true;
    } else if (argv[i] === '--peer-tools') {
      peers = true;
    } else if (argv[i] === '--canvas-only') {
      canvasOnly = true;
    } else if (argv[i] === '--url' && argv[i + 1]) {
      url = argv[++i];
    } else if (argv[i] === '--task-id' && argv[i + 1]) {
      taskId = argv[++i];
    } else if (argv[i] === '--coordinator-id' && argv[i + 1]) {
      coordinatorId = argv[++i];
    } else if (argv[i] === '--token-file' && argv[i + 1]) {
      tokenFile = argv[++i];
    }
  }
  if (profile && (!taskId || coordinatorId || canvasOnly))
    throw new Error(
      'Session profiles require --task-id and cannot use coordinator or canvas-only mode.',
    );
  if (!profile && (canCreate || peers))
    throw new Error('Session capability flags require --session-profile.');
  return {
    url,
    taskId,
    coordinatorId,
    canvasOnly,
    tokenFile,
    ...(profile ? { sessionCapabilities: { profile, canCreate, peers } } : {}),
  };
}

/** The token file is the app-written 0600 MCP config; an unreadable file yields no token. */
export function readTokenFile(file: string): string {
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: { 'parallel-code'?: { env?: { PARALLEL_CODE_MCP_TOKEN?: unknown } } };
    };
    const token = config?.mcpServers?.['parallel-code']?.env?.PARALLEL_CODE_MCP_TOKEN;
    if (typeof token === 'string') return token;
    console.error(`MCP token file ${file} has no PARALLEL_CODE_MCP_TOKEN entry.`);
    return '';
  } catch (error) {
    // The caller only sees the generic usage error; name the real cause here.
    console.error(`Could not read MCP token file ${file}:`, error);
    return '';
  }
}

async function main(): Promise<void> {
  const { url, taskId, coordinatorId, canvasOnly, tokenFile, sessionCapabilities } = parseArgs(
    process.argv.slice(2),
  );
  const token = tokenFile ? readTokenFile(tokenFile) : (process.env.PARALLEL_CODE_MCP_TOKEN ?? '');
  const doneToken = process.env.PARALLEL_CODE_MCP_DONE_TOKEN || undefined;

  if (!url || !token) {
    console.error(
      'Usage: node server.js --url <remote-server-url> [--task-id <taskId>] [--coordinator-id <coordinatorId>]\n' +
        'Token must be set via PARALLEL_CODE_MCP_TOKEN or --token-file <mcp-config.json>.',
    );
    process.exit(1);
  }

  // Reject coordinator/task IDs that contain HTTP header-unsafe characters.
  // These values are forwarded as X-Coordinator-Id / X-Task-Id headers; a newline
  // would allow header injection into every outgoing request.
  if (coordinatorId && /[\r\n]/.test(coordinatorId)) {
    console.error('Invalid --coordinator-id: must not contain newline characters.');
    process.exit(1);
  }
  if (taskId && /[\r\n]/.test(taskId)) {
    console.error('Invalid --task-id: must not contain newline characters.');
    process.exit(1);
  }

  const client = new MCPClient(url, token, coordinatorId || undefined, doneToken);
  const server = new Server(
    { name: 'parallel-code', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        [
          APP_TASK_INSTRUCTIONS,
          ...(hasCanvasTools(taskId, coordinatorId, canvasOnly) ? [CANVAS_INSTRUCTIONS] : []),
          ...(sessionCapabilities ? [sessionInstructions(sessionCapabilities)] : []),
        ].join('\n\n') || undefined,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: selectTools(taskId, coordinatorId, canvasOnly, sessionCapabilities) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: params } = request.params;
    return handleMCPToolCall(
      { client, taskId, coordinatorId, canvasOnly, sessionCapabilities },
      name,
      params,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error('MCP server failed to start:', err);
    process.exit(1);
  });
}
