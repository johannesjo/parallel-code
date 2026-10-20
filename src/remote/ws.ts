import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { getToken, clearToken, getPairedToken, clearPairedToken } from './auth';
import type { ServerMessage, RemoteAgent, RemoteChatAction } from '../../electron/remote/protocol';
import type { AgentChatState } from '../../electron/shared/agent-chat-types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

// Keep each agent's identity across snapshots so polling doesn't remount cards
// or restart detail effects that only depend on the task ID.
const [agentState, setAgentState] = createStore<{ list: RemoteAgent[] }>({ list: [] });
const agents = () => agentState.list;
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');
const [needsConnection, setNeedsConnection] = createSignal(false);
const [canControl, setCanControl] = createSignal(false);
const pendingInputs = new Map<
  string,
  { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
>();
let nextInputId = 0;

function failPendingInputs(): void {
  for (const pending of pendingInputs.values()) {
    clearTimeout(pending.timer);
    pending.reject(
      new Error(
        'Connection interrupted. Your message may have reached the terminal. Check the output before retrying.',
      ),
    );
  }
  pendingInputs.clear();
}

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number, rows: number) => void;
type ChatListener = (state: AgentChatState) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();
const chatListeners = new Map<string, Set<ChatListener>>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectionTimer: ReturnType<typeof setTimeout> | null = null;

function clearConnectionTimer(): void {
  if (connectionTimer) clearTimeout(connectionTimer);
  connectionTimer = null;
}
// Which credential the open socket authenticated with. The paired token
// (minted by entering the desktop PIN) is preferred because it is the one
// that may type into terminals; the QR-code token only watches.
let authTokenKind: 'paired' | 'mobile' = 'mobile';

/** Pick the credential for the next socket: paired if this phone has one. */
function selectAuthToken(): { token: string; kind: 'paired' | 'mobile' } | null {
  const paired = getPairedToken();
  if (paired) return { token: paired, kind: 'paired' };
  const mobile = getToken();
  return mobile ? { token: mobile, kind: 'mobile' } : null;
}

export { agents, status, needsConnection, canControl };

