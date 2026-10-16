# Remote browser over CDP

**Status: proposal.** This describes a change that is not in the code yet. The guides in `docs/` describe what exists; this says what to build and why.

## What this adds

Pi Pocket already drives Chromium over the Chrome DevTools Protocol (CDP). Today it starts Chromium itself and speaks CDP over that process's stdin/stdout pipe (`src/server/browser/cdp.ts`). This plan adds a second way to reach a browser: **connect to a CDP endpoint over a WebSocket**, so the browser can run in another container (such as `chromedp/headless-shell`) or on another machine.

The protocol is the same. What changes is the **transport** (pipe → WebSocket) and the **lifecycle** (Pi Pocket owns the process → Pi Pocket is a client of a browser it does not own).

## Why

- Run the browser in its own container: Chromium's dependencies and sandbox stay out of Pi Pocket's image.
- Use a maintained headless-shell image instead of installing Chromium.
- Keep the browser alive across Pi Pocket restarts.
- Later: point several Pi Pocket instances at one browser; isolation is already per-conversation browser context.

## How the browser works today

- `Browsers` (`src/server/browser.ts`) owns the browser: it finds an executable (`browser/discovery.ts`), launches one `Chromium` lazily, opens one `BrowserPage` per conversation in its own browser context, reaps idle pages and the idle browser, and closes everything on shutdown.
- `Chromium.launch` (`browser/cdp.ts`) spawns the executable with `--remote-debugging-pipe`, builds a `Connection` from the child's fd 3 and fd 4, then handshakes: `Browser.getVersion` (rewriting `HeadlessChrome/` to `Chrome/`) and `Target.setDiscoverTargets`.
- `Connection` (`browser/cdp.ts`) does the JSON-RPC bookkeeping (request ids and pending promises, session-scoped event listeners, close) **and** the pipe framing (JSON messages separated by NUL bytes).
- `BrowserPage` (`browser/page.ts`) sends CDP commands with a session id and listens for that session's events.
- `Browsers` reacts to browser-level `Target.*` events and, on connection close, drops the browser and closes the pages.
- `PocketApp` (`src/server/app.ts`) builds `Browsers` with `executable` (tests) or nothing (discovery), plus `load`/`save` of `BrowserDoc`.

Two responsibilities are tangled in each place this plan touches: JSON-RPC bookkeeping versus pipe framing in `Connection`, and transport versus lifecycle in `Chromium`. The plan separates both.

## Design

### 1. A channel seam under `Connection`

Introduce a `Channel`: one complete JSON message in, one out.

```ts
export interface Channel {
    write(message: string): void;
    onMessage(handler: (message: string) => void): void;
    onClose(handler: (reason: string) => void): void;
    close(reason: string): void;
}
```

- `PipeChannel` keeps today's NUL framing over two streams.
- `SocketChannel` wraps a WebSocket: each `message` event is one message; `close` and `error` map to `onClose`.

`Connection` takes a `Channel` and keeps only the JSON-RPC bookkeeping. This is an internal seam: nothing outside `browser/` sees it.

### 2. A browser-source seam above `Connection`

Replace `Chromium.launch(...)` with an interface that yields a connected browser:

```ts
export interface BrowserLink {
    readonly connection: Connection;
    readonly userAgent: string;
    /** Resolves when the browser is gone: process exit, or socket closed. */
    readonly exited: Promise<void>;
    /** Stop the browser, or just let go of it. */
    stop(): void;
}

export interface BrowserSource {
    readonly available: boolean;
    /** Connect and handshake, or throw a BrowserError saying why not. */
    connect(): Promise<BrowserLink>;
}
```

- `LocalBrowser` is today's behavior: find or spawn the executable, pipe channel, `SIGTERM` then `SIGKILL` on `stop`.
- `RemoteBrowser` is new: discover the endpoint, open the socket, handshake, and on `stop` close the socket only.

`Browsers` holds a `BrowserSource` and keeps its existing `#browser()` logic (recreate when the connection is closed) unchanged. `BrowsersOptions` gains `source?: BrowserSource`; `executable` and `args` become sugar that builds a `LocalBrowser`, so existing tests keep working.

