import { createSignal } from 'solid-js';
import { getToken, clearToken, getPairedToken, clearPairedToken } from './auth';
import type { ServerMessage, RemoteAgent } from '../../electron/remote/protocol';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

const [agents, setAgents] = createSignal<RemoteAgent[]>([]);
const [status, setStatus] = createSignal<ConnectionStatus>('disconnected');

type OutputListener = (data: string) => void;
type ScrollbackListener = (data: string, cols: number) => void;
const outputListeners = new Map<string, Set<OutputListener>>();
const scrollbackListeners = new Map<string, Set<ScrollbackListener>>();

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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

export { agents, status };

export function connect(): void {
  // Allow reconnect when existing socket is closing (not just null)
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
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

  setStatus('connecting');
  ws = new WebSocket(url);

  ws.onopen = () => {
    // Authenticate via first message instead of URL query to avoid
    // token leaking in proxy logs or browser history.
    send({ type: 'auth', token: auth.token });
    setStatus('connected');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Re-subscribe to agents with active listeners (lost on disconnect)
    for (const [agentId, set] of outputListeners) {
      if (set.size > 0) send({ type: 'subscribe', agentId });
    }
  };

  ws.onmessage = (event) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(event.data));
    } catch (e) {
      console.error('[ws] Failed to parse server message:', e);
      return;
    }

    switch (msg.type) {
      case 'agents':
        setAgents(msg.list);
        break;

      case 'output': {
        const listeners = outputListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data));
        break;
      }

      case 'scrollback': {
        const listeners = scrollbackListeners.get(msg.agentId);
        listeners?.forEach((fn) => fn(msg.data, msg.cols));
        break;
      }

      case 'status':
        setAgents((prev) =>
          prev.map((a) =>
            a.agentId === msg.agentId ? { ...a, status: msg.status, exitCode: msg.exitCode } : a,
          ),
        );
        break;
    }
  };

  ws.onclose = (event) => {
    ws = null;
    setStatus('disconnected');
    // 4001 = server rejected auth — the token is stale (the desktop restarted
    // Remote Access, which rotates every token). A stale paired token falls
    // back to the QR-code token so the phone keeps watching and only loses
    // typing rights until it pairs again; a stale QR-code token means
    // reconnecting from scratch.
    if (event.code === 4001) {
      if (authTokenKind === 'paired') {
        clearPairedToken();
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 0);
        return;
      }
      clearToken();
      window.location.reload();
      return;
    }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

/** True when the open socket authenticated with the paired token, i.e. the
 *  server will accept `input` from it. A paired token stored by another tab
 *  does not count until this socket reconnects with it. */
export function socketCanType(): boolean {
  return status() === 'connected' && authTokenKind === 'paired';
}

/** Drop the current socket and connect again with the best available token. */
export function reconnect(): void {
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
  connect();
}

export function send(msg: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

export function sendInput(agentId: string, data: string): void {
  send({ type: 'input', agentId, data });
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