export function connect(): void {
  // Allow reconnect when existing socket is closing (not just null)
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearConnectionTimer();
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws = null;
  }

  const auth = selectAuthToken();
  if (!auth) return;
  authTokenKind = auth.kind;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/ws`;

  setNeedsConnection(false);
  setCanControl(false);
  setStatus('connecting');
  ws = new WebSocket(url);
  const socket = ws;

  ws.onopen = () => {
    if (ws !== socket) return;
    // Authenticate via first message instead of URL query to avoid
    // token leaking in proxy logs or browser history.
    send({ type: 'auth', token: auth.token });

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Re-subscribe to agents with active listeners (lost on disconnect)
    for (const [agentId, set] of outputListeners) {
      if (set.size > 0) send({ type: 'subscribe', agentId });
    }
    for (const agentId of chatListeners.keys()) send({ type: 'chat-subscribe', agentId });
  };

  ws.onmessage = (event) => {
    if (ws !== socket) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(event.data));
    } catch (e) {
      console.error('[ws] Failed to parse server message:', e);
      return;
    }

    switch (msg.type) {
      case 'agents':
        clearConnectionTimer();
        setStatus('connected');
        setCanControl(authTokenKind === 'paired');
        setAgentState('list', reconcile(msg.list, { key: 'agentId' }));
        break;

      case 'input-result': {
        const pending = pendingInputs.get(msg.requestId);
        if (!pending) break;
        clearTimeout(pending.timer);
        pendingInputs.delete(msg.requestId);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.error ?? 'Could not send. Your draft has been kept.'));
        break;
      }

      case 'output': {
        const listeners = outputListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case 'chat-state':
        chatListeners.get(msg.agentId)?.forEach((fn) => fn(msg.state));
        break;

      case 'scrollback': {
        const listeners = scrollbackListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data, msg.cols, msg.rows ?? 24));
        break;
      }

      case 'status':
        setAgentState('list', (a) => a.agentId === msg.agentId, {
          status: msg.status,
          exitCode: msg.exitCode,
        });
        break;
    }
  };

  const onDisconnect = (code: number) => {
    if (ws !== socket) return;
    clearConnectionTimer();
    ws = null;
    setStatus('disconnected');
    setCanControl(false);
    failPendingInputs();
    // 4001 = server rejected auth — the token is stale (the desktop restarted
    // Remote Access, or revoked this phone). A stale paired token falls
    // back to the QR-code token so the phone keeps watching and only loses
    // typing rights until it pairs again; a stale QR-code token means
    // reconnecting from scratch.
    if (code === 4001) {
      if (authTokenKind === 'paired') {
        clearPairedToken();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 0);
        return;
      }
      clearToken();
      setNeedsConnection(true);
      return;
    }
    if (code === 4003) clearPairedToken();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onclose = (event) => onDisconnect(event.code);
  // A suspended phone or an unreachable computer may never finish opening the
  // socket. Bound the entire handshake, including the authenticated snapshot.
  connectionTimer = setTimeout(() => {
    onDisconnect(1006);
    socket.close();
  }, 10000);

  ws.onerror = () => {
    if (ws === socket) socket.close();
  };
}

/** Drop the current socket and connect again with the best available token. */
export function reconnect(): void {
  clearConnectionTimer();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    // Detach the handlers first: a manual close must not trigger the
    // auto-reconnect path (that would race the connect below).
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
  setStatus('disconnected');
  setCanControl(false);
  failPendingInputs();
  connect();
}

function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export interface SendInputOptions {
  /** Press Enter once the terminal has taken the text. */
  submit?: boolean;
  /** Keystroke to type before the text, in its own terminal write. */
  prefixKey?: string;
}

export function sendInput(
  agentId: string,
  data: string,
  { submit = false, prefixKey }: SendInputOptions = {},
): Promise<void> {
  if (data.length > 4096)
    return Promise.reject(new Error('This message is too long. Shorten it and try again.'));
  return request({
    type: 'input',
    agentId,
    data,
    submit,
    ...(prefixKey ? { prefixKey } : {}),
  });
}

/** Run a conversation action on a desktop chat; needs a paired phone. */
export function sendChatAction(
  agentId: string,
  action: RemoteChatAction,
  params: Record<string, unknown> = {},
): Promise<void> {
  return request({ type: 'chat-action', agentId, action, params });
}

/** Send a message the server confirms with an input-result for its requestId. */
function request(msg: Record<string, unknown>): Promise<void> {
  if (!canControl() || ws?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Reconnect before sending. Your draft has been kept.'));
  }
  const requestId = String(++nextInputId);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingInputs.delete(requestId);
      reject(
        new Error(
          'Delivery could not be confirmed. Check the output before retrying; your draft has been kept.',
        ),
      );
    }, 10000);
    pendingInputs.set(requestId, { resolve, reject, timer });
    try {
      send({ ...msg, requestId });
    } catch {
      clearTimeout(timer);
      pendingInputs.delete(requestId);
      reject(new Error('Could not send. Your draft has been kept.'));
    }
  });
}

/**
 * Turn the mouse wheel over a full-screen agent UI, which keeps its transcript
 * out of the terminal history. Needs a paired phone; the server closes others.
 */
export function scrollAgent(agentId: string, lines: number, col: number, row: number): void {
  if (canControl()) send({ type: 'scroll', agentId, lines, col, row });
}

export function subscribeAgent(agentId: string): void {
  send({ type: 'subscribe', agentId });
}

export function unsubscribeAgent(agentId: string): void {
  send({ type: 'unsubscribe', agentId });
}

export function onOutput(agentId: string, fn: OutputListener): () => void {
  let listeners = outputListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    outputListeners.set(agentId, listeners);
  }
  listeners.add(fn);
  return () => {
    const set = outputListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) outputListeners.delete(agentId);
  };
}

export function onScrollback(agentId: string, fn: ScrollbackListener): () => void {
  let listeners = scrollbackListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    scrollbackListeners.set(agentId, listeners);
  }
  listeners.add(fn);
  return () => {
    const set = scrollbackListeners.get(agentId);
    set?.delete(fn);
    if (set?.size === 0) scrollbackListeners.delete(agentId);
  };
}

/** Follow a desktop chat. The first listener subscribes; the last one to leave unsubscribes. */
export function watchChat(agentId: string, fn: ChatListener): () => void {
  let listeners = chatListeners.get(agentId);
  if (!listeners) {
    listeners = new Set();
    chatListeners.set(agentId, listeners);
    send({ type: 'chat-subscribe', agentId });
  }
  listeners.add(fn);
  return () => {
    const set = chatListeners.get(agentId);
    set?.delete(fn);
    if (set?.size !== 0) return;
    chatListeners.delete(agentId);
    send({ type: 'chat-unsubscribe', agentId });
  };
}