### 3. Endpoint discovery

`RemoteBrowser` accepts either form:

- `http(s)://host:port` (optionally with `/json/version`): GET `/json/version` and read `webSocketDebuggerUrl`.
- `ws(s)://…`: use it as given.

Discovery uses `undici` fetch, already a dependency. Failures are `BrowserError`s naming what went wrong (HTTP status, no `webSocketDebuggerUrl`, bad scheme).

One subtlety: `configureHttp` (`src/server/net.ts`) installs an env-proxy dispatcher globally. A browser endpoint on a private network must not go through `HTTP_PROXY`. The discovery fetch and the WebSocket should use a dispatcher that bypasses the proxy for that host (or honor `NO_PROXY`). Verify that undici's `WebSocket` accepts a `dispatcher`.

### 4. Configuration

One new setting, read at startup:

- `PI_POCKET_BROWSER_URL` (environment): the CDP endpoint.

Precedence: `PI_POCKET_BROWSER_URL` (remote) wins over `PI_POCKET_BROWSER` (a local executable path) and over discovery. If both are set, log a note. The endpoint is server-level, not per-conversation, and changing it takes a restart because the source is built when `Browsers` is made. A `config.json` setting with a sheet control is a possible follow-up, not v1.

A `--browser-url` launcher flag would give CLI parity with `--host` and `--port`; optional.

### 5. Lifecycle and reconnect

- `RemoteBrowser.connect()` opens the socket and handshakes; `exited` resolves when the socket closes.
- `stop()` closes the socket and does not kill the remote browser. The idle reaper still drops the connection after five idle minutes; reopening is cheap.
- On socket loss, `Browsers`' existing `onClose` drops the browser and closes the pages; the next `open()` reconnects, and each page restores its saved URL and viewport from `BrowserDoc`. No automatic reconnect loop in v1: a remote browser restart closes pages, and they come back where they were on next use.
- The remote browser is expected to outlive Pi Pocket. If it dies, Pi Pocket reconnects when it is back.

### 6. Isolation and event scoping

Every conversation already gets its own browser context (`Target.createBrowserContext`), so cookies and storage stay isolated even in a shared browser. Two hardening steps for a shared endpoint:

- `Browsers` should keep the set of context ids it created and ignore browser-level `Target.*` events whose `browserContextId` is not one of them. Today every event is offered to every page, and `page.targetEvent` filters by context; filtering once is cheaper and states the assumption.
- A context created in a shared browser outlives Pi Pocket if it dies without disposing it. CDP has no way to name a context, so it cannot be reclaimed reliably on startup. Recommend documenting "point Pi Pocket at a browser of its own" and accepting the leak otherwise.

### 7. Availability and errors

- For a remote source, `available` means "configured"; reachability is not known until connect. An unreachable endpoint fails the first `open()` with a `BrowserError`, which already surfaces as the panel's `problem` and as an error result for Pi's `browser` tool.
- Update the panel's "No browser was found on the machine…" text (`web/browser-panel.js`) and the `browser` tool's guide (`src/server/extensions/browser.ts`) to mention `PI_POCKET_BROWSER_URL`.

### 8. What the remote browser can reach

The remote browser's `localhost`, `file://` paths, and network are its own, not Pi Pocket's. Pi's `browser` tool therefore cannot open Pi Pocket's local dev servers or workspace files unless the browser shares the same paths and network. Two options:

- Document the limit, and word the tool's guide for a remote browser when one is configured (`PocketHost` could expose a `browserIsRemote` flag).
- In Docker, mount the same workspace into both containers so `file://` paths match, and reach a dev server by service name instead of `localhost`.

Recommend documenting first; add the flag only if it proves needed.

### 9. Security

