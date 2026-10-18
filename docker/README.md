# Running Pi Pocket with Docker Compose

`docker-compose.yml` at the repository root runs Pi Pocket with a browser of its own and gates every outbound
request through an allowlist. The app runs unprivileged on a read-only root filesystem; the browser, the HTTP proxy,
and DNS each run in a container of their own. Only the reverse proxy is reachable from outside.

This page describes the stack. The short version is in the repository's README:

```bash
docker compose up --build
```

Then open the published address on the Docker host: <http://localhost:8787>.

## Requirements

- **Docker Engine 29 or newer.** The app image uses `COPY --parents`, which older engines do not understand.
- **Docker Compose v5** (`docker compose`).
- About 3 GB of memory for the stack, most of it for the browser.

## Services

| Service         | Built from / image                   | Networks           | Purpose                                                      |
| --------------- | ------------------------------------ | ------------------ | ------------------------------------------------------------ |
| `gateway`       | `docker/tinyproxy.Dockerfile`        | internal, edge     | HTTP and HTTPS egress through a domain allowlist             |
| `dns-forwarder` | `docker/dnsmasq.Dockerfile`          | internal, edge     | DNS, forwarding only the allowlisted domains                 |
| `chrome`        | `chromedp/headless-shell:latest`     | internal           | the browser behind the Browser panel and Pi's `browser` tool |
| `app`           | `docker/Dockerfile`                  | internal           | Pi Pocket, running as `nonroot` (uid 65532)                  |
| `ingress`       | `nginxinc/nginx-unprivileged:alpine` | frontend, internal | reverse proxy; the only published port                       |

## Network isolation

Three networks separate ingress, the app, and egress. Only `edge` has a route to the internet, and only `ingress` is
reachable from the host.

```
                              host / LAN
                                  │
                          published :8787
                                  │
                                  ▼
                    ┌───────────────────────────┐
                    │ ingress                   │
                    │ nginx-unprivileged        │
                    │ frontend + internal       │
                    └─────────────┬─────────────┘
                                  │ http://app:8787
  ────────────────────────────────┼─────────────────────────────────────
  internal · 172.28.0.0/24 · internal: true — no route out
  ────────────────────────────────┼─────────────────────────────────────
                                  ▼
     ┌───────────────────────┐           ┌───────────────────────┐
     │ app                   │  CDP:9222 │ chrome                │
     │ Pi Pocket (nonroot)   ├──────────▶│ headless-shell        │
     │ /workspace (rw)       │           │ 172.28.0.10 (ro)      │
     │                       │           │ /workspace (ro)       │
     └───────────┬───────────┘           └───────────┬───────────┘
                 │                                   │
                 │ proxy :8888 / DNS :53             │ proxy :8888 / DNS :53
                 ▼                                   ▼
     ┌───────────────────────┐           ┌───────────────────────┐
     │ gateway               │           │ dns-forwarder         │
     │ tinyproxy             │           │ dnsmasq .11           │
     └───────────┬───────────┘           └───────────┬───────────┘
  ───────────────┼───────────────────────────────────┼──────────────
  edge · the only network with a route to the internet
  ───────────────┼───────────────────────────────────┼──────────────
                 └────────────────┬──────────────────┘
                                  ▼
                              the internet
```

What can talk to what:

| From            | To              | Port | What                               |
| --------------- | --------------- | ---- | ---------------------------------- |
| host            | `ingress`       | 8787 | the published app                  |
| `ingress`       | `app`           | 8787 | reverse proxy                      |
| `app`           | `chrome`        | 9222 | the DevTools protocol              |
| `app`           | `gateway`       | 8888 | HTTP and HTTPS proxy               |
| `app`           | `dns-forwarder` | 53   | DNS                                |
| `chrome`        | `gateway`       | 8888 | page loads                         |
| `chrome`        | `dns-forwarder` | 53   | DNS                                |
| `gateway`       | internet        | 443  | proxied egress (`ConnectPort 443`) |
| `dns-forwarder` | internet        | 53   | upstream DNS for allowlisted names |

