import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../remote/server.js', () => ({ startRemoteServer: vi.fn() }));

const { startRemoteServer } = await import('../remote/server.js');
const { createRemoteTransport } = await import('./remote-transport.js');

function fakeServer(bindHost: string) {
  return {
    bindHost,
    url: 'http://host',
    wifiUrl: null,
    tailscaleUrl: null,
    port: 7777,
    listening: true,
    stop: vi.fn(async () => undefined),
    rebind: vi.fn(async () => undefined),
    hasCanvasAgents: () => false,
    enableRememberedDevices: vi.fn(),
    forgetRememberedDevices: vi.fn(),
  } as unknown as Awaited<ReturnType<typeof startRemoteServer>>;
}

function setup() {
  const onPhoneAccessChange = vi.fn();
  const transport = createRemoteTransport({
    defaultPort: 7777,
    serverOptions: () => ({}) as never,
    coordinator: () => null,
    needsWideBind: () => false,
    wideBindInUse: () => false,
    rememberedDevicesPath: () => '/tmp/paired.json',
    onPhoneAccessChange,
  });
  return { transport, onPhoneAccessChange };
}

beforeEach(() => {
  vi.mocked(startRemoteServer).mockReset();
});

describe('phone access tracking', () => {
  it('reports phone access while Remote Access runs', async () => {
    vi.mocked(startRemoteServer).mockResolvedValue(fakeServer('0.0.0.0'));
    const { transport, onPhoneAccessChange } = setup();

    await transport.startRemoteAccess();
    expect(onPhoneAccessChange).toHaveBeenLastCalledWith(true);

    await transport.stopRemoteAccess();
    expect(onPhoneAccessChange).toHaveBeenLastCalledWith(false);
    expect(onPhoneAccessChange).toHaveBeenCalledTimes(2);
  });

  it('does not count a loopback server started only for MCP', async () => {
    vi.mocked(startRemoteServer).mockResolvedValue(fakeServer('127.0.0.1'));
    const { transport, onPhoneAccessChange } = setup();

    await transport.ensureForMcp(false);
    await transport.stopIfIdle();
    expect(onPhoneAccessChange).not.toHaveBeenCalled();
  });
});
