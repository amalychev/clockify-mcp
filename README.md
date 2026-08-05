# Clockify MCP

An MCP server for [Clockify](https://clockify.me) — timers, time entries, projects, tasks, tags,
people, reports and time off, over the Model Context Protocol.

**61 tools**, plus `clockify_api_request` — a generic escape hatch to any Clockify endpoint that has
no dedicated tool, across all three of its API hosts.

The headline feature: **times are given the way people say them**. `09:00`, `yesterday`, `2h30m` —
resolved in the account's own time zone, across daylight-saving boundaries, so an entry lands on the
day you meant. Projects, tasks and tags can be named instead of addressed by id.

---

## Two ways to run it

| Mode | Transport | Configuration comes from | Use it when |
|---|---|---|---|
| **Hosted** | Streamable HTTP on `/mcp` | request headers, per call | clients should connect to a URL with nothing installed |
| **Local** | stdio | environment variables | credentials must not leave the machine |

The public deployment lives at `https://clockify-mcp.webapace.ink` — the landing page on `/`, the
MCP endpoint on `/mcp`. Connecting to it needs no install:

```bash
claude mcp add --transport http clockify \
  https://clockify-mcp.webapace.ink/mcp \
  --header "X-Clockify-Key: YOUR_API_KEY"
```

Or write the configuration yourself. The same object goes into `.mcp.json` in a repository,
`~/.claude.json`, `claude_desktop_config.json` or `.cursor/mcp.json` — fill in the blanks:

```json
{
  "mcpServers": {
    "clockify": {
      "type": "http",
      "url": "https://clockify-mcp.webapace.ink/mcp",
      "headers": {
        "X-Clockify-Key": "",
        "X-Clockify-Workspace-Id": "",
        "X-Clockify-Project-Id": ""
      }
    }
  }
}
```

| Header | Fill in with | If left empty |
|---|---|---|
| `X-Clockify-Key` | your personal API key | the request is refused — this one is required |
| `X-Clockify-Workspace-Id` | a workspace id from `clockify_list_workspaces` | the workspace the account is active in |
| `X-Clockify-Project-Id` | the project this connection logs to | every entry needs its own project, or lands without one |

[Where the ids come from](#where-the-ids-come-from) walks through finding all three values in
Clockify.

`X-Clockify-Workspace-Lock`, `X-Clockify-Read-Only` and `X-Clockify-Timezone` can be added the same
way; see [Hosted mode](#hosted-mode) for the full header list.

Keep the file out of version control, or write `"X-Clockify-Key": "${CLOCKIFY_API_KEY}"` — Claude
Code and Cursor substitute environment variables, so the secret stays in your shell.

Two things worth knowing when a change appears to do nothing:

- In Claude Code an entry added to the **local** scope (kept in `~/.claude.json`) takes precedence
  over the project's `.mcp.json`. `claude mcp list` shows what is actually in use, and
  `claude mcp remove <name> -s local` drops a stale one.
- Client configuration is read at startup, so restart the app after editing the file.

The rest of this document is for running your own copy in either mode.

---

## Install

```bash
git clone https://github.com/amalychev/clockify-mcp
cd clockify-mcp
npm install
npm run build
```

Requires Node.js 20 or newer.

### API key

Clockify → your avatar → **Profile settings** → scroll to the bottom → **API** → **Generate**.

The key carries every permission your account has, in every workspace you belong to; Clockify has no
scoped keys. Regenerating it in that screen invalidates the old one immediately, which is the way to
revoke a leaked key.

What needs a **paid** Clockify plan, and returns `403` on the free one: the Reports API
(`clockify_summary_report`, `clockify_detailed_report`, `clockify_weekly_report`), expenses,
invoices, approvals and custom fields. Everything else — timers, entries, projects, tasks, tags,
people, holidays, time off — works on the free plan, and `clockify_time_summary` produces totals
without the Reports API by adding up the entries themselves.

### Where the ids come from

The key is the only value that is required. A workspace id and a project id are what turn a generic
connection into one that logs to the right place without being told every time.

**Workspace id.** Clockify → **Settings** in the left sidebar. The address bar becomes
`https://app.clockify.me/workspaces/5e8395d5261ba37dee85a378/settings` — the 24-character chunk in
the middle is the id. From the terminal instead:

```bash
curl -s -H "X-Api-Key: $CLOCKIFY_API_KEY" https://api.clockify.me/api/v1/workspaces \
  | jq -r '.[] | "\(.id)  \(.name)"'
```

**Project id.** Clockify → **Projects** → open the project. The address bar becomes
`https://app.clockify.me/projects/60f9c8b1a2d4e51f3c7b8a29/…`; again, the 24-character chunk is the
id. Or list the active projects of a workspace:

```bash
curl -s -H "X-Api-Key: $CLOCKIFY_API_KEY" \
  "https://api.clockify.me/api/v1/workspaces/<workspaceId>/projects?archived=false&page-size=200" \
  | jq -r '.[] | "\(.id)  \(.name)"'
```

**Or ask the assistant.** With the server already connected on the key alone, `clockify_whoami`
reports the account, the active workspace and how the server is configured, `clockify_list_workspaces`
returns every workspace with its id, and `clockify_find_project` searches projects by part of a name.
Put the values into the configuration and restart the client, which reads it only at startup.

`CLOCKIFY_PROJECT_ID` and `X-Clockify-Project-Id` accept a project **name** as well — `Velocorner
Frontend` rather than `60f9c8…` — resolved once against the workspace, and refused if it matches
several projects. A name does not survive a rename, so prefer the id for anything long-lived.

---

## Configuration

In stdio mode everything is configured through environment variables.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CLOCKIFY_API_KEY` | yes | — | Personal API key |
| `CLOCKIFY_WORKSPACE_ID` | no | active workspace | Default workspace for every tool |
| `CLOCKIFY_WORKSPACE_LOCK` | no | `false` | `true` — hard isolation inside `CLOCKIFY_WORKSPACE_ID` |
| `CLOCKIFY_PROJECT_ID` | no | — | Default project for new entries; an id or an unambiguous project name |
| `CLOCKIFY_READ_ONLY` | no | `false` | `true` — every mutating tool is refused |
| `CLOCKIFY_TIMEZONE` | no | account setting | IANA zone for wall-clock arguments |
| `CLOCKIFY_API_URL` | no | `https://api.clockify.me/api/v1` | Main API root; a bare host gets `/api/v1` appended |
| `CLOCKIFY_REPORTS_URL` | no | derived | Reports API root, normally `reports.api.…/v1` |
| `CLOCKIFY_PTO_URL` | no | derived | Time-off API root, normally `pto.api.…/v1` |
| `CLOCKIFY_AUTH_TYPE` | no | `api-key` | `bearer` — send the key as `Authorization: Bearer` |
| `CLOCKIFY_TIMEOUT_MS` | no | `60000` | Per-request timeout |

Aliases that are also read: `CLOCKIFY_KEY` / `CLOCKIFY_TOKEN` for the key, `TZ` for the zone,
`CLOCKIFY_LOCK_WORKSPACE` for the lock, `CLOCKIFY_DEFAULT_PROJECT` for the project.

### Connecting a local copy

```bash
claude mcp add clockify \
  --env CLOCKIFY_API_KEY=xxxxxxxx \
  -- node /absolute/path/clockify-mcp/dist/index.js
```

Or in `.mcp.json`, so the configuration travels with the project:

```json
{
  "mcpServers": {
    "clockify": {
      "command": "node",
      "args": ["/absolute/path/clockify-mcp/dist/index.js"],
      "env": {
        "CLOCKIFY_API_KEY": "xxxxxxxx",
        "CLOCKIFY_WORKSPACE_ID": "5e8395d5261ba37dee85a378",
        "CLOCKIFY_WORKSPACE_LOCK": "true",
        "CLOCKIFY_PROJECT_ID": "60f9c8b1a2d4e51f3c7b8a29"
      }
    }
  }
}
```

To verify the connection, ask for `clockify_whoami` — it returns the account, the active workspace,
the time zone in use and how this server is configured.

---

## Times, durations and names

This is what the server does beyond wrapping the API, and where most of its logic lives.

**Instants.** Anywhere a tool takes a time:

| You write | It means |
|---|---|
| `now` | this moment |
| `09:00` | that wall-clock time, on the day the tool is working with |
| `2026-08-05 09:00` | that wall-clock time on that date |
| `2026-08-05` | midnight local |
| `2026-08-05T07:00:00Z` | exactly that instant — zone handling is skipped |

Values without a zone are resolved in the account's zone, looked up once per session from the
Clockify profile and overridable with `CLOCKIFY_TIMEZONE`. The offset is computed for that specific
date, so an entry on a daylight-saving switchover lands at the wall-clock time you asked for.

**Dates.** `today`, `yesterday` and `tomorrow` work wherever a date is accepted, and are resolved in
the same zone rather than the server's.

**Durations.** `2h30m`, `1.5h`, `90m`, `PT2H30M`, or a bare number, which is read as minutes.

**Names instead of ids.** `project_name`, `task_name` and `tag_names` are accepted alongside the id
arguments. An exact name wins; an ambiguous one is an error listing the candidates, because guessing
would book hours to the wrong client.

---

## Hosted mode

Start the HTTP transport with `MCP_TRANSPORT=http` (or `--http`). It serves:

| Route | Purpose |
|---|---|
| `GET /` | the landing page (`landing.html`, or `LANDING_PATH`) |
| `POST /mcp` | the MCP endpoint, stateless — one server instance per request |
| `GET /health` | liveness probe |
| `GET /robots.txt`, `/sitemap.xml` | generated per request from the `Host` header, so a self-hosted copy advertises its own address |
| `GET /favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, `/og-image.png`, `/site.webmanifest` | static files from `assets/` (or `ASSETS_PATH`), cached for a week |

`GET /index.html` redirects to `/` so the page has a single canonical address.

Every request carries its own credentials, so one deployment serves many people without holding
state:

| Header | Maps to | Notes |
|---|---|---|
| `X-Clockify-Key` | `CLOCKIFY_API_KEY` | required unless the deployment sets a default; `Authorization: Bearer <key>` is accepted instead |
| `X-Clockify-Workspace-Id` | `CLOCKIFY_WORKSPACE_ID` | default workspace |
| `X-Clockify-Workspace-Lock` | `CLOCKIFY_WORKSPACE_LOCK` | `true` locks the session to that workspace |
| `X-Clockify-Project-Id` | `CLOCKIFY_PROJECT_ID` | default project for new entries; a project name works too |
| `X-Clockify-Read-Only` | `CLOCKIFY_READ_ONLY` | `true` refuses every mutating tool |
| `X-Clockify-Timezone` | `CLOCKIFY_TIMEZONE` | IANA zone for wall-clock arguments |
| `X-Clockify-Url` | `CLOCKIFY_API_URL` | on-premise installations |
| `X-Clockify-Auth-Type` | `CLOCKIFY_AUTH_TYPE` | `bearer` for OAuth-style tokens |

A blank header counts as absent, so a template shipped with empty strings falls back to the
deployment defaults. Timeouts are deliberately **not** header-controlled: they are process-wide and
belong to whoever runs the deployment.

Deployment settings:

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `http` to start the HTTP server |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `LANDING_PATH` | `./landing.html` | page served at `/` |
| `ASSETS_PATH` | `./assets` | icons, manifest and preview image |
| `CLOCKIFY_ALLOWED_INSTANCES` | — | comma-separated hostnames; when set, only these may be targeted |
| `CLOCKIFY_API_KEY`, … | — | fallbacks used when the corresponding header is absent |

Without an allowlist the server refuses private addresses (`localhost`, RFC 1918 ranges,
`169.254.*`, `*.internal`, `*.local`) so a public deployment cannot be used to probe the network it
runs in.

```bash
docker build -t clockify-mcp .
docker run -p 8080:8080 clockify-mcp
```

### Deploying

`deploy.sh` does the whole cycle on the server — pull, build, swap the container, verify, purge the
CDN cache:

```bash
./deploy.sh                # the usual deploy
./deploy.sh --page-only    # only replace landing.html and assets/ in the running container
./deploy.sh --no-pull      # deploy the working tree as it is
./deploy.sh --logs         # follow the container log afterwards
```

Copy `deploy.env.example` to `deploy.env` on the server and set the container name, `PUBLIC_URL`
and, if the site sits behind Cloudflare, a zone id and an API token with the Cache Purge permission.
`deploy.env` is git-ignored, so server-specific values stay there.

When a `docker-compose.yml` sits next to the script, it drives Compose instead of `docker run`:
building through `docker compose build`, swapping with `docker compose up -d`, and health-checking
from inside the container, because a Compose service behind a reverse proxy publishes no host port.
Compose names the container itself — usually `<project>-app-1` — so put that exact name in
`deploy.env`, or the health check addresses nothing.

The previous image is tagged `:previous` before every build, and a failed health check restores it
automatically and exits non-zero, so a broken build never stays deployed.

### Landing page assets

`assets/` holds everything the page references: `favicon.svg` (the source of every raster icon),
`favicon.ico`, the touch and PWA icons, `site.webmanifest`, and `og-image.png` — the 1200×630
preview used by link unfurlers, rendered from `assets/og-card.html`.

The PNG and ICO files are committed, so a normal build needs nothing extra. Regenerate them only
after editing `favicon.svg` or `og-card.html`:

```bash
npm run assets      # headless Chrome does the rasterising; set CHROME=… if it is not found
```

The page carries a description, canonical URL, Open Graph and Twitter cards, and JSON-LD
(`SoftwareApplication`, `WebSite`, `FAQPage`). Those absolute URLs point at
`clockify-mcp.webapace.ink`; a self-hosted copy that should be indexed under its own name needs them
replaced in `landing.html` — `robots.txt` and `sitemap.xml` already follow the request host.

Because the endpoint accepts API keys from callers, put it behind TLS and treat access logs
accordingly. The server itself keeps nothing: no sessions, no storage, one throwaway server instance
per request.

---

## Scoping: workspace and project

Most people belong to more than one workspace, and an assistant that wanders into the wrong one
logs hours against the wrong client. Two levels of confinement, plus a default project inside them:

**A default workspace.** `CLOCKIFY_WORKSPACE_ID` (or `X-Clockify-Workspace-Id`) is used whenever a
tool omits `workspace_id`. Other workspaces stay reachable by asking for them explicitly.

**A hard lock.** Add `CLOCKIFY_WORKSPACE_LOCK=true` and the workspace becomes the only one that
exists:

- every tool that takes `workspace_id` refuses any other value;
- `clockify_list_workspaces` is refused outright;
- `clockify_api_request` must address `/workspaces/<the locked id>/…`, with only `/user` exempt.

The refusal is explicit, so the assistant reports the boundary instead of silently returning nothing:

```
Refused: this server is locked to workspace 5e8395… (CLOCKIFY_WORKSPACE_LOCK=true),
so `61ab…` is out of scope.
```

Read-only mode is the orthogonal control: `CLOCKIFY_READ_ONLY=true` refuses every tool that writes,
including non-GET calls through `clockify_api_request`.

### A default project

`CLOCKIFY_PROJECT_ID`, or `X-Clockify-Project-Id` in hosted mode, names the project new time entries
belong to. `clockify_start_timer`, `clockify_log_time` and `clockify_log_many` use it whenever the
call itself carries no `project_id` or `project_name` — so a connection set up for one repository
logs into that repository's project, and nobody has to repeat the name in every request. A project
given in the call still wins, and `task_name` can then be resolved on its own, because the project it
belongs to is already known.

It is a default, not a lock. Reading tools are unaffected: `clockify_list_time_entries` and
`clockify_time_summary` still cover the whole workspace unless a project is asked for, which is what
makes "what did I do today" answer honestly. `clockify_update_time_entry` ignores it as well — an
edit to a description would otherwise quietly move the entry to another project.

Alongside `CLOCKIFY_WORKSPACE_LOCK` it gives a per-project connection: the workspace is the only one
reachable, and everything logged inside it lands on one project by default.

---

## Tools

61 tools. Names are stable; the assistant picks them, so this list is for knowing what is possible.

### Time entries and timers

| Tool | Purpose |
|---|---|
| `clockify_current_timer` | the running timer and how long it has been going |
| `clockify_start_timer` | start the clock |
| `clockify_stop_timer` | stop it and return the finished entry |
| `clockify_log_time` | write one finished entry from local times |
| `clockify_log_many` | write a whole workday in one call, reporting each entry |
| `clockify_list_time_entries` | entries for a day or range, with a total |
| `clockify_time_summary` | totals per project, task, day or tag — no paid plan needed |
| `clockify_get_time_entry` | one entry in full |
| `clockify_update_time_entry` | change description, project, tags or times |
| `clockify_delete_time_entry` | delete one, with `confirm: true` |

### Projects, clients, tasks, tags

| Tool | Purpose |
|---|---|
| `clockify_list_projects`, `clockify_find_project`, `clockify_get_project` | find and inspect projects |
| `clockify_create_project`, `clockify_update_project`, `clockify_delete_project` | manage them; archiving is `update` with `archived: true` |
| `clockify_list_clients`, `clockify_create_client`, `clockify_update_client`, `clockify_delete_client` | clients |
| `clockify_list_tasks`, `clockify_get_task`, `clockify_create_task`, `clockify_update_task`, `clockify_delete_task` | tasks inside a project |
| `clockify_list_tags`, `clockify_create_tag`, `clockify_update_tag`, `clockify_delete_tag` | tags |

### People and workspaces

| Tool | Purpose |
|---|---|
| `clockify_whoami` | account, active workspace, time zone, server configuration |
| `clockify_list_workspaces`, `clockify_get_workspace` | workspaces |
| `clockify_workspace_users`, `clockify_find_user` | members and their ids |
| `clockify_invite_user`, `clockify_set_user_status`, `clockify_remove_user` | membership |
| `clockify_list_user_groups`, `clockify_create_user_group`, `clockify_update_user_group`, `clockify_delete_user_group` | teams |
| `clockify_add_user_to_group`, `clockify_remove_user_from_group` | team membership |

### Reports — paid plan

| Tool | Purpose |
|---|---|
| `clockify_summary_report` | totals grouped as in the Clockify summary report |
| `clockify_detailed_report` | every entry in the range, one row each |
| `clockify_weekly_report` | the weekly grid |

### Time off and approvals

| Tool | Purpose |
|---|---|
| `clockify_list_holidays`, `clockify_create_holiday`, `clockify_delete_holiday` | the holiday calendar |
| `clockify_list_time_off_policies`, `clockify_time_off_balance` | policies and remaining days |
| `clockify_list_time_off_requests`, `clockify_request_time_off` | requests |
| `clockify_list_approval_requests`, `clockify_submit_approval` | timesheet approvals — paid plan |

### Everything else

| Tool | Purpose |
|---|---|
| `clockify_list_custom_fields`, `clockify_list_expenses`, `clockify_create_expense`, `clockify_list_invoices`, `clockify_list_webhooks` | paid-plan features |
| `clockify_api_request` | any endpoint, on any of the three API hosts, honouring read-only and the workspace lock |

---

## Development

```
src/
  config.ts            environment and header configuration, validation
  time.ts              wall clock ↔ UTC, durations, human formatting
  clockify-client.ts   HTTP, pagination, errors, workspace resolution and lock
  server.ts            builds the MCP server and registers every tool module
  http.ts              hosted transport: landing page, static assets, /mcp
  index.ts             entry point, picks stdio or HTTP
  tools/
    helpers.ts         defineTool, shared argument shapes, read-only guard
    resolve.ts         name → id lookups for projects, tasks and tags
    core.ts            identity, workspaces, members
    time-entries.ts    timers, logging, listing, summarising
    projects.ts        projects and clients
    tasks.ts           tasks
    tags.ts            tags
    users.ts           membership and groups
    reports.ts         the Reports API
    timeoff.ts         holidays, policies, requests, approvals
    misc.ts            paid-plan corners and the raw API escape hatch
```

```bash
npm run dev        # tsc --watch
npm run typecheck  # no emit
npm run assets     # regenerate icons and the social card
```

Adding a tool means one `defineTool` call in the right module: it wires up the input schema, the
read-only guard and uniform error handling, so the handler only makes the Clockify call.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` | wrong key, or it was regenerated in Clockify, which invalidates the old one |
| `403` | the feature needs a paid plan, or your workspace role is too low |
| `404` | wrong id, or the key's owner is not a member of that workspace |
| `429` | Clockify allows about 50 requests a second per key |
| Entries on the wrong day | check the zone `clockify_whoami` reports; override with `CLOCKIFY_TIMEZONE` |
| `matches 3 projects` | the name was ambiguous; use the exact name or the id |
| `The configured default project … could not be used` | `CLOCKIFY_PROJECT_ID` holds a name that matches no live project in the workspace, or several |
| Entries land without a project | no `CLOCKIFY_PROJECT_ID` is set, or the entry named one that resolved elsewhere; `clockify_whoami` shows the default in use |
| `Refused: … CLOCKIFY_READ_ONLY` | working as intended |
| `Refused: … CLOCKIFY_WORKSPACE_LOCK` | working as intended |