- A CDP endpoint has no authentication. Anyone who can reach it controls the browser: read every context's cookies and storage, navigate, run JavaScript, and (with `file://`) read files the browser can read. Keep it on a private network and never publish it. Add this to `SECURITY.md`.
- Chrome rejects DevTools WebSocket handshakes whose `Origin` is not allowed (`--remote-allow-origins`); a client that sends no `Origin` is normally accepted. Verify against the target Chrome version.
- If a token is needed, put the endpoint behind a reverse proxy that requires it. Whether Pi Pocket can send that credential on the WebSocket handshake depends on undici's `WebSocket` options (`headers`); verify, and fall back to a URL-embedded credential the proxy understands.
- `--no-sandbox` is common in containers (the headless-shell image sets it). Note the trade-off where the image is documented.

## Changes by file

| File                                                                                  | Change                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/browser/cdp.ts`                                                           | Extract `Channel`; add `PipeChannel`; `Connection` takes a channel. Add `BrowserSource`/`BrowserLink`; make `Chromium` the local source. |
| `src/server/browser/socket.ts` (new)                                                  | `SocketChannel` over a WebSocket, mapping `message`, `close`, and `error`.                                                               |
| `src/server/browser/remote.ts` (new)                                                  | `RemoteBrowser`: endpoint parsing, `/json/version` discovery, connect and handshake.                                                     |
| `src/server/browser.ts`                                                               | `Browsers` holds a `BrowserSource`; `available` delegates; `Target.*` events scoped to owned contexts; per-source `stop`.                |
| `src/server/app.ts`                                                                   | Build the source from `PI_POCKET_BROWSER_URL`, `PI_POCKET_BROWSER`, or discovery.                                                        |
| `src/server/main.ts`, `src/launcher/options.ts`, `src/launcher/main.ts`               | Optional `--browser-url` flag threaded to the server.                                                                                    |
| `web/browser-panel.js`                                                                | Availability message mentions the endpoint setting.                                                                                      |
| `src/server/extensions/browser.ts`                                                    | Guide wording for a remote browser (optional, behind a host flag).                                                                       |
| `README.md`, `docs/features.md`, `SECURITY.md`, `docs/architecture.md`, `docs/map.md` | Document the setting, the seam, and the security note.                                                                                   |

## Tests

1. `Channel` unit tests: `PipeChannel` framing (split and coalesced NUL-delimited chunks, a partial trailing message); `SocketChannel` mapping of `message`, `close`, and `error`.
2. Endpoint discovery: a local `http` server serving `/json/version`; assert the WebSocket URL is read; error cases (HTTP 500, missing field, bad scheme).
3. `Connection` over a fake channel: request and response, error, timeout, session events, and close rejecting pending requests.
4. Real WebSocket path without Docker: launch the local Chromium with `--remote-debugging-port=0`, read `DevTools listening on ws://…` from its stderr, point `RemoteBrowser` at it, then open a page, navigate to the test site, and snapshot. Skip when no browser, as today's real tests do. This proves the whole path against real Chrome.
5. Lifecycle: remote `stop()` closes the socket without signalling a process; `exited` resolves; pages close on socket loss and restore on reopen.
6. Event scoping: a target created in another browser context does not reach a page.
7. Keep the existing local-browser tests green; the `LocalBrowser` path must not change behavior.

## Rollout

1. Land the refactor (`Channel` + `BrowserSource`) with no behavior change; every existing test passes.
2. Add `RemoteBrowser` and `PI_POCKET_BROWSER_URL`, defaulting to local.
3. Document the setting, and add a Docker example: a `headless-shell` service on a private network, Pi Pocket pointed at it.
4. Optional follow-ups: launcher flag, a sheet control, auto-reconnect with backoff, context cleanup for shared browsers.

## Open questions

- Is reconnect-on-next-use enough, or is an automatic reconnect with backoff wanted?
- Should the endpoint be a `config.json` setting the owner can change in the app, or environment-only?
- Does undici's `WebSocket` accept custom headers and a dispatcher? (Affects auth and proxy handling.)
- Do we ever want to attach to a page-target WebSocket URL instead of the browser endpoint? (No, unless a use case appears.)
- How do we keep a remote browser's `localhost` and files useful: shared mounts, or documentation only?
