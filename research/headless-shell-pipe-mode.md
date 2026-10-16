# `chromedp/headless-shell` and CDP pipe mode

## Finding

The published `chromedp/headless-shell:latest` image does **not use CDP pipe mode by default**. Its entrypoint starts `headless-shell` with `--remote-debugging-address=0.0.0.0` and `--remote-debugging-port=9223`; it also starts `socat` to forward port 9222 to 9223. The image exposes both ports. This is a TCP debugging endpoint, not the private stdin/stdout pipe Pi Pocket currently expects.

The image's `run.sh` appends extra command-line arguments, but its baked-in port flags remain. Simply adding `--remote-debugging-pipe` as a container argument therefore does not turn the shipped setup into a pipe-mode configuration. Using a pipe would require replacing the entrypoint and wiring the browser process's pipe file descriptors to its client; separate containers do not share a child's stdio pipe in the ordinary Docker service setup.

For Pi Pocket, the practical choices are:

1. Keep launching Chromium/headless-shell as a child of Pi Pocket with `--remote-debugging-pipe` (the current transport design), or
2. Run headless-shell as a separate service and adapt Pi Pocket's CDP transport to connect to its WebSocket endpoint.

## Sources

- Official image entrypoint: [`run.sh`](https://github.com/chromedp/docker-headless-shell/blob/main/run.sh) — starts `socat` forwarding `9222` to `127.0.0.1:9223`, then launches headless-shell with the remote debugging address and port flags.
- Official image container recipe: [`Containerfile`](https://github.com/chromedp/docker-headless-shell/blob/main/Containerfile) — exposes ports 9222 and 9223 and uses `/headless-shell/run.sh` as its entrypoint.
- Official image documentation: [README](https://github.com/chromedp/docker-headless-shell/blob/main/README.md) — describes the image as a CDP browser container and documents publishing port 9222.
- Pi Pocket transport: [`src/server/browser/cdp.ts`](../src/server/browser/cdp.ts) — launches the browser child with `--remote-debugging-pipe`; its `Connection` writes to and reads from the child pipes, using file descriptors 3 and 4.
