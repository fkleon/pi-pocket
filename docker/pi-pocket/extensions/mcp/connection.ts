/**
 * One MCP server: its connection, its tools, and its state, as the owner's page shows them.
 *
 * One connection serves all sessions. A stdio server runs in the folder that its entry gives (else the home folder),
 * gets Pi Pocket's environment with the entry's `env`, and gets no roots. A dropped connection opens again at the next
 * call. Closing a stdio server closes its input, then stops its process group (Pi's MCP client does this).
 */
import {
    type CallToolResult,
    McpAuthRequiredError,
    McpClient,
    McpHttpError,
    McpSessionExpiredError,
    StdioTransport,
    StreamableHttpTransport,
    type Tool,
} from "@earendil-works/pi-mcp";
import {
    McpOAuthAuthorizationRequiredError,
    type OAuthChallenge,
} from "@earendil-works/pi-mcp/oauth";
import {
    expandHome,
    type HttpConfig,
    type JsonStore,
    resolveRecord,
    type ServerEntry,
    serverCwd,
    type StdioConfig,
} from "./config.ts";
import {
    connectionAuth,
    oauthSettings,
    type OAuthStates,
    serverState,
    type SignIn,
    startSignIn,
    usesOAuth,
} from "./oauth.ts";

export type Status =
    "off" | "connecting" | "connected" | "failed" | "disconnected" | "needs-sign-in" | "closed";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL = 2_000;
/** Pauses before another try at an HTTP server that failed with a passing error. */
const RETRY_DELAYS_MS = [250, 1_000];
/** A client whose session the server forgot closes this soon at most. */
const DETACHED_MS = 10 * 60_000;
/** A stdio server that does not stop by itself: stop it this soon, within the server's 3 s for cleanups. */
const CLOSE_TIMEOUT_MS = 1_500;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Network failures, and servers that are overloaded or restart: worth another try. */
function passing(error: unknown): boolean {
    if (error instanceof McpHttpError) {
        return (
            error.status === 408 ||
            error.status === 429 ||
            (error.status >= 500 && error.status !== 501)
        );
    }

    return error instanceof TypeError;
}

const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        };

        const timer = setTimeout(done, ms);

        signal.addEventListener("abort", done, { once: true });
    });

export class Server {
    readonly entry: ServerEntry;
    status: Status = "off";
    /** What went wrong, for the owner's page only: it can quote the server's error output. */
    error: string | undefined;
    tools: Tool[] = [];
    /** A sign-in that waits for the owner. */
    signIn: SignIn | undefined;
    readonly #version: string;
    readonly #onChange: () => void;
    readonly #oauth: JsonStore<OAuthStates>;
    readonly #shutdown = new AbortController();
    readonly #auth: ReturnType<typeof connectionAuth> | undefined;
    #challenge: OAuthChallenge | undefined;
    #client: McpClient | undefined;
    #opening: Promise<McpClient> | undefined;
    /** Clients left behind when the server forgot their session: closed with the server. */
    readonly #detached = new Set<McpClient>();
    #starting: Promise<SignIn | undefined> | undefined;
    /** The error output of the last stdio server that failed to connect. */
    #stderr: string | undefined;

    constructor(
        entry: ServerEntry,
        options: { version: string; oauth: JsonStore<OAuthStates>; onChange: () => void },
    ) {
        this.entry = entry;
        this.#version = options.version;
        this.#onChange = options.onChange;
        this.#oauth = options.oauth;

        const http = this.#http;

        this.#auth =
            http && usesOAuth(http)
                ? connectionAuth({
                      serverUrl: http.url,
                      store: serverState(this.#oauth, entry.name, http.url),
                      settings: () => oauthSettings(entry.name, http),
                      onChallenge: (challenge) => {
                          this.#challenge = challenge;
                      },
                  })
                : undefined;
    }

    get name(): string {
        return this.entry.name;
    }

    get closed(): boolean {
        return this.#shutdown.signal.aborted;
    }

    get timeoutMs(): number {
        return (this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
    }

    get #http(): HttpConfig | undefined {
        return "url" in this.entry.config ? this.entry.config : undefined;
    }

    /** Whether the server signs in with OAuth. */
    get oauth(): boolean {
        return this.#auth !== undefined;
    }

    async signedIn(): Promise<boolean> {
        const http = this.#http;

        if (!http || !this.oauth) {
            return false;
        }

        return (await serverState(this.#oauth, this.name, http.url).load())?.tokens !== undefined;
    }

    /** The connected client: the open one, or a new connection. */
    client(): Promise<McpClient> {
        if (this.closed) {
            return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));
        }

        if (this.#client?.connectionState === "connected") {
            return Promise.resolve(this.#client);
        }

        this.#opening ??= this.#open().finally(() => {
            this.#opening = undefined;
        });

        return this.#opening;
    }

