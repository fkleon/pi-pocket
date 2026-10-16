/**
 * A browser reached over the DevTools protocol on a WebSocket, such as a headless-shell container. Pi Pocket does not
 * own the process: `stop` closes the socket, and a browser that stays up serves the next connection. The endpoint is
 * `ws(s)://…` as given, or an `http(s)://…` address whose `/json/version` names the WebSocket.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import {
    BrowserError,
    type BrowserLink,
    type BrowserSource,
    Connection,
    handshake,
} from "./cdp.ts";
import { openSocket, SocketChannel } from "./socket.ts";
import { describe } from "../errors.ts";

/**
 * The URL to reach: for a plain http/ws endpoint, the address its host resolves to. Chromium refuses a `Host` header
 * that is a name rather than an IP (its DNS-rebinding guard), so `http://chromedp:9222` would answer 500. A TLS
 * endpoint keeps its name: its certificate is for the name.
 */
async function reachable(url: string): Promise<string> {
    const parsed = new URL(url);

    if (parsed.protocol === "https:" || parsed.protocol === "wss:" || isIP(parsed.hostname) !== 0) {
        return parsed.toString();
    }

    let address: string;

    try {
        address = (await lookup(parsed.hostname)).address;
    } catch (error) {
        throw new BrowserError(
            `Could not find the browser host ${parsed.hostname}: ${describe(error)}`,
        );
    }

    parsed.host = isIP(address) === 6 ? `[${address}]` : address;

    return parsed.toString();
}

/** The browser-level WebSocket URL for an endpoint. */
export async function resolveEndpoint(url: string, dispatcher?: Agent): Promise<string> {
    const trimmed = url.trim();

    if (/^wss?:\/\//i.test(trimmed)) {
        return reachable(trimmed);
    }

    if (!/^https?:\/\//i.test(trimmed)) {
        throw new BrowserError(`The browser endpoint ${url} must be an http(s) or ws(s) URL.`);
    }

    const version = new URL(trimmed);

    if (!version.pathname.endsWith("/json/version")) {
        version.pathname = `${version.pathname.replace(/\/$/, "")}/json/version`;
    }

    let response: Awaited<ReturnType<typeof fetch>>;

    try {
        response = await fetch(
            await reachable(version.toString()),
            dispatcher === undefined ? {} : { dispatcher },
        );
    } catch (error) {
        throw new BrowserError(`Could not reach the browser at ${url}: ${describe(error)}`);
    }

    if (!response.ok) {
        throw new BrowserError(`The browser at ${url} answered ${response.status}.`);
    }

    const body = (await response.json().catch(() => undefined)) as
        { webSocketDebuggerUrl?: unknown } | undefined;
    const socket = body?.webSocketDebuggerUrl;

    if (typeof socket !== "string" || socket === "") {
        throw new BrowserError(`The browser at ${url} did not offer a DevTools WebSocket.`);
    }

    return reachable(socket);
}

export class RemoteBrowser implements BrowserSource {
    readonly label: string;
    readonly #url: string;
    readonly #dispatcher: Agent;

    constructor(url: string) {
        this.#url = url;
        this.label = url;
        this.#dispatcher = new Agent();
    }

    get available(): boolean {
        return true;
    }

    async connect(): Promise<BrowserLink> {
        const endpoint = await resolveEndpoint(this.#url, this.#dispatcher);
        const socket = await openSocket(endpoint, this.#dispatcher).catch((error: unknown) => {
            throw new BrowserError(
                `Could not connect to the browser at ${endpoint}: ${describe(error)}`,
            );
        });
        const connection = new Connection(new SocketChannel(socket));
        const exited = new Promise<void>((done) => {
            socket.addEventListener("close", () => done());
            socket.addEventListener("error", () => done());
        });
        let userAgent: string;

        try {
            userAgent = await handshake(connection);
        } catch (error) {
            connection.close("The browser did not answer.");

            throw error;
        }

        return {
            connection,
            userAgent,
            exited,
            stop: () => connection.close("Let go of the browser."),
        };
    }
}
