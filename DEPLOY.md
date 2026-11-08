# Running THE MMOFPS

Use Node.js 22.11 or newer and npm, then:

```sh
git clone https://github.com/Zelaron/mmofps-engine.git
cd mmofps-engine
npm ci
npm run build
npm start
```

Open `http://localhost:8080`, or the server's hostname on port 8080. One command starts a gateway/coordinator and the enabled world workers (Meridian by default; `PLANETS=all` adds Cinder and Nacre). The scripts enable built-in SQLite. Keep `package-lock.json`: `npm ci` installs the recorded dependency versions needed for the build.

The build automatically downloads two fixed-version font files and checks their hashes. Run `npm run assets` to prepare this cache separately. Node dependencies, fonts, bundles, test artifacts and saved data are not committed; a clean clone is sufficient to reproduce the application. The running game serves its assets locally and does not request fonts from Google in players' browsers.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MMOFPS_ROLE` | `cluster` | `cluster` starts gateway/local worlds; `world` starts an external worker; `single` runs the earlier standalone server. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Gateway address, or an external worker's listen address. |
| `DATA_DIR` | `data` in cluster mode | Universe SQLite database and a separate directory per local world. |
| `MAX_PLAYERS` | `64` | Human admission limit per world; not a proven capacity claim. |
| `BOTS` | `192` | Maximum bot-filled population target per planet, including humans. Default adaptive range: 96-192. |
| `SESSION_COOKIE_SECURE` | unset | Set to `1` when browsers use HTTPS through a reverse proxy; marks the anonymous session cookie `Secure`. Leave unset for direct local HTTP. |
| `PLANETS` | `meridian` | Worlds that make up the universe: `all`, or a list such as `meridian,cinder`. The first is the entry world; characters saved on a world outside the list return there with their inventory. The star chart and orbital travel stay hidden while only one world is enabled. |
| `LOCAL_PLANETS` | every enabled world | Enabled worlds supervised locally (must be a subset of `PLANETS`). An empty value starts only gateway/coordinator. |
| `COORDINATOR_HOST`, `COORDINATOR_PORT` | `127.0.0.1`, free port | Private coordinator interface. |
| `COORDINATOR_SECRET` | generated per local run | Service secret, at least 32 characters. Configure it for external workers. |
| `CLIENT_DIR` | built client directory | Optional static asset override. |

To move Cinder to another machine, run the gateway with `PLANETS=all LOCAL_PLANETS=meridian,nacre`, a fixed private coordinator address/port and a configured service secret. On the other machine use the same build with `MMOFPS_ROLE=world`, `PLANET_ID=cinder`, a fresh `WORLD_NODE_ID` for every process start (including restarts), the matching `COORDINATOR_SECRET` and `COORDINATOR_URL=http://<private-gateway-address>:<control-port>`. Set that worker's `HOST`/`PORT`, `NODE_ADVERTISE=ws://<private-worker-address>:<world-port>/ws`, and its own `DATA_DIR`. Start it with the V8 options the local launcher gives its worlds, which lower simulation cost without changing results: `node --experimental-sqlite --max-semi-space-size=64 --max-inlined-bytecode-size-cumulative=11040 --max-inlined-bytecode-size-absolute=22080 packages/server/dist/server.cjs`. It registers automatically and appears on the star chart when ready. Retain its world directory when moving; local territory files are not automatically replicated.

Keep coordinator/world interfaces on a private network or behind authenticated TLS tunnels. Browsers connect only to the gateway. A planet currently has one live authority; extra processes for the same planet do not add capacity within it. Use a process supervisor for external workers; the local launcher supervises its children.

Back up the entire data directory. Stop gracefully before copying SQLite, or use its online backup facilities so the WAL is included consistently. Do not copy only a live `.sqlite` file and omit its WAL. Do not run two coordinators against the same database or multiple workers against one world directory. Territory checkpoints are every 30 seconds; characters checkpoint roughly every 2 seconds and transfers commit transactionally.

## Docker

