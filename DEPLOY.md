# Running THE MMOFPS

Use Node.js 22.11 or newer and npm. Authenticate Git with an account that can read the private repository, then:

```sh
git clone https://github.com/Zelaron/mmofps-engine.git
cd mmofps-engine
npm ci
npm run build
npm start
```

Open `http://localhost:8080`, or the server's hostname on port 8080. One command starts a gateway/coordinator and three independent world workers. The scripts enable built-in SQLite. Keep `package-lock.json`: `npm ci` installs the recorded dependency versions needed for the build.

The build automatically downloads two fixed-version font files and checks their hashes. Run `npm run assets` to prepare this cache separately. Node dependencies, fonts, bundles, test artifacts and saved data are not committed; a clean clone is sufficient to reproduce the application. The running game serves its assets locally and does not request fonts from Google in players' browsers.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MMOFPS_ROLE` | `cluster` | `cluster` starts gateway/local worlds; `world` starts an external worker; `single` runs the earlier standalone server. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Gateway address, or an external worker's listen address. |
| `DATA_DIR` | `data` in cluster mode | Universe SQLite database and a separate directory per local world. |
| `MAX_PLAYERS` | `64` | Human admission limit per world; not a proven capacity claim. |
| `BOTS` | `15` | Target population; bots step aside for humans. |
| `LOCAL_PLANETS` | `meridian,cinder,nacre` | Worlds supervised locally. An empty value starts only gateway/coordinator. |
| `COORDINATOR_HOST`, `COORDINATOR_PORT` | `127.0.0.1`, free port | Private coordinator interface. |
| `COORDINATOR_SECRET` | generated per local run | Service secret, at least 32 characters. Configure it for external workers. |
| `CLIENT_DIR` | built client directory | Optional static asset override. |

To move Cinder to another machine, run the gateway with `LOCAL_PLANETS=meridian,nacre`, a fixed private coordinator address/port and a configured service secret. On the other machine use the same build with `MMOFPS_ROLE=world`, `PLANET_ID=cinder`, a fresh `WORLD_NODE_ID` for every process start (including restarts), the matching `COORDINATOR_SECRET` and `COORDINATOR_URL=http://<private-gateway-address>:<control-port>`. Set that worker's `HOST`/`PORT`, `NODE_ADVERTISE=ws://<private-worker-address>:<world-port>/ws`, and its own `DATA_DIR`. It registers automatically and appears on the star chart when ready. Retain its world directory when moving; local territory files are not automatically replicated.

Keep coordinator/world interfaces on a private network or behind authenticated TLS tunnels. Browsers connect only to the gateway. A planet currently has one live authority; extra processes for the same planet do not add capacity within it. Use a process supervisor for external workers; the local launcher supervises its children.

Back up the entire data directory. Stop gracefully before copying SQLite, or use its online backup facilities so the WAL is included consistently. Do not copy only a live `.sqlite` file and omit its WAL. Do not run two coordinators against the same database or multiple workers against one world directory. Territory checkpoints are every 30 seconds; characters checkpoint roughly every 2 seconds and transfers commit transactionally.

## Docker

```sh
docker build -t mmofps-engine .
docker run -d --name mmofps --restart unless-stopped --stop-timeout 20 -p 8080:8080 -v mmofps-data:/app/data mmofps-engine
```

The image builds from source, includes the downloaded fonts and runs as the Node image's unprivileged user. The named volume keeps saves across container replacement. Only the gateway port needs publishing. `.dockerignore` excludes installed dependencies, bundles, local captures, credentials and saves from the build context. Docker itself is optional; the Node commands above are the directly verified installation path.

## Linux service and HTTPS

For systemd, put a built checkout at `/opt/mmofps/app`, create a service account named `mmofps`, and give that account ownership of the writable `data/` directory. Adjust the user, checkout path and Node executable in `deploy/mmofps.service` for your host. Install it with:

```sh
sudo cp deploy/mmofps.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mmofps
```

The service template binds the gateway to loopback for a reverse proxy. `deploy/Caddyfile` reads its hostname from Caddy's `DOMAIN` environment variable, with `localhost` as a local default. Set your public hostname, configure its DNS and allow the proxy's HTTP/HTTPS ports before using it publicly. Caddy forwards WebSocket and HTTP traffic to the gateway on port 8080. Direct Node and Docker startup bind to all interfaces by default; their `HOST` setting can be changed as shown above.

To update a checkout, stop the service, back up `data/`, use `git pull --ff-only`, run `npm ci` and `npm run build`, then start the service. `npm run check` can validate an update before starting it. There is no automatic updater or deployment workflow enabled by this repository.

## Compatibility and saved worlds

The current browser protocol is **25**. Since protocol 23, workers reserve durable entity ID blocks before simulation startup. A registered process ID cannot bootstrap again: generate a new UUID at each worker launch. The local cluster launcher already does this. Keep the coordinator database when upgrading; its allocation history prevents a restarted worker from colliding with entities still alive elsewhere. Update clients, the coordinator and all workers together.

Startup migrates saved databases transactionally, including regional camp revisions and renewable resource receipts; retain a consistent pre-upgrade backup. Protocol 24 added authoritative base teleporter layouts, and protocol 25 added resource gathering. Regional camp loading does not enable a partitioned deployment: the current launcher and remaining simulation controllers still use one full authority per planet.