    /** Wait at most `ms` for a connection; the connection goes on after that. */
    async ready(ms: number): Promise<void> {
        let timer: NodeJS.Timeout | undefined;

        const connecting = this.client().then(
            () => undefined,
            () => undefined,
        );

        try {
            await Promise.race([
                connecting,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, ms);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Call a tool. A call is never sent again after an error, since the server may have run it: only when the server
     * no longer knows the session (it did not run the call) does it go once more, on a new session.
     */
    async callTool(
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal | undefined,
    ): Promise<CallToolResult> {
        for (let attempt = 1; ; attempt++) {
            const client = await this.client();

            try {
                return await client.callTool(tool, args, {
                    timeoutMs: this.timeoutMs,
                    // Progress from the server makes the time limit start again.
                    onProgress: () => {},
                    ...(signal === undefined ? {} : { signal }),
                });
            } catch (error) {
                if (error instanceof McpSessionExpiredError && attempt === 1) {
                    // Not closed now: that would fail its other calls, which get the same answer and try again.
                    if (this.#client === client) {
                        this.#client = undefined;
                        this.#detached.add(client);
                        // Its other calls have their answers by the time limit of a request: then it goes.
                        setTimeout(
                            () => {
                                this.#detached.delete(client);
                                void client.close().catch(() => undefined);
                            },
                            Math.min(this.timeoutMs, DETACHED_MS),
                        ).unref();
                    }

                    continue;
                }

                if (this.#needsSignIn(error)) {
                    await this.#drop(client);
                    this.#markNeedsSignIn();
                }

                throw error;
            }
        }
    }

    /** Connect again: after a failure, a sign-in, or when the owner asks. */
    async reconnect(): Promise<void> {
        await this.#opening?.catch(() => undefined);

        if (this.#client) {
            await this.#drop(this.#client);
        }

        await this.client();
    }

    /**
     * Start a sign-in, or finish one at once with the stored refresh token. A second tap while one starts gets the same
     * sign-in; a new sign-in cancels the one before.
     */
    startSignIn(): Promise<SignIn | undefined> {
        this.#starting ??= this.#startSignIn().finally(() => {
            this.#starting = undefined;
        });

        return this.#starting;
    }

    async #startSignIn(): Promise<SignIn | undefined> {
        const http = this.#http;

        if (!http || !this.oauth) {
            throw new Error(`MCP server "${this.name}" does not sign in with OAuth`);
        }

        this.signIn?.cancel();
        this.signIn = undefined;

        const signIn = await startSignIn({
            serverUrl: http.url,
            store: serverState(this.#oauth, this.name, http.url),
            settings: await oauthSettings(this.name, http),
            ...(this.#challenge === undefined ? {} : { challenge: this.#challenge }),
        });

        if (this.closed) {
            signIn?.cancel();

            throw new Error(`MCP server "${this.name}" is shut down`);
        }

        if (signIn === undefined) {
            await this.reconnect().catch(() => undefined);

            return undefined;
        }

        this.signIn = signIn;
        this.#onChange();
        signIn.done.then(
            () => {
                if (this.signIn === signIn) {
                    this.signIn = undefined;
                }

                void this.reconnect().catch(() => undefined);
            },
            (error: unknown) => {
                if (this.signIn !== signIn) {
                    return;
                }

                this.signIn = undefined;

                if (!signIn.cancelled) {
                    this.error = `Sign-in failed: ${message(error)}`;
                }

                this.#onChange();
            },
        );

        return signIn;
    }

    /** Remove the stored sign-in, and disconnect. */
    async signOut(): Promise<void> {
        const http = this.#http;

        if (!http || !this.oauth) {
            return;
        }

        this.signIn?.cancel();
        this.signIn = undefined;
        await this.#opening?.catch(() => undefined);

        if (this.#client) {
            await this.#drop(this.#client);
        }

        await serverState(this.#oauth, this.name, http.url).remove();

        if (!this.closed) {
            this.#markNeedsSignIn();
        }
    }

    /** Settles when no process or connection of this server is left, a connection that was still opening too. */
    async close(): Promise<void> {
        this.#shutdown.abort();
        this.signIn?.cancel();
        this.signIn = undefined;
        this.status = "closed";

        const clients = [this.#client, ...this.#detached];

        this.#client = undefined;
        this.#detached.clear();
        await Promise.all([
            ...clients.map((client) => client?.close().catch(() => undefined)),
            this.#opening?.catch(() => undefined),
        ]);
        // A refresh that the server answered may have changed the refresh token: keep it.
        await this.#auth?.settled();
    }

    #needsSignIn(error: unknown): boolean {
        return (
            error instanceof McpOAuthAuthorizationRequiredError ||
            (this.#auth !== undefined && error instanceof McpAuthRequiredError)
        );
    }

    #markNeedsSignIn(): void {
        this.status = "needs-sign-in";
        this.error = undefined;
        this.#onChange();
    }

    async #drop(client: McpClient): Promise<void> {
        if (this.#client === client) {
            this.#client = undefined;
        }

        await client.close().catch(() => undefined);
    }

    async #open(): Promise<McpClient> {
        this.status = "connecting";
        this.#onChange();

        const retries = this.#http ? RETRY_DELAYS_MS : [];

        for (let attempt = 0; ; attempt++) {
            this.#stderr = undefined;

            try {
                return await this.#connectOnce();
            } catch (error) {
                const delay = retries[attempt];

                if (this.closed || delay === undefined || !passing(error)) {
                    throw this.#failed(error);
                }

                await sleep(delay, this.#shutdown.signal);

                if (this.closed) {
                    throw this.#failed(error);
                }
            }
        }
    }

    async #transport(): Promise<StdioTransport | StreamableHttpTransport> {
        const { config, name } = this.entry;

        if ("url" in config) {
            const headers = await resolveRecord(config.headers, `MCP server "${name}" header`);

            return new StreamableHttpTransport({
                url: config.url,
                headers,
                ...(this.#auth === undefined ? {} : { authProvider: this.#auth }),
            });
        }

        const stdio = config as StdioConfig;

        return new StdioTransport({
            command: expandHome(stdio.command),
            args: (stdio.args ?? []).map(expandHome),
            cwd: serverCwd(stdio),
            env: await resolveRecord(stdio.env, `MCP server "${name}" env`),
            stderr: "pipe",
            closeTimeoutMs: CLOSE_TIMEOUT_MS,
        });
    }

    /** One try. A failure keeps the server's last error output, for the owner. */
    async #connectOnce(): Promise<McpClient> {
        const client = new McpClient({
            name: "pi-pocket-mcp",
            version: this.#version,
            requestTimeoutMs: this.timeoutMs,
        });

        let closing: Promise<void> | undefined;

        const closeClient = () => {
            closing ??= client.close().catch(() => undefined);

            return closing;
        };

        this.#shutdown.signal.addEventListener("abort", closeClient, { once: true });

        let transport: StdioTransport | StreamableHttpTransport | undefined;

        try {
            transport = await this.#transport();
            await client.connect(transport);
            client.onNotification("notifications/tools/list_changed", () => {
                void this.#refreshTools(client);
            });

            const stdio = transport instanceof StdioTransport ? transport : undefined;

            client.onClose(() => this.#closedUnder(client, stdio));

            // A server without the tools capability does not answer tools/list.
            const tools = client.serverCapabilities?.tools ? await client.listTools() : [];

            if (this.closed) {
                throw new Error("shut down while connecting");
            }

            if (client.connectionState !== "connected") {
                throw new Error("the connection closed while it was set up");
            }

            this.#client = client;
            this.tools = tools;
            this.status = "connected";
            this.error = undefined;
            // A later sign-in is a new one, not a request for more scope.
            this.#challenge = undefined;
            this.#onChange();

            return client;
        } catch (error) {
            await closeClient();

            if (transport instanceof StdioTransport) {
                this.#stderr = transport.stderr.trim().slice(-STDERR_TAIL) || undefined;
            }

            throw error;
        } finally {
            this.#shutdown.signal.removeEventListener("abort", closeClient);
        }
    }

    #failed(error: unknown): Error {
        const stderr = this.#stderr;

        if (this.#needsSignIn(error) && !this.closed) {
            this.#markNeedsSignIn();

            return new Error(`MCP server "${this.name}" needs a sign-in`);
        }

        this.status = this.closed ? "closed" : "failed";
        this.error = stderr ? `${message(error)}\n${stderr}` : message(error);
        this.#onChange();

        return new Error(`MCP server "${this.name}" failed to connect`);
    }

    /** The connection dropped. The next call opens it again; until then, the page says why. */
    #closedUnder(client: McpClient, stdio: StdioTransport | undefined): void {
        if (this.#client !== client || this.closed) {
            return;
        }

        this.#client = undefined;
        this.status = "disconnected";

        const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL);

        this.error = stderr ? `The connection closed.\n${stderr}` : "The connection closed.";
        this.#onChange();
    }

    async #refreshTools(client: McpClient): Promise<void> {
        let tools: Tool[];

        try {
            tools = await client.listTools();
        } catch (error) {
            tools = this.tools;

            if (this.#client === client) {
                this.error = `Could not list the tools again: ${message(error)}`;
            }
        }

        if (this.#client !== client || this.closed) {
            return;
        }

        this.tools = tools;
        this.#onChange();
    }
}
