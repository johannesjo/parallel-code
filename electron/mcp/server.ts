#!/usr/bin/env node
// MCP server entry point — standalone Node.js script.
// Speaks MCP over stdio to Claude Code, delegates to the Electron app via HTTP.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCPClient } from './client.js';

// Parse CLI args
const args = process.argv.slice(2);
let url = '';
let token = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) {
    url = args[++i];
  } else if (args[i] === '--token' && args[i + 1]) {
    token = args[++i];
  }
}

if (!url || !token) {
  console.error('Usage: node server.js --url <remote-server-url> --token <auth-token>');
  process.exit(1);
}

const client = new MCPClient(url, token);

const server = new Server(
  { name: 'parallel-code', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// --- Tool definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'create_task',
      description:
        'Create a new task with its own git worktree and AI agent. The agent starts automatically and the prompt is delivered once the agent is ready.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Task name (used for branch name)' },
          prompt: {
            type: 'string',
            description: 'Initial prompt to send to the agent once it finishes starting up.',
          },
          projectId: {
            type: 'string',
            description: 'Project ID (uses default if not specified)',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'list_tasks',
      description: 'List all orchestrated tasks with their current status.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'get_task_status',
      description: 'Get detailed status of a specific task including git info and agent state.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'send_prompt',
      description: "Send a prompt/instruction to a task's AI agent.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          prompt: { type: 'string', description: 'Prompt text to send' },
        },
        required: ['taskId', 'prompt'],
      },
    },
    {
      name: 'wait_for_idle',
      description:
        "Wait until a task's agent becomes idle (sitting at its prompt). Returns when the agent is ready for the next instruction.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          timeoutMs: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 300000 = 5 min)',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'get_task_diff',
      description: "Get the changed files and unified diff for a task's work.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'get_task_output',
      description: "Get recent terminal output from a task's agent (stripped of ANSI codes).",
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'merge_task',
      description: "Merge a task's branch into the main branch.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
          squash: { type: 'boolean', description: 'Squash merge (default: false)' },
          message: { type: 'string', description: 'Custom merge commit message' },
          cleanup: {
            type: 'boolean',
            description: 'Clean up worktree and branch after merge (default: false)',
          },
        },
        required: ['taskId'],
      },
    },
    {
      name: 'close_task',
      description: 'Close and clean up a task — kills the agent, removes worktree and branch.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Task ID' },
        },
        required: ['taskId'],
      },
    },
  ],
}));

// --- Tool execution ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;

  try {
    switch (name) {
      case 'create_task': {
        const result = await client.createTask({
          name: (params as Record<string, unknown>).name as string,
          prompt: (params as Record<string, unknown>).prompt as string | undefined,
          projectId: (params as Record<string, unknown>).projectId as string | undefined,
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
        await client.sendPrompt(
          (params as Record<string, unknown>).taskId as string,
          (params as Record<string, unknown>).prompt as string,
        );
        return { content: [{ type: 'text', text: 'Prompt sent successfully.' }] };
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
        // Return files summary + truncated diff
        const summary = result.files
          .map((f) => `${f.status} ${f.path} (+${f.lines_added} -${f.lines_removed})`)
          .join('\n');
        const diffText =
          result.diff.length > 50_000
            ? result.diff.slice(0, 50_000) + '\n... (diff truncated)'
            : result.diff;
        return {
          content: [{ type: 'text', text: `Changed files:\n${summary}\n\n${diffText}` }],
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
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'close_task': {
        await client.closeTask((params as Record<string, unknown>).taskId as string);
        return { content: [{ type: 'text', text: 'Task closed successfully.' }] };
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
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
