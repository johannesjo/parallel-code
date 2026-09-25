import { startRemoteServer } from '../remote/server.js';
import type { Coordinator } from '../mcp/coordinator.js';

export type RemoteServerHandle = Awaited<ReturnType<typeof startRemoteServer>>;
type RemoteServerOptions = Omit<Parameters<typeof startRemoteServer>[0], 'port' | 'host'>;

export interface RemoteTransportOptions {
  defaultPort: number;
  serverOptions: () => RemoteServerOptions;
  coordinator: () => Pick<
    Coordinator,
    'hasActiveCoordinator' | 'hasActiveLegacyCoordinator'
  > | null;
  /** Container agents on macOS reach the host only through a wide bind. */
  needsWideBind: (dockerMode: boolean) => boolean;
  /** A running agent or delegated task still needs the wide bind. */
  wideBindInUse: () => boolean;
  rememberedDevicesPath: () => string;
}

export interface RemoteAccessInfo {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  port: number;
  unavailableReason?: 'coordinator_active';
}

export interface RemoteTransport {
  /** The running server, or null. Read it on each use; it changes across awaits. */
  current(): RemoteServerHandle | null;
  /** The server for MCP clients, started on loopback (or a wide bind for Docker) if needed. */
  ensureForMcp(dockerMode: boolean): Promise<RemoteServerHandle>;
  /** Stops a server started only for MCP once nothing needs it. */
  stopIfIdle(): Promise<void>;
  startRemoteAccess(port?: number): Promise<RemoteAccessInfo>;
  stopRemoteAccess(): Promise<{ stopped: boolean; reason?: string }>;
}

async function startRemoteServerOnFreePort(
  start: number,
  end: number,
  opts: Omit<Parameters<typeof startRemoteServer>[0], 'port'>,
): Promise<RemoteServerHandle> {
  for (let port = start; port <= end; port++) {
    try {
      return await startRemoteServer({ ...opts, port });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && port < end) continue;
      throw err;
    }
  }
  throw new Error(`No free port found in range ${start}–${end}`);
}

const warnDockerBind = () =>
  console.warn(
    '[MCP] Docker mode (macOS): MCP server bound to 0.0.0.0 — reachable from local network ' +
      'interfaces. Traffic from containers uses Docker Desktop internal routing; the bearer ' +
      'token still gates every request.',
  );

/**
 * The HTTP/WebSocket server shared by phone access and MCP clients, and the
 * rules for who started it and when it may stop. All of its state changes here.
 */
