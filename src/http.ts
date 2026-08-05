import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ConfigError, normalizeApiUrl, resolveConfig, type Config } from "./config.js";
import { buildServer } from "./server.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Hostnames that must never be reachable from a hosted deployment (SSRF guard). */
const PRIVATE_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.internal|.*\.local)$/i;

/**
 * Files served next to the landing page: icons, the web manifest and the social
 * preview image. Everything is small, immutable and referenced by the page head,
 * so each entry carries its own content type and cache lifetime.
 */
const STATIC_ASSETS: Record<string, { file: string; type: string; maxAge: number }> = {
  "/favicon.ico": { file: "favicon.ico", type: "image/x-icon", maxAge: 604800 },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml", maxAge: 604800 },
  "/apple-touch-icon.png": { file: "apple-touch-icon.png", type: "image/png", maxAge: 604800 },
  "/icon-192.png": { file: "icon-192.png", type: "image/png", maxAge: 604800 },
  "/icon-512.png": { file: "icon-512.png", type: "image/png", maxAge: 604800 },
  "/og-image.png": { file: "og-image.png", type: "image/png", maxAge: 604800 },
  "/site.webmanifest": { file: "site.webmanifest", type: "application/manifest+json", maxAge: 86400 },
};

export interface HttpOptions {
  port: number;
  host: string;
  /** Absolute path of the landing page served at `/`. */
  landingPath: string;
  /** Directory holding the static assets referenced by the landing page. */
  assetsPath: string;
  /** When set, only these Clockify hosts may be targeted. */
  allowedInstances: string[];
  /** Fallbacks used when a request omits the corresponding header. */
  defaults: {
    apiKey?: string;
    apiUrl?: string;
    workspaceId?: string;
    workspaceLock?: string;
    readOnly?: string;
    timeZone?: string;
    timeoutMs?: string;
  };
}

