# Remote Access Specification

## Purpose

Let users monitor and interact with their parallel-code AI agents from a phone
or tablet on the same local network (or Tailscale) without returning to the
desktop.

## Requirements

### Requirement: On-demand local server

The app SHALL run at most one embedded remote server, started and stopped
explicitly by the user through IPC, and bound to `0.0.0.0` on the configured
port so that other devices on the same network can reach it.

#### Scenario: User starts the remote server

- **WHEN** the renderer sends the `StartRemoteServer` IPC request
- **THEN** the main process starts an HTTP server with a WebSocket server
  accepting upgrades on the same listener
- **AND** the server binds to `0.0.0.0` on the configured port
- **AND** the response includes the generated auth token and the access URLs
  for the detected WiFi and Tailscale interfaces

#### Scenario: User stops the remote server

- **WHEN** the renderer sends the `StopRemoteServer` IPC request
- **THEN** the server closes all open WebSocket connections
- **AND** the HTTP listener is closed
- **AND** subsequent `GetRemoteStatus` requests report the server as stopped

#### Scenario: Only one server runs at a time

- **WHEN** `StartRemoteServer` is requested while a server is already running
- **THEN** the existing server instance is reused and its token and URLs are
  returned
- **AND** no second listener is opened on the port

### Requirement: Network interface detection

The server SHALL advertise reachable URLs by detecting the host's LAN and
Tailscale IP addresses, and SHALL exclude container-only interfaces.

#### Scenario: WiFi and Tailscale addresses are exposed

- **WHEN** the server starts on a machine with both a LAN interface and a
  Tailscale interface in the `100.x.x.x` range
- **THEN** the returned URL list contains one entry for the LAN address and
  one entry for the Tailscale address
- **AND** Docker or container bridge addresses in `172.x.x.x` are omitted

### Requirement: Token-based authentication

The server SHALL require a session-scoped bearer token for every WebSocket
connection and every `/api/` request, and SHALL compare tokens with a
timing-safe comparison.

#### Scenario: Token is generated per server session

- **WHEN** the server starts
- **THEN** a fresh token is generated from the platform's cryptographic RNG
  and base64url-encoded
- **AND** the token is not persisted to disk
- **AND** stopping and restarting the server produces a new token

#### Scenario: WebSocket first-message auth succeeds

- **WHEN** a client connects and sends `{ "type": "auth", "token": "<valid>" }`
  as its first message
- **THEN** the server compares tokens with a timing-safe comparison
- **AND** marks the connection as authenticated
- **AND** sends the current agent list as an `agents` message

#### Scenario: WebSocket auth times out

- **WHEN** a connected client does not send a valid auth message within 5
  seconds
- **THEN** the server closes the connection with WebSocket close code `4001`
- **AND** the client receives no further messages

#### Scenario: REST request without credentials

- **WHEN** a request to any `/api/*` route arrives without a valid
  `Authorization: Bearer <token>` header or `?token=` query parameter
- **THEN** the server responds with HTTP `401`
- **AND** no agent data is returned

#### Scenario: URL-token fallback for WebSockets

- **WHEN** a WebSocket client connects with `?token=<valid>` on the upgrade URL
  and does not send a `type: "auth"` message
- **THEN** the server accepts the token as a fallback
- **AND** marks the connection as authenticated

### Requirement: Connection and payload limits

The server SHALL bound resource usage by capping concurrent WebSocket
connections, limiting inbound payload sizes, and validating every client
message.

#### Scenario: Too many concurrent clients

- **WHEN** an 11th WebSocket client attempts to connect while 10 are already
  authenticated
- **THEN** the server rejects the upgrade handshake with HTTP `429`

#### Scenario: Oversized WebSocket frame

- **WHEN** a client sends a WebSocket frame larger than 64 KB
- **THEN** the server rejects the frame and closes the connection

#### Scenario: Malformed or unknown client message

- **WHEN** an authenticated client sends a message that is not valid JSON, is
  missing a `type` field, has a `type` the server does not handle, or has an
  `agentId` longer than 100 characters
- **THEN** the message is silently dropped
- **AND** no error response is sent

#### Scenario: Input and resize bounds

- **WHEN** an `input` message has `data` longer than 4096 characters, or a
  `resize` message has `cols` or `rows` outside the range 1–500
- **THEN** the message is silently dropped

### Requirement: Agent list broadcasting

The server SHALL push the current agent list to every authenticated client on
connect and whenever an agent spawns, exits, or the list changes, filtering
out shell sub-terminals and deduplicating by task.

#### Scenario: Initial agent list on connect

- **WHEN** a client authenticates successfully
- **THEN** the server sends one `agents` message containing every currently
  tracked agent
- **AND** shell / sub-terminal entries (where `isShell` is true) are excluded
- **AND** duplicate entries for the same `taskId` are collapsed, preferring
  the running agent over an exited one

#### Scenario: Agent spawn broadcast

