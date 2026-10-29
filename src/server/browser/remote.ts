/**
 * A browser reached over the DevTools protocol on a WebSocket, such as a headless-shell container. Pi Pocket does not
 * own the process: `stop` closes the socket, and a browser that stays up serves the next connection. The endpoint is
 * `ws(s)://…` as given, or an `http(s)://…` address whose `/json/version` names the WebSocket.
 */
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

/** The browser-level WebSocket URL for an endpoint. */
export async function resolveEndpoint(url: string, dispatcher?: Agent): Promise<string> {
    const trimmed = url.trim();

    if (/^wss?:\/\//i.test(trimmed)) {
        return trimmed;
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
        response = await fetch(version, dispatcher === undefined ? {} : { dispatcher });
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

    return socket;
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
