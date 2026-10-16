/**
 * The built-in browser: one headless Chromium on this machine, driven over the DevTools protocol through a pipe, with a
 * page per conversation that Pi (the `browser` tool) and the people in the conversation (the Browser panel) share.
 * People see the page as a stream of JPEG frames and send it taps, scrolls, and keys. The page runs on this machine, not
 * in their own browser: it does not share their app tab or its cookies, and pages only this machine can reach (a dev
 * server on localhost) work from a phone too.
 *
 * Each conversation's page lives in a browser context of its own: cookies and storage are not shared between
 * conversations. Pages are memory only: a restart closes them, and each conversation's last address and size come back
 * from its saved state when its page is next opened.
 */
import { BrowserError, LocalBrowser, type BrowserLink, type BrowserSource } from "./browser/cdp.ts";
import { RemoteBrowser } from "./browser/remote.ts";
import { findBrowser, profileFolder } from "./browser/discovery.ts";
import { BrowserPage, type BrowserState, type Saved, wait } from "./browser/page.ts";
import { type Viewport, VIEWPORTS, viewportFrom } from "./browser/viewport.ts";
import { describe } from "./errors.ts";

/** How long to wait before the first reconnect, and the longest between tries. */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export type OpenOptions = {
    /** The size of a page that has no saved size. */
    viewport?: Viewport;
    /** Open the saved address again (default), or (false) start blank. */
    restore?: boolean;
    /** Wait for the saved address to load (default), or (false) only start loading it. */
    wait?: boolean;
};

export interface BrowsersOptions {
    /** Where the browser's profile goes: `browser/` in it. */
    dataDir: string;
    /** The browser to connect to, instead of one found on this machine. */
    source?: BrowserSource;
    /** The browser to run. Undefined finds one; null means there is none (tests). */
    executable?: string | null;
    /** Extra Chromium flags, such as `--no-sandbox` where sandboxes are not available. */
    args?: readonly string[];
    /** A conversation's saved address and size, to open its page again. */
    load?(conversationId: number): Promise<Saved | undefined>;
    /** Called when a page's address or size changed. */
    save?(conversationId: number, saved: Saved): void;
    log?(line: string): void;
    /** A page nobody used or watched for this long closes. */
    idleMs?: number;
}

/**
 * The browser and every conversation's page. The browser starts with the first page and stops a while after the last
 * one closes; pages close after a while unused.
 */
export class Browsers {
    readonly #options: BrowsersOptions;
    #executable: string | null | undefined;
    #link: Promise<BrowserLink> | undefined;
    /** The source, worked out once: `null` means there is none. */
    #sourceCache: BrowserSource | undefined | null = null;
    readonly #pages = new Map<number, BrowserPage>();
    /** The browser contexts this app made, to tell its targets from a shared browser's others. */
    readonly #contexts = new Set<string>();
    /** Conversations whose pages should be open: kept across a drop, to reopen them. */
    readonly #wanted = new Set<number>();
    #reconnect: NodeJS.Timeout | undefined;
    #reconnectAttempt = 0;
    readonly #opening = new Map<number, Promise<BrowserPage>>();
    readonly #listeners = new Set<(conversationId: number, state: BrowserState) => void>();
    readonly #pending = new Map<number, NodeJS.Timeout>();
    readonly #problems = new Map<number, string>();
    readonly #reaper: NodeJS.Timeout;
    #idleSince = Date.now();
    #closing = false;
    /** Counts every closeAll: a page that began opening before one must not open after it. */
    #generation = 0;

    constructor(options: BrowsersOptions) {
        this.#options = options;
        this.#executable = options.executable;
        this.#reaper = setInterval(() => this.#reap(), 60_000);
        this.#reaper.unref();
    }

    /** The browser this machine has, if any. Looked up once. */
    get executable(): string | undefined {
        if (this.#executable === undefined) {
            this.#executable = findBrowser() ?? null;
        }

        return this.#executable ?? undefined;
    }