What cannot happen:

- `app` and `chrome` cannot reach the internet directly. They are on `internal`, which has no route out; their only
  way out is `gateway`.
- `chrome`'s DevTools port 9222 is never published, and the endpoint has no authentication.
- 8787 is the only published port, and only `ingress` is on `frontend`.

## The egress allowlist

Two files gate egress, and both must allow a domain:

- `docker/dnsmasq.conf` forwards only the domains listed with `server=/example.com/#`; every other name gets
  NXDOMAIN. Subdomains are included.
- `docker/tinyproxy.allowlist.conf` is a list of POSIX basic regular expressions matched against the host, with
  `FilterDefaultDeny Yes`: only matching hosts pass.

The defaults allow `radius.earendil.com` (an example provider) and `google.com`. Replace them with the domains your
models use. If a provider is missing from either file, runs against it fail: DNS refuses the name, or the proxy
refuses the connection.

After editing either file, recreate the services so they read the new config:

```bash
docker compose up -d --force-recreate gateway dns-forwarder
```

## Data and the workspace

Four named volumes hold everything that must survive a container:

| Volume           | Mounted at                 | Holds                                                                   |
| ---------------- | -------------------------- | ----------------------------------------------------------------------- |
| `pi-home`        | `/home/nonroot`            | `$HOME`: git config, SSH keys, package caches, and other per-user state |
| `pi-data`        | `/home/nonroot/.pi`        | Pi's sign-ins, models, skills, and sessions                             |
| `pi-pocket-data` | `/home/nonroot/.pi-pocket` | Pi Pocket's `config.json`, `pocket.sqlite`, drop-ins, and themes        |
| `pi-workspace`   | `/workspace`               | the folder new sessions start in                                        |

None of them bind to a host folder by default. `pi-workspace` is a named volume, not `./workspace`. To work on a host
folder instead, replace the `pi-workspace` mount in `docker-compose.yml` with a bind mount, and make it writable by
the app's user:

```
    volumes:
      - pi-home:/home/nonroot
      - pi-data:/home/nonroot/.pi
      - pi-pocket-data:/home/nonroot/.pi-pocket
      - ./workspace:/workspace
```

```bash
mkdir -p workspace && sudo chown -R 65532:65532 workspace
```

Copy files out of the workspace volume, or back in:

```bash
docker compose cp app:/workspace/. ./workspace/
docker compose cp ./workspace/. app:/workspace/
```

## Security

- **The browser endpoint has no authentication.** Anyone who can reach port 9222 controls the browser and can read
  every page's cookies and files. It stays on `internal`, and port 9222 is not published.
- **Lancet Guard is off.** The compose sets `PI_POCKET_GUARD=off`. Remove the line to turn the guard on, and
  allowlist any host it needs.
- **Read-only root filesystem.** Every service runs with `read_only: true`, `cap_drop: [ALL]`, and
  `no-new-privileges`.
- **Default-deny egress.** A process that escapes the app still cannot reach the internet except through the
  allowlisted proxy.
- **The sign-in link is in the logs.** `docker compose logs app` prints the owner's sign-in link. Keep it private,
  as you would on the host.

## Operations

```bash
docker compose up -d --build      # start; builds the three local images
docker compose logs -f app        # watch, and read the sign-in link
docker compose ps                 # health of gateway and dns-forwarder
docker compose down               # stop; the volumes stay
docker compose down -v            # stop and delete the volumes too
```

`gateway` and `dns-forwarder` must pass their healthchecks before `app` and `chrome` start. The launcher prints the
address it detects inside the container; open the published one instead: `http://localhost:8787` on the Docker host,
or `http://<host>:8787` from the network.

## Caveats

- The images are not pinned to digests. Pin them for a reproducible build.
- The app image installs `git` and `ca-certificates` on a Debian base, so Pi's shell tools work. It does not install
  a browser: that is the `chrome` service.
- `chrome` is capped at 2 GB of memory, 1 GB of shared memory, and 256 processes. Lower `shm_size` only together
  with `--disable-dev-shm-usage`.
