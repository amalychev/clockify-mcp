import { createHash } from "node:crypto";
import type { Config } from "./config.js";

export class ClockifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ClockifyError";
  }
}

export type QueryValue = string | number | boolean | undefined | null | (string | number)[];
export type Query = Record<string, QueryValue>;

/** Which of the three Clockify hosts a call goes to. */
export type ApiSurface = "api" | "reports" | "pto";

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  surface?: ApiSurface;
  headers?: Record<string, string>;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  activeWorkspace: string;
  defaultWorkspace: string;
  settings?: { timeZone?: string; weekStart?: string; timeFormat?: string };
}

export interface Workspace {
  id: string;
  name: string;
}

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      // Clockify repeats the plain key for multi-value filters (tags, users, …).
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Resolved accounts, keyed by API root plus a digest of the key. In HTTP mode a
 * client is built per request, and asking Clockify who the caller is on every
 * single call would double the traffic. The key itself is never stored.
 */
const userCache = new Map<string, CurrentUser>();

function cacheKey(config: Config): string {
  return `${config.apiUrl}|${createHash("sha256").update(config.apiKey).digest("hex").slice(0, 32)}`;
}

export class ClockifyClient {
  constructor(readonly config: Config) {}

  get isLocked(): boolean {
    return this.config.lockToWorkspace;
  }

  /** Throws unless `value` is the locked workspace. No-op when unlocked. */
  assertLockedWorkspace(value: string | undefined): void {
    if (!this.config.lockToWorkspace) return;
    if (value === undefined || value === "") return;
    if (value.trim() === this.config.defaultWorkspace) return;
    throw new Error(
      `Refused: this server is locked to workspace ${this.config.defaultWorkspace} ` +
        `(CLOCKIFY_WORKSPACE_LOCK=true), so \`${value}\` is out of scope.`,
    );
  }

  /** Throws when an account-wide operation is attempted in locked mode. */
  assertUnlocked(what: string): void {
    if (!this.config.lockToWorkspace) return;
    throw new Error(
      `Refused: \`${what}\` reaches beyond workspace ${this.config.defaultWorkspace}, ` +
        `and this server runs with CLOCKIFY_WORKSPACE_LOCK=true.`,
    );
  }

  /** The authenticated account, cached for the lifetime of the process. */
  async me(): Promise<CurrentUser> {
    const key = cacheKey(this.config);
    const cached = userCache.get(key);
    if (cached) return cached;
    const user = await this.get<CurrentUser>("/user");
    userCache.set(key, user);
    return user;
  }

  /**
   * Workspace for a call: the argument, then CLOCKIFY_WORKSPACE_ID, then the
   * workspace the account is currently active in — which is what a person means
   * when they do not say.
   */
  async workspaceId(id?: string): Promise<string> {
    this.assertLockedWorkspace(id);
    const resolved = id?.trim() || this.config.defaultWorkspace;
    if (resolved) return resolved;
    const user = await this.me();
    if (!user.activeWorkspace) {
      throw new Error(
        "No workspace specified and the account has no active workspace. " +
          "Pass `workspace_id`, or set CLOCKIFY_WORKSPACE_ID.",
      );
    }
    return user.activeWorkspace;
  }

  /** User for a call: the argument, or the authenticated account. */
  async userId(id?: string): Promise<string> {
    const raw = id?.trim();
    if (raw && raw.toLowerCase() !== "me") return raw;
    return (await this.me()).id;
  }

  /** The zone wall-clock arguments are read in: configured, else the account's. */
  async timeZone(): Promise<string> {
    if (this.config.timeZone) return this.config.timeZone;
    const zone = (await this.me()).settings?.timeZone;
    return zone && zone.trim() ? zone : "UTC";
  }

  private root(surface: ApiSurface): string {
    if (surface === "reports") return this.config.reportsUrl;
    if (surface === "pto") return this.config.ptoUrl;
    return this.config.apiUrl;
  }