    /** Where the browser comes from: one given, a CDP endpoint, or Chromium on this machine. */
    #source(): BrowserSource | undefined {
        if (this.#sourceCache === null) {
            this.#sourceCache = this.#findSource() ?? undefined;
        }

        return this.#sourceCache;
    }

    #findSource(): BrowserSource | undefined {
        if (this.#options.source !== undefined) {
            return this.#options.source;
        }

        const endpoint = process.env.PI_POCKET_BROWSER_URL?.trim();

        if (endpoint !== undefined && endpoint !== "") {
            return new RemoteBrowser(endpoint);
        }

        const executable = this.executable;

        if (executable === undefined) {
            return undefined;
        }

        const extra = [
            ...(this.#options.args ?? []),
            ...(process.env.PI_POCKET_BROWSER_ARGS?.split(/\s+/).filter(Boolean) ?? []),
        ];

        return new LocalBrowser(
            executable,
            profileFolder(executable, this.#options.dataDir),
            extra,
        );
    }

    get available(): boolean {
        return this.#source()?.available ?? false;
    }

    /** Whether the browser is one Pi Pocket reaches over CDP, not one it starts. */
    get remote(): boolean {
        return this.#source() instanceof RemoteBrowser;
    }

    subscribe(listener: (conversationId: number, state: BrowserState) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** A conversation's page as it is now; a closed one has no address. */
    state(conversationId: number): BrowserState {
        const page = this.#pages.get(conversationId);

        if (page !== undefined && !page.closed) {
            return page.state(this.available);
        }

        const problem = this.#problems.get(conversationId);

        return {
            available: this.available,
            open: false,
            url: "",
            title: "",
            loading: this.#opening.has(conversationId),
            viewport: { ...VIEWPORTS.desktop },
            preset: "desktop",
            canGoBack: false,
            canGoForward: false,
            errors: 0,
            logs: 0,
            ...(problem === undefined ? {} : { problem }),
        };
    }

    /** The conversation's page if it is open. */
    page(conversationId: number): BrowserPage | undefined {
        const page = this.#pages.get(conversationId);

        return page === undefined || page.closed ? undefined : page;
    }

    /** Coalesce a page's changes: frames of logs and loads arrive in bursts. */
    #changed(conversationId: number): void {
        if (this.#pending.has(conversationId)) {
            return;
        }

        const timer = setTimeout(() => {
            this.#pending.delete(conversationId);
            const state = this.state(conversationId);

            for (const listener of this.#listeners) {
                listener(conversationId, state);
            }
        }, 120);

        timer.unref();
        this.#pending.set(conversationId, timer);
    }

    async #browser(): Promise<BrowserLink> {
        const source = this.#source();

        if (source === undefined) {
            throw new BrowserError(
                "No Chromium-based browser was found on this machine. Install Chromium or Google Chrome, or set PI_POCKET_BROWSER to a browser's path, or PI_POCKET_BROWSER_URL to a DevTools endpoint.",
            );
        }

        if (this.#link !== undefined) {
            const running = await this.#link.catch(() => undefined);

            if (running !== undefined && !running.connection.closed) {
                return running;
            }
        }

        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        const connecting = source.connect();

        this.#link = connecting;
        connecting.catch(() => {
            if (this.#link === connecting) {
                this.#link = undefined;
            }
        });
        const link = await connecting;

        // The server began stopping while the browser started: nothing will stop this one later.
        if (this.#closing) {
            link.stop();

            throw new BrowserError("The server is stopping.");
        }

        this.#options.log?.(`Browser started: ${source.label}`);

        link.connection.onEvent = (method, params) => {
            if (!method.startsWith("Target.")) {
                return;
            }

            const info =
                params.targetInfo ??
                (method === "Target.targetDestroyed" ? { targetId: params.targetId } : undefined);

            if (info === undefined) {
                return;
            }

            // A shared browser reports every target; only the contexts this app made are ours.
            if (info.browserContextId !== undefined && !this.#contexts.has(info.browserContextId)) {
                return;
            }

            for (const [id, page] of this.#pages) {
                // A page closed by its own script (window.close()) is gone, with its browser context.
                if (method === "Target.targetDestroyed" && info.targetId === page.targetId) {
                    void this.#discard(id, page);
                } else {
                    page.targetEvent(method, info);
                }
            }
        };

        link.connection.onClose = () => {
            // A link this app already let go of (stopped, or closed on purpose) is not one to bring back.
            const dropped = this.#link === connecting;

            if (dropped) {
                this.#link = undefined;
            }

            for (const page of this.#pages.values()) {
                page.close();
            }

            if (dropped) {
                this.#pages.clear();

                if (this.#wanted.size > 0) {
                    this.#scheduleReconnect();
                }
            }
        };

        return link;
    }

    /**
     * The conversation's page, opened (and its saved address loaded again) if it was not. `viewport` sizes a page that
     * has no saved size.
     */
    async open(conversationId: number, options: OpenOptions = {}): Promise<BrowserPage> {
        if (this.#closing) {
            throw new BrowserError("The server is stopping.");
        }

        const open = this.page(conversationId);

        if (open !== undefined) {
            return open;
        }

        const opening = this.#opening.get(conversationId);

        if (opening !== undefined) {
            return opening;
        }

        const created = this.#create(conversationId, options);

        this.#opening.set(conversationId, created);
        this.#changed(conversationId);

        try {
            const page = await created;

            this.#problems.delete(conversationId);

            return page;
        } catch (error) {
            this.#problems.set(conversationId, describe(error));

            throw error;
        } finally {
            this.#opening.delete(conversationId);
            this.#changed(conversationId);
        }
    }

    async #create(conversationId: number, options: OpenOptions): Promise<BrowserPage> {
        const generation = this.#generation;
        const stale = () => this.#closing || this.#generation !== generation;
        const saved = await this.#options.load?.(conversationId).catch(() => undefined);

        if (stale()) {
            throw new BrowserError("The browser was closed.");
        }

        const link = await this.#browser();
        const connection = link.connection;
        const { browserContextId } = await connection.send("Target.createBrowserContext", {
            disposeOnDetach: false,
        });

        this.#contexts.add(browserContextId);
        let page: BrowserPage | undefined;

        try {
            await connection
                .send("Browser.setDownloadBehavior", { behavior: "deny", browserContextId })
                .catch(() => {});
            const { targetId } = await connection.send("Target.createTarget", {
                url: "about:blank",
                browserContextId,
            });
            const { sessionId } = await connection.send("Target.attachToTarget", {
                targetId,
                flatten: true,
            });

            page = new BrowserPage({
                conversationId,
                connection,
                session: sessionId,
                target: targetId,
                context: browserContextId,
                userAgent: link.userAgent,
                viewport: viewportFrom(saved?.viewport) ??
                    options.viewport ?? { ...VIEWPORTS.desktop },
                changed: () => this.#changed(conversationId),
                saved: (value) => this.#options.save?.(conversationId, value),
            });
            await page.init();

            if (stale()) {
                page.close();

                throw new BrowserError("The browser was closed.");
            }

            this.#pages.set(conversationId, page);
            this.#wanted.add(conversationId);
            this.#idleSince = Date.now();

            if (options.restore !== false && saved?.url !== undefined && saved.url !== "") {
                const restoring = page.navigate(saved.url, { timeoutMs: 15_000 }).catch(() => {});

                if (options.wait !== false) {
                    await restoring;
                }
            }

            return page;
        } catch (error) {
            page?.close();
            this.#contexts.delete(browserContextId);
            void connection
                .send("Target.disposeBrowserContext", { browserContextId })
                .catch(() => {});

            throw error;
        }
    }

    /** Close a conversation's page. Its saved address stays, to open it again later. */
    async close(conversationId: number): Promise<void> {
        const page = this.#pages.get(conversationId);

        if (page !== undefined) {
            await this.#discard(conversationId, page);
        }
    }

    /** Forget a page and free its browser context, which holds its cookies and storage. */
    async #discard(conversationId: number, page: BrowserPage): Promise<void> {
        if (this.#pages.get(conversationId) === page) {
            this.#pages.delete(conversationId);
        }

        this.#wanted.delete(conversationId);
        page.close();
        this.#contexts.delete(page.contextId);

        if (this.#pages.size === 0) {
            this.#idleSince = Date.now();
        }

        this.#changed(conversationId);
        const link = await this.#link?.catch(() => undefined);

        await link?.connection
            .send("Target.disposeBrowserContext", { browserContextId: page.contextId })
            .catch(() => {});
    }

    #reap(): void {
        const idle = this.#options.idleMs ?? 30 * 60_000;

        for (const [id, page] of this.#pages) {
            if (page.closed || Date.now() - page.usedAt > idle) {
                void this.#discard(id, page);
            }
        }

        // The browser itself stops a few minutes after its last page closed.
        if (
            this.#pages.size === 0 &&
            this.#opening.size === 0 &&
            this.#link !== undefined &&
            Date.now() - this.#idleSince > 5 * 60_000
        ) {
            void this.#stopBrowser();
        }
    }

    /** Bring the browser back after an unexpected drop, and reopen the pages that were open. */
    #scheduleReconnect(): void {
        if (this.#reconnect !== undefined || this.#closing) {
            return;
        }

        const delay = Math.min(
            RECONNECT_MAX_MS,
            RECONNECT_BASE_MS * 2 ** Math.min(this.#reconnectAttempt, 5),
        );

        this.#reconnectAttempt++;
        const timer = setTimeout(() => {
            this.#reconnect = undefined;
            void this.#reconnectNow();
        }, delay);

        timer.unref();
        this.#reconnect = timer;
    }

    async #reconnectNow(): Promise<void> {
        if (this.#closing || this.#wanted.size === 0) {
            return;
        }

        try {
            await this.#browser();
        } catch (error) {
            this.#options.log?.(`Could not reach the browser again: ${describe(error)}`);
            this.#scheduleReconnect();

            return;
        }

        this.#reconnectAttempt = 0;
        this.#options.log?.("Browser reconnected.");

        for (const id of [...this.#wanted]) {
            if (this.#closing || !this.#wanted.has(id)) {
                continue;
            }

            try {
                await this.open(id, { restore: true });
            } catch {
                // The page could not open; it stays wanted, and the next drop tries again.
            }
        }
    }

    async #stopBrowser(): Promise<void> {
        const pending = this.#link;

        this.#link = undefined;
        const link = await pending?.catch(() => undefined);

        if (link === undefined) {
            return;
        }

        link.stop();
        await Promise.race([link.exited, wait(4000)]);
    }

    /** Close every page and stop the browser, as the server stops or the browser is turned off. */
    async closeAll(options: { final?: boolean } = {}): Promise<void> {
        this.#generation++;

        if (this.#reconnect !== undefined) {
            clearTimeout(this.#reconnect);
            this.#reconnect = undefined;
        }

        this.#reconnectAttempt = 0;
        this.#wanted.clear();

        if (options.final === true) {
            this.#closing = true;
            clearInterval(this.#reaper);
        }

        const ids = [...this.#pages.keys()];

        for (const page of this.#pages.values()) {
            page.close();
        }

        this.#pages.clear();
        this.#contexts.clear();

        if (options.final === true) {
            // After the pages closed, which announces them: nobody listens any more.
            for (const timer of this.#pending.values()) {
                clearTimeout(timer);
            }

            this.#pending.clear();
        }

        await this.#stopBrowser();

        if (options.final !== true) {
            for (const id of ids) {
                this.#changed(id);
            }
        }
    }
}