```sh
docker build -t mmofps-engine .
docker run -d --name mmofps --restart unless-stopped --stop-timeout 20 -p 8080:8080 -v mmofps-data:/app/data mmofps-engine
```

The image builds from source, includes the downloaded fonts, uses the same maximum adaptive population of 192 as the Node and systemd configurations, and runs as the Node image's unprivileged user. The named volume keeps saves across container replacement. Only the gateway port needs publishing. For public hosting, put HTTPS in front of the container and set `SESSION_COOKIE_SECURE=1`; the direct HTTP command above is for local use. `.dockerignore` excludes installed dependencies, bundles, local captures, credentials and saves from the build context. Docker itself is optional; the Node commands above are the directly verified installation path.

## Linux service with weekly updates

This is how mmofps.com runs: a systemd service behind an HTTPS reverse proxy, updated from GitHub every Monday at 08:00 UTC.

Layout under `/opt/mmofps`:

| Path | Contents |
| --- | --- |
| `node/` | Node.js 22 for the game only (the system's Node is left alone) |
| `releases/<commit>/` | One built and tested checkout per version |
| `current` | Symlink to the running release |
| `data/` | Saved characters and worlds, shared by every release |
| `bin/update.sh` | Installed copy of `deploy/update.sh` |
| `home/` | Home directory of the `mmofps` service user (npm cache) |

Install once, as root:

```sh
useradd --system --home-dir /opt/mmofps/home --shell /usr/sbin/nologin mmofps
mkdir -p /opt/mmofps/{node,releases,data,bin,home}
chown mmofps: /opt/mmofps/{releases,data,home}
# Unpack a Node.js 22 linux-x64 tarball into /opt/mmofps/node (check its SHA256).
install -m 755 deploy/update.sh /opt/mmofps/bin/update.sh
cp deploy/mmofps.service deploy/mmofps-update.service deploy/mmofps-update.timer /etc/systemd/system/
systemctl daemon-reload
/opt/mmofps/bin/update.sh            # first build, test and start
systemctl enable mmofps mmofps-update.timer
systemctl start mmofps-update.timer
```

`update.sh` clones the newest `main` into a new release folder, then runs `npm ci`, `npm run build` and `npm run check` as the `mmofps` user. Only if all of that passes does it switch `current` and restart the game. If the new version doesn't report healthy within two minutes, it switches back to the previous release. It keeps the last three releases. Its output is in `journalctl -u mmofps-update`.

The updater runs from its installed copy, so a push to the repository cannot change it. After changing `deploy/update.sh`, review it and copy it to `/opt/mmofps/bin/` again.

**Resource limits.** `mmofps.service` caps the game at two CPU cores and 3 GB of memory. When the machine is busy, the game gets half the CPU share of an ordinary service. The update runs at the lowest CPU and disk priority. Adjust `BOTS` in the service to trade bots for CPU.

**HTTPS.** The service listens on `127.0.0.1:8080` and sets `SESSION_COOKIE_SECURE=1`. For Apache, add `deploy/apache-mmofps.conf` inside the site's HTTPS `<VirtualHost>`. It forwards WebSockets and keeps `/.well-known/` on disk for certificate renewal. For Caddy, `deploy/Caddyfile` does the same with automatic certificates.

## Compatibility and saved worlds

The current browser protocol is **35**. Since protocol 23, workers reserve durable entity ID blocks before simulation startup. A registered process ID cannot bootstrap again: generate a new UUID at each worker launch. The local cluster launcher already does this. Keep the coordinator database when upgrading; its allocation history prevents a restarted worker from colliding with entities still alive elsewhere. Update clients, the coordinator and all workers together.

Startup migrates saved databases transactionally, including regional camp revisions and renewable resource receipts; retain a consistent pre-upgrade backup. Protocol 24 added authoritative base teleporter layouts, and protocol 25 added resource gathering. Regional camp loading does not enable a partitioned deployment: the current launcher and remaining simulation controllers still use one full authority per planet.