  /** Absolute URL for an API path such as `/workspaces/123/projects`. */
  url(path: string, query?: Query, surface: ApiSurface = "api"): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${this.root(surface)}${suffix}${buildQuery(query)}`;
  }

  private authHeaders(): Record<string, string> {
    return this.config.authHeader === "Authorization"
      ? { Authorization: `Bearer ${this.config.apiKey}` }
      : { "X-Api-Key": this.config.apiKey };
  }

  async fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "clockify-mcp",
          ...this.authHeaders(),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        throw new ClockifyError(`Request timed out after ${this.config.timeoutMs}ms`, 408, url);
      }
      throw new ClockifyError(`Network error: ${(error as Error).message}`, 0, url);
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.url(path, options.query, options.surface);
    const init: RequestInit = { method, headers: { ...options.headers } };

    if (options.body !== undefined) {
      init.body = JSON.stringify(options.body);
      init.headers = { ...init.headers, "Content-Type": "application/json" };
    }

    const response = await this.fetchRaw(url, init);
    if (!response.ok) throw await this.toError(response, url);
    return (await this.parse(response)) as T;
  }

  private async parse(response: Response): Promise<unknown> {
    if (response.status === 204) return { ok: true };
    const text = await response.text();
    if (!text) return { ok: true };
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  private async toError(response: Response, url: string): Promise<ClockifyError> {
    const body = await this.parse(response).catch(() => undefined);
    const detail =
      typeof body === "string" ? body.slice(0, 800) : JSON.stringify(body ?? {}).slice(0, 800);
    const hint =
      response.status === 401
        ? " (check the API key — regenerating it in Clockify invalidates the old one)"
        : response.status === 403
          ? " (the plan does not include this feature, or your workspace role is too low — " +
            "reports, expenses, invoices, approvals and custom fields need a paid Clockify plan)"
          : response.status === 404
            ? " (wrong id, or the key's owner is not a member of that workspace)"
            : response.status === 429
              ? " (rate limited — Clockify allows about 50 requests per second per key)"
              : "";
    return new ClockifyError(
      `Clockify API ${response.status} ${response.statusText}${hint}: ${detail}`,
      response.status,
      url,
      body,
    );
  }

  get<T = unknown>(path: string, query?: Query, surface?: ApiSurface) {
    return this.request<T>("GET", path, { query, surface });
  }
  post<T = unknown>(path: string, body?: unknown, query?: Query, surface?: ApiSurface) {
    return this.request<T>("POST", path, { body, query, surface });
  }
  put<T = unknown>(path: string, body?: unknown, query?: Query, surface?: ApiSurface) {
    return this.request<T>("PUT", path, { body, query, surface });
  }
  patch<T = unknown>(path: string, body?: unknown, query?: Query, surface?: ApiSurface) {
    return this.request<T>("PATCH", path, { body, query, surface });
  }
  delete<T = unknown>(path: string, query?: Query, surface?: ApiSurface) {
    return this.request<T>("DELETE", path, { query, surface });
  }

  /**
   * One page of a list endpoint. Clockify sends no pagination headers at all, so
   * "there is probably more" is inferred from a full page coming back.
   */
  async list<T = unknown>(
    path: string,
    query: Query = {},
    surface: ApiSurface = "api",
  ): Promise<{ data: T[]; page: number; pageSize: number; hasMore: boolean }> {
    const page = Number(query.page ?? 1);
    const pageSize = Number(query["page-size"] ?? 50);
    const data = await this.get<T[]>(path, { ...query, page, "page-size": pageSize }, surface);
    const items = Array.isArray(data) ? data : [data as T];
    return { data: items, page, pageSize, hasMore: items.length === pageSize };
  }

  /** Follows pagination until `limit` items are collected. */
  async listAll<T = unknown>(
    path: string,
    query: Query = {},
    limit = 500,
    surface: ApiSurface = "api",
  ): Promise<T[]> {
    const pageSize = Math.min(200, limit);
    const items: T[] = [];
    let page = Number(query.page ?? 1);
    for (;;) {
      const result = await this.list<T>(path, { ...query, page, "page-size": pageSize }, surface);
      items.push(...result.data);
      if (!result.hasMore || items.length >= limit) break;
      page += 1;
    }
    return items.slice(0, limit);
  }
}