export function createRemoteTransport(opts: RemoteTransportOptions): RemoteTransport {
  let server: RemoteServerHandle | null = null;
  // True when the server was started by StartMCPServer (not the manual StartRemoteServer).
  // Used to stop the server automatically when the last MCP coordinator deregisters.
  let startedForMcp = false;
  // True when the user has explicitly requested remote access via StartRemoteServer.
  // Prevents auto-stop when coordinator deregisters even if MCP started the server first.
  let requestedManually = false;
  // True when StopRemoteServer was called while a coordinator was active.
  // The server will be stopped when the last coordinator deregisters.
  let pendingStop = false;

  // One in-flight start for manual and MCP callers alike: a spawn during a manual start
  // (or the reverse) waits for that listener instead of opening a second, orphaned one.
  // Callers loop on it inline so an idle path reaches startTransport without yielding;
  // a failed start reports to its own caller, waiters simply see no server.
  let starting: Promise<RemoteServerHandle> | undefined;
  function startTransport(
    start: () => Promise<RemoteServerHandle>,
    forMcp: boolean,
  ): Promise<RemoteServerHandle> {
    const pending = (async () => {
      try {
        const started = await start();
        server = started;
        startedForMcp = forMcp;
        return started;
      } finally {
        starting = undefined;
      }
    })();
    starting = pending;
    return pending;
  }
  // Stopping the server while its listener is being re-bound would orphan the new listener
  // and hand callers a stopped handle; an exit during that window defers to the rebind.
  let rebinding: Promise<void> | undefined;
  /** A rebind that leaves nothing listening hands back a dead handle; drop it. */
  async function rebindTransport(target: RemoteServerHandle, host: string): Promise<void> {
    rebinding = target.rebind(host);
    try {
      await rebinding;
    } catch (error) {
      if (!target.listening && server === target) {
        server = null;
        startedForMcp = false;
        requestedManually = false;
        pendingStop = false;
      }
      throw error;
    } finally {
      rebinding = undefined;
      // The last agent may have exited meanwhile; its deferred idle check runs once now.
      await stopIfIdle();
    }
  }
  /** An MCP-only server has no reason to run once neither a coordinator nor a canvas agent needs it. */
  async function stopIfIdle(): Promise<void> {
    const current = server;
    if (rebinding || !current) return;
    if (opts.coordinator()?.hasActiveCoordinator() || current.hasCanvasAgents()) return;
    if (!pendingStop && !(startedForMcp && !requestedManually)) return;
    const forgetDevices = pendingStop;
    server = null;
    startedForMcp = false;
    requestedManually = false;
    pendingStop = false;
    await current.stop(forgetDevices);
  }
  async function ensureForMcp(dockerMode: boolean): Promise<RemoteServerHandle> {
    while (starting) await starting.catch(() => undefined);
    // Docker mode on macOS requires 0.0.0.0: containers reach the host through
    // host.docker.internal, which routes through Docker Desktop's virtual adapter.
    const wideOpen = opts.needsWideBind(dockerMode);
    if (server && wideOpen && server.bindHost === '127.0.0.1') {
      warnDockerBind();
      await rebindTransport(server, '0.0.0.0');
    }
    // The idle check after a rebind may have released a transport nobody used any more.
    if (server) return server;
    if (wideOpen) warnDockerBind();
    return startTransport(
      () =>
        startRemoteServerOnFreePort(opts.defaultPort, opts.defaultPort + 23, {
          host: wideOpen ? '0.0.0.0' : '127.0.0.1',
          ...opts.serverOptions(),
        }),
      true,
    );
  }

  async function startRemoteAccess(port?: number): Promise<RemoteAccessInfo> {
    while (starting) await starting.catch(() => undefined);
    // If server was started for MCP-only (loopback), rebind to 0.0.0.0 so WiFi/Tailscale
    // clients can reach it. Skip rebind while a coordinator is active — restarting the
    // server would break ongoing MCP connections.
    if (server && startedForMcp && !opts.coordinator()?.hasActiveLegacyCoordinator()) {
      await rebindTransport(server, '0.0.0.0');
    }
    // The idle check after a rebind may have released a transport nobody used any more.
    if (server) {
      // Loopback-only means the server is MCP-only and inaccessible from other devices.
      // Return unavailableReason without marking this as a successful manual start.
      if (server.bindHost === '127.0.0.1') {
        return {
          url: server.url,
          wifiUrl: null,
          tailscaleUrl: null,
          port: server.port,
          unavailableReason: 'coordinator_active' as const,
        };
      }
      server.enableRememberedDevices(opts.rememberedDevicesPath());
      requestedManually = true;
      pendingStop = false;
      return {
        url: server.url,
        wifiUrl: server.wifiUrl,
        tailscaleUrl: server.tailscaleUrl,
        port: server.port,
      };
    }

    // Remote access is an explicit user action — bind to all interfaces so WiFi/Tailscale clients
    // can reach the SPA. Coordinator MCP-only mode uses 127.0.0.1 by default.
    const started = await startTransport(
      () =>
        startRemoteServer({
          port: port ?? opts.defaultPort,
          host: '0.0.0.0',
          ...opts.serverOptions(),
        }),
      false,
    );
    started.enableRememberedDevices(opts.rememberedDevicesPath());
    requestedManually = true;
    pendingStop = false;
    return {
      url: started.url,
      wifiUrl: started.wifiUrl,
      tailscaleUrl: started.tailscaleUrl,
      port: started.port,
    };
  }

  async function stopRemoteAccess(): Promise<{ stopped: boolean; reason?: string }> {
    if (!server) return { stopped: true };
    const coordinator = opts.coordinator();
    if (coordinator?.hasActiveLegacyCoordinator()) {
      // The coordinator MCP transport shares this HTTP server. Stopping it while
      // a coordinator is active would break all in-flight MCP tool calls.
      // Record the pending stop so the last coordinator deregistration will auto-stop.
      pendingStop = true;
      console.warn(
        '[Remote] Stop requested but coordinator MCP is active — will stop on last coordinator exit',
      );
      return { stopped: false, reason: 'coordinator_active' };
    }
    if (server.hasCanvasAgents() || coordinator?.hasActiveCoordinator()) {
      // Running agents keep their canvas transport; only the phone-facing access ends.
      // Loopback is unreachable from other devices, so the shared URL stops working.
      if (opts.wideBindInUse()) return { stopped: false, reason: 'docker_active' };
      server.forgetRememberedDevices();
      // Mark it MCP-only before narrowing so the idle check after the rebind may release it.
      startedForMcp = true;
      requestedManually = false;
      pendingStop = false;
      await rebindTransport(server, '127.0.0.1');
      return { stopped: true };
    }
    await server.stop(true);
    server = null;
    requestedManually = false;
    return { stopped: true };
  }

  return {
    current: () => server,
    ensureForMcp,
    stopIfIdle,
    startRemoteAccess,
    stopRemoteAccess,
  };
}
