#!/usr/bin/env node
// MCP server entry point — standalone Node.js script.
// Speaks MCP over stdio to Claude Code, delegates to the Electron app via HTTP.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPClient } from './client.js';
import { selectTools } from './mcp-tool-list.js';
import { validateBranchName } from './validation.js';
import { formatDiffForTool } from './diff-format.js';
import type { LandSelfInput } from './types.js';

export interface MCPToolHandlerContext {
  client: MCPClient;
  taskId: string;
  coordinatorId: string;
}

export async function handleMCPToolCall(
  { client, taskId, coordinatorId }: MCPToolHandlerContext,
  name: string,
  params: unknown,
) {
  // Sub-tasks may only call sub-task scoped terminal tools.
  if (taskId && !coordinatorId && name !== 'signal_done' && name !== 'land_self') {
    return {
      content: [
        {
          type: 'text',
          text: `Error: '${name}' is not available to sub-tasks. Only land_self and signal_done are permitted.`,
        },
      ],
      isError: true,
    };
  }

  try {
    switch (name) {
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
        return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
      }

      case 'get_task_status': {
        const result = await client.getTaskStatus(
          (params as Record<string, unknown>).taskId as string,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
        await client.signalDone(taskId);
        return {
          content: [{ type: 'text', text: 'Done signal sent. The coordinator has been notified.' }],
        };
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
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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

function parseArgs(argv: string[]): { url: string; taskId: string; coordinatorId: string } {
  let url = '';
  let taskId = ''; // set for sub-tasks: enables signal_done
  let coordinatorId = ''; // set for coordinator: sent as coordinatorTaskId in create_task
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) {
      url = argv[++i];
    } else if (argv[i] === '--task-id' && argv[i + 1]) {
      taskId = argv[++i];
    } else if (argv[i] === '--coordinator-id' && argv[i + 1]) {
      coordinatorId = argv[++i];
    }
  }
  return { url, taskId, coordinatorId };
}

async function main(): Promise<void> {
  const { url, taskId, coordinatorId } = parseArgs(process.argv.slice(2));
  const token = process.env.PARALLEL_CODE_MCP_TOKEN ?? '';
  const doneToken = process.env.PARALLEL_CODE_MCP_DONE_TOKEN || undefined;

  if (!url || !token) {
    console.error(
      'Usage: node server.js --url <remote-server-url> [--task-id <taskId>] [--coordinator-id <coordinatorId>]\n' +
        'Token must be set via PARALLEL_CODE_MCP_TOKEN environment variable.',
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
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: selectTools(taskId, coordinatorId) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: params } = request.params;
    return handleMCPToolCall({ client, taskId, coordinatorId }, name, params);
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
