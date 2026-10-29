// The CDP transport: pipe framing, the WebSocket channel's mapping, and endpoint discovery.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, test } from "node:test";
import { Agent } from "undici";
import { PipeChannel } from "../src/server/browser/cdp.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { RemoteBrowser, resolveEndpoint } from "../src/server/browser/remote.ts";
import { SocketChannel } from "../src/server/browser/socket.ts";

test("the pipe channel frames NUL-delimited messages, split or together", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const channel = new PipeChannel(out, input);
    const seen: string[] = [];
    const written: string[] = [];

    channel.onMessage((message) => seen.push(message));
    out.on("data", (chunk: Buffer) => written.push(chunk.toString()));

    // One chunk holding two messages, then a third split across chunks.
    input.write('{"id":1}\0{"id":2}\0{"id');
    input.write('":3}\0');
    await new Promise((done) => setImmediate(done));

    assert.deepEqual(seen, ['{"id":1}', '{"id":2}', '{"id":3}']);

    channel.write("hello");
    assert.equal(written.join(""), "hello\0");
});

test("the pipe channel closes once, whatever ends it", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const channel = new PipeChannel(out, input);
    const reasons: string[] = [];

    channel.onClose((reason) => reasons.push(reason));
    input.destroy();
    await new Promise((done) => setImmediate(done));
    channel.close("again");
    assert.deepEqual(reasons, ["The browser closed."]);
});

/** A stand-in for a WebSocket: records what was sent, and lets a test fire its events. */
function fakeSocket() {
    const listeners = new Map<string, ((event: unknown) => void)[]>();
    const sent: string[] = [];
    let closed = false;

    return {
        sent,
        wasClosed: () => closed,
        addEventListener: (type: string, listener: (event: never) => void) => {
            const list = listeners.get(type) ?? [];

            list.push(listener as (event: unknown) => void);
            listeners.set(type, list);
        },
        send: (data: string) => sent.push(data),
        close: () => {
            closed = true;
        },
        emit: (type: string, event: unknown) => {
            for (const listener of listeners.get(type) ?? []) {
                listener(event);
            }
        },
    };
}

test("the socket channel maps messages, and closes once", () => {
    const socket = fakeSocket();
    const channel = new SocketChannel(socket as never);
    const seen: string[] = [];
    const reasons: string[] = [];

    channel.onMessage((message) => seen.push(message));
    channel.onClose((reason) => reasons.push(reason));
    socket.emit("message", { data: '{"id":1}' });
    socket.emit("message", { data: new Uint8Array([1]) });
    channel.write("ping");

    assert.deepEqual(seen, ['{"id":1}'], "only text frames are messages");
    assert.deepEqual(socket.sent, ["ping"]);

    channel.close("done");
    channel.close("again");

    assert.deepEqual(reasons, ["done"]);
    assert.equal(socket.wasClosed(), true);
});

let site: Server;
let base: string;

before(async () => {
    site = createServer((request, response) => {
        if (request.url === "/json/version") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/b/x" }));
        } else if (request.url === "/json/version?empty=1") {
            response.end(JSON.stringify({ Browser: "Chrome/1" }));
        } else {
            response.statusCode = 500;
            response.end("no");
        }
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});

after(() => site.close());

test("a browser endpoint becomes its WebSocket URL", async () => {
    const dispatcher = new Agent();

    assert.equal(await resolveEndpoint(base, dispatcher), "ws://127.0.0.1:1/devtools/b/x");
    assert.equal(
        await resolveEndpoint(`${base}/json/version`, dispatcher),
        "ws://127.0.0.1:1/devtools/b/x",
    );
    assert.equal(
        await resolveEndpoint("ws://127.0.0.1:9222/devtools/b/y", dispatcher),
        "ws://127.0.0.1:9222/devtools/b/y",
    );
    await assert.rejects(resolveEndpoint("not a url", dispatcher), /http\(s\) or ws\(s\)/);
    await assert.rejects(
        resolveEndpoint(`${base}/json/version?empty=1`, dispatcher),
        /did not offer/,
    );
    await assert.rejects(resolveEndpoint(`${base}/nope`, dispatcher), /answered 500/);
});

// The whole remote path against real Chrome: its own debugging port, and the WebSocket transport.
test(
    "a browser reached over its WebSocket answers the handshake",
    { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false },
    async () => {
        const child = spawn(
            findBrowser()!,
            [
                "--headless=new",
                "--remote-debugging-port=0",
                "--no-first-run",
                `--user-data-dir=${mkdtempSync(join(tmpdir(), "pi-cdp-"))}`,
                "about:blank",
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
        );

        try {
            const url = await new Promise<string>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("no DevTools URL")), 20_000);
                let text = "";

                child.stderr!.setEncoding("utf8");
                child.stderr!.on("data", (chunk: string) => {
                    text += chunk;
                    const found = /ws:\/\/\S+/.exec(text);

                    if (found !== null) {
                        clearTimeout(timer);
                        resolve(found[0]);
                    }
                });
                child.once("exit", () => {
                    clearTimeout(timer);
                    reject(new Error("the browser exited"));
                });
            });
            const link = await new RemoteBrowser(url).connect();

            try {
                assert.equal(link.connection.closed, false);
                assert.ok(link.userAgent.length > 0, "the handshake gave a user agent");
            } finally {
                link.stop();
            }
        } finally {
            child.kill("SIGKILL");
        }
    },
);