export function httpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): HttpOptions {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    landingPath: env.LANDING_PATH ?? resolve(here, "..", "landing.html"),
    assetsPath: env.ASSETS_PATH ?? resolve(here, "..", "assets"),
    allowedInstances: (env.CLOCKIFY_ALLOWED_INSTANCES ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    defaults: {
      apiKey: env.CLOCKIFY_API_KEY,
      apiUrl: env.CLOCKIFY_API_URL,
      workspaceId: env.CLOCKIFY_WORKSPACE_ID,
      workspaceLock: env.CLOCKIFY_WORKSPACE_LOCK,
      readOnly: env.CLOCKIFY_READ_ONLY,
      timeZone: env.CLOCKIFY_TIMEZONE,
      timeoutMs: env.CLOCKIFY_TIMEOUT_MS,
    },
  };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A blank header counts as absent, so a configuration template shipped with
 * empty strings falls back to the deployment defaults instead of overriding
 * them with nothing.
 */
function configHeader(req: IncomingMessage, name: string): string | undefined {
  return header(req, name)?.trim() || undefined;
}

/** Bearer tokens are accepted as an alternative to the X-Clockify-Key header. */
function bearerToken(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  const match = auth && /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : undefined;
}

/** Builds a per-request config from headers, falling back to deployment defaults. */
export function configFromRequest(req: IncomingMessage, options: HttpOptions): Config {
  const { defaults } = options;
  const config = resolveConfig({
    apiKey: configHeader(req, "x-clockify-key") ?? bearerToken(req) ?? defaults.apiKey,
    apiUrl: configHeader(req, "x-clockify-url") ?? defaults.apiUrl,
    workspaceId: configHeader(req, "x-clockify-workspace-id") ?? defaults.workspaceId,
    workspaceLock: configHeader(req, "x-clockify-workspace-lock") ?? defaults.workspaceLock,
    readOnly: configHeader(req, "x-clockify-read-only") ?? defaults.readOnly,
    timeZone: configHeader(req, "x-clockify-timezone") ?? defaults.timeZone,
    authType: configHeader(req, "x-clockify-auth-type"),
    timeoutMs: defaults.timeoutMs,
  });

  assertInstanceAllowed(config.apiUrl, options);
  return config;
}

function assertInstanceAllowed(apiUrl: string, options: HttpOptions): void {
  const host = new URL(apiUrl).hostname.toLowerCase();

  if (options.allowedInstances.length > 0) {
    const allowed = options.allowedInstances.some(
      (entry) => host === entry || host === new URL(normalizeApiUrl(entry)).hostname.toLowerCase(),
    );
    if (!allowed) {
      throw new ConfigError(
        `This deployment only serves ${options.allowedInstances.join(", ")}; ${host} is not allowed.`,
      );
    }
    return;
  }

  // Without an explicit allowlist, keep the public endpoint away from internal networks.
  if (PRIVATE_HOST.test(host)) {
    throw new ConfigError(
      `Refusing to connect to the private address ${host}. ` +
        "Run the server locally over stdio to reach an installation on a private network.",
    );
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/** Date of the last landing page change, for <lastmod> in the sitemap. */
async function landingModified(landingPath: string): Promise<string> {
  try {
    const { mtime } = await stat(landingPath);
    return mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Public origin of this deployment, as seen by the visitor. Taken from the
 * request rather than configuration so that a self-hosted copy advertises its
 * own address in robots.txt and sitemap.xml instead of the reference one.
 */
function publicOrigin(req: IncomingMessage): string {
  const forwarded = header(req, "x-forwarded-proto")?.split(",")[0].trim();
  const host = header(req, "x-forwarded-host") ?? header(req, "host") ?? "localhost";
  const protocol = forwarded ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

function sendText(
  req: IncomingMessage,
  res: ServerResponse,
  type: string,
  body: string | Buffer,
  maxAge: number,
): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": payload.byteLength,
    "Cache-Control": `public, max-age=${maxAge}`,
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : payload);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** JSON-RPC shaped error so MCP clients surface the reason instead of "connection failed". */
function sendRpcError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code: status === 401 ? -32001 : -32000, message },
    id: null,
  });
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", header(req, "origin") ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version, " +
      "X-Clockify-Key, X-Clockify-Url, X-Clockify-Workspace-Id, X-Clockify-Workspace-Lock, " +
      "X-Clockify-Read-Only, X-Clockify-Timezone, X-Clockify-Auth-Type",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * Starts the hosted endpoint: the landing page on `/` and a stateless MCP
 * endpoint on `/mcp`, where every request carries its own API key.
 */
export function startHttpServer(
  options: HttpOptions,
  log: (message: string) => void,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handle(req, res, options, log).catch((error: unknown) => {
      log(`unhandled: ${(error as Error).message}`);
      if (!res.headersSent) sendRpcError(res, 500, "Internal server error");
    });
  });

  server.listen(options.port, options.host, () => {
    log(`listening on http://${options.host}:${options.port} (landing on /, MCP on /mcp)`);
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpOptions,
  log: (message: string) => void,
): Promise<void> {
  applyCors(req, res);
  const url = new URL(req.url ?? "/", `http://${header(req, "host") ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const asset = STATIC_ASSETS[url.pathname];
    if (asset) {
      try {
        const body = await readFile(resolve(options.assetsPath, asset.file));
        sendText(req, res, asset.type, body, asset.maxAge);
      } catch {
        sendJson(res, 404, { error: `Asset ${asset.file} not found` });
      }
      return;
    }

    if (url.pathname === "/robots.txt") {
      // The MCP endpoint holds nothing for a crawler, and /health would only
      // add a duplicate JSON page to the index.
      sendText(
        req,
        res,
        "text/plain; charset=utf-8",
        [
          "User-agent: *",
          "Disallow: /mcp",
          "Disallow: /health",
          "",
          `Sitemap: ${publicOrigin(req)}/sitemap.xml`,
          "",
        ].join("\n"),
        86400,
      );
      return;
    }

    if (url.pathname === "/sitemap.xml") {
      sendText(
        req,
        res,
        "application/xml; charset=utf-8",
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
          `  <url>\n    <loc>${publicOrigin(req)}/</loc>\n` +
          `    <lastmod>${await landingModified(options.landingPath)}</lastmod>\n` +
          "    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n" +
          "</urlset>\n",
        3600,
      );
      return;
    }
  }

  // One canonical address for the page, so crawlers never see it twice.
  if (url.pathname === "/index.html") {
    res.writeHead(301, { Location: "/" }).end();
    return;
  }

  if (url.pathname === "/") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendRpcError(res, 405, "Method not allowed");
      return;
    }
    try {
      const page = await readFile(options.landingPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": page.byteLength,
        // Short and revalidated: the page is small, and a stale copy behind a CDN
        // hides a redeploy for as long as it lives.
        "Cache-Control": "public, max-age=60, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
      });
      res.end(req.method === "HEAD" ? undefined : page);
    } catch {
      sendJson(res, 404, { error: "Landing page not found" });
    }
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
    return;
  }

  // Stateless transport: no session to resume, so only POST carries meaning.
  if (req.method !== "POST") {
    sendRpcError(res, 405, "Method not allowed. This endpoint is stateless; use POST.");
    return;
  }

  let config: Config;
  try {
    config = configFromRequest(req, options);
  } catch (error) {
    const message =
      error instanceof ConfigError
        ? error.message
        : `Invalid configuration: ${(error as Error).message}`;
    sendRpcError(res, error instanceof ConfigError ? 401 : 400, message);
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    sendRpcError(res, 400, `Invalid request body: ${(error as Error).message}`);
    return;
  }

  const { server: mcpServer } = buildServer(config);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Plain JSON replies rather than SSE: every tool here is a single request/response,
    // and buffering proxies in front of the deployment cannot break them.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    log(`request failed: ${(error as Error).message}`);
    if (!res.headersSent) sendRpcError(res, 502, (error as Error).message);
  }
}