- **WHEN** the PTY manager emits a `spawn` event
- **THEN** the server rebuilds the agent list and sends an `agents` message to
  every authenticated client

#### Scenario: Agent exit broadcast

- **WHEN** the PTY manager emits an `exit` event for an agent
- **THEN** the server sends a `status` message with the final `exitCode` to
  every authenticated client immediately
- **AND** 100 ms later sends a refreshed `agents` message

### Requirement: Live output streaming and scrollback

The server SHALL stream terminal output live to subscribed clients, back it
with a fixed-capacity in-memory ring buffer, and replay the buffer when a
client subscribes so mid-session joiners see recent history.

#### Scenario: Client subscribes to an agent

- **WHEN** an authenticated client sends `{ "type": "subscribe", "agentId": ... }`
- **THEN** the server registers a per-client subscription callback
- **AND** sends the agent's current ring-buffer contents as a single
  `scrollback` message (base64-encoded `data` and the current `cols`)
- **AND** streams every subsequent chunk of PTY output as an `output` message

#### Scenario: Client unsubscribes

- **WHEN** the client sends `{ "type": "unsubscribe", "agentId": ... }`
- **THEN** the subscription callback is removed
- **AND** no further `output` messages for that agent are sent to the client

#### Scenario: Scrollback capacity is bounded

- **WHEN** total output for a single agent exceeds the 64 KB ring-buffer
  capacity
- **THEN** only the most recent 64 KB is retained
- **AND** earlier bytes are discarded

#### Scenario: Scrollback is not persisted across restarts

- **WHEN** the Electron app restarts
- **THEN** every ring buffer is empty at the next `StartRemoteServer`

### Requirement: Remote agent control

Authenticated clients SHALL be able to send input to an agent, resize its
terminal, and kill it through WebSocket messages that map onto the existing
PTY manager operations.

#### Scenario: Client sends input

- **WHEN** the client sends `{ "type": "input", "agentId": ..., "data": ... }`
- **THEN** the server forwards `data` to the agent's PTY `stdin`

#### Scenario: Client resizes terminal

- **WHEN** the client sends `{ "type": "resize", "agentId": ..., "cols": N, "rows": M }`
  with both dimensions between 1 and 500
- **THEN** the server resizes the agent's PTY to those dimensions

#### Scenario: Client kills an agent

- **WHEN** the client sends `{ "type": "kill", "agentId": ... }`
- **THEN** the server signals the agent process to terminate via the PTY
  manager's kill operation

### Requirement: REST endpoints for initial loads

The server SHALL expose a read-only REST API for clients that need the agent
list or a single agent's scrollback without opening a WebSocket.

#### Scenario: List all agents

- **WHEN** a client requests `GET /api/agents` with a valid token
- **THEN** the response is `200 OK` with a JSON array matching the `list`
  field of the `agents` WebSocket message

#### Scenario: Fetch a single agent

- **WHEN** a client requests `GET /api/agents/:agentId` with a valid token
- **THEN** the response includes the agent's scrollback, status, and
  `exitCode`

### Requirement: Mobile SPA and static serving

The server SHALL serve a separate, pre-built mobile SPA from disk with a safe
path policy and sensible caching, and SHALL fall back to `index.html` for
client-side routing.

#### Scenario: Static asset request

- **WHEN** a request maps to an existing file in the static root
- **THEN** hashed assets are served with a long-lived, immutable cache policy
- **AND** `index.html` is served with a no-cache policy

#### Scenario: Path traversal is rejected

- **WHEN** a request resolves outside the static root (e.g. `..` segments)
- **THEN** the server rejects the request without touching the filesystem

#### Scenario: Unknown path falls through to SPA

- **WHEN** a request targets a path that is not a static file and is not under
  `/api/`
- **THEN** the server responds with `index.html` so the SPA router can handle
  the route
- **AND** the response never lists directory contents

### Requirement: HTTP security headers

Every HTTP response SHALL include baseline security headers that block
content-type sniffing, framing, and outbound referrer leakage.

#### Scenario: Headers are applied to every response

- **WHEN** the server sends any HTTP response
- **THEN** it includes `X-Content-Type-Options: nosniff`
- **AND** it includes `X-Frame-Options: DENY`
- **AND** it includes `Referrer-Policy: no-referrer`

### Requirement: Desktop UI integration

The desktop renderer SHALL surface a remote-access control in settings that
shows the server state, the connection URL and QR code, and the number of
connected clients, and SHALL drive start/stop through IPC.

#### Scenario: User toggles remote access on

- **WHEN** the user flips the remote-access toggle in settings
- **THEN** the renderer sends `StartRemoteServer`
- **AND** the returned URL and token are rendered as a QR code plus copyable
  text

#### Scenario: Connected-client counter stays current

- **WHEN** the server's connected-client count changes while the UI is
  visible
- **THEN** the displayed counter updates within a few seconds via periodic
  `GetRemoteStatus` polling
