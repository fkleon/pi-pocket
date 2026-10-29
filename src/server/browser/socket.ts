/** A CDP channel over a WebSocket: each frame is one JSON message. */
import { type Dispatcher, WebSocket } from "undici";
import type { Channel } from "./cdp.ts";

export class SocketChannel implements Channel {
    readonly #socket: WebSocket;
    #closed = false;
    #onMessage: ((message: string) => void) | undefined;
    #onClose: ((reason: string) => void) | undefined;

    constructor(socket: WebSocket) {
        this.#socket = socket;
        socket.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
                this.#onMessage?.(event.data);
            }
        });
        socket.addEventListener("close", () => this.close("The browser closed."));
        socket.addEventListener("error", () => this.close("The browser closed."));
    }

    write(message: string): void {
        if (!this.#closed) {
            this.#socket.send(message);
        }
    }

    onMessage(handler: (message: string) => void): void {
        this.#onMessage = handler;
    }

    onClose(handler: (reason: string) => void): void {
        this.#onClose = handler;
    }

    close(reason: string): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;

        try {
            this.#socket.close();
        } catch {
            // Already closing or closed.
        }

        this.#onClose?.(reason);
    }
}

/** A WebSocket to `url`, awaited until it is open. `dispatcher` keeps a private endpoint off the proxy. */
export async function openSocket(url: string, dispatcher?: Dispatcher): Promise<WebSocket> {
    const socket = new WebSocket(url, dispatcher === undefined ? undefined : { dispatcher });

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}.`)));
    });

    return socket;
}
