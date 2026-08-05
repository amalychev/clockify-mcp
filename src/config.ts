/**
 * Configuration comes from the environment in stdio mode and from request headers
 * in HTTP mode, so the same server works as a local process and as a hosted
 * multi-tenant endpoint.
 *
 * Clockify splits its API across three hosts — the main API, the reports API and
 * the time-off API — so all three are resolved together from one setting.
 */
export interface Config {
  /** Main API root, e.g. https://api.clockify.me/api/v1 */
  apiUrl: string;
  /** Reports API root, e.g. https://reports.api.clockify.me/v1 */
  reportsUrl: string;
  /** Time-off (PTO) API root, e.g. https://pto.api.clockify.me/v1 */
  ptoUrl: string;
  apiKey: string;
  /** Header used to authenticate. Personal API keys use X-Api-Key. */
  authHeader: "X-Api-Key" | "Authorization";
  /** Optional default workspace used when a tool omits workspace_id. */
  defaultWorkspace?: string;
  /**
   * Hard isolation: every tool is confined to `defaultWorkspace`. Requests for
   * any other workspace, and the workspace listing itself, are refused.
   */
  lockToWorkspace: boolean;
  /**
   * IANA zone for wall-clock arguments such as "2026-08-05 09:00". Defaults to
   * the zone configured on the Clockify account, resolved on first use.
   */
  timeZone?: string;
  timeoutMs: number;
  /** Read-only mode: refuse every mutating tool. */
  readOnly: boolean;
}

/** The raw values a caller supplies, before validation and normalisation. */
export interface RawConfig {
  apiKey?: string;
  apiUrl?: string;
  reportsUrl?: string;
  ptoUrl?: string;
  authType?: string;
  workspaceId?: string;
  workspaceLock?: string;
  timeZone?: string;
  readOnly?: string;
  timeoutMs?: string;
}

export class ConfigError extends Error {}

export const DEFAULT_API_URL = "https://api.clockify.me/api/v1";

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Normalises the main API URL: adds https://, drops trailing slashes and appends
 * the `/api/v1` suffix when only the host was given.
 */
export function normalizeApiUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (!/\/api\/v\d+$/.test(url)) url = `${url}/api/v1`;
  return url;
}

/**
 * Derives a sibling API root from the main one. Clockify puts reports on
 * `reports.api.<domain>/v1` and time off on `pto.api.<domain>/v1`, so an
 * on-premise host only has to configure the main URL.
 */
function siblingApi(apiUrl: string, prefix: string): string {
  const { protocol, host } = new URL(apiUrl);
  return `${protocol}//${prefix}.${host}/v1`;
}

export function resolveConfig(raw: RawConfig): Config {
  const apiKey = raw.apiKey?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "No Clockify API key supplied. Create one in Clockify under " +
        "Profile settings → API, at the bottom of the page.",
    );
  }

  const apiUrl = normalizeApiUrl(raw.apiUrl?.trim() || DEFAULT_API_URL);
  const defaultWorkspace = raw.workspaceId?.trim() || undefined;
  const lockToWorkspace = isTrue(raw.workspaceLock);

  if (lockToWorkspace && !defaultWorkspace) {
    throw new ConfigError("Workspace lock was requested without a workspace id.");
  }

  const timeZone = raw.timeZone?.trim() || undefined;
  if (timeZone) assertTimeZone(timeZone);

  return {
    apiUrl,
    reportsUrl: raw.reportsUrl?.trim().replace(/\/+$/, "") || siblingApi(apiUrl, "reports"),
    ptoUrl: raw.ptoUrl?.trim().replace(/\/+$/, "") || siblingApi(apiUrl, "pto"),
    apiKey,
    authHeader: raw.authType?.trim().toLowerCase() === "bearer" ? "Authorization" : "X-Api-Key",
    defaultWorkspace,
    lockToWorkspace,
    timeZone,
    readOnly: isTrue(raw.readOnly),
    timeoutMs: toNumber(raw.timeoutMs, 60_000),
  };
}

/** A wrong zone would otherwise surface much later, as a wrong time entry. */
function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ConfigError(
      `Unknown time zone \`${timeZone}\`. Use an IANA name such as Europe/Zurich or America/New_York.`,
    );
  }
}

/** Configuration for stdio mode, read from the process environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  try {
    return resolveConfig({
      apiKey: env.CLOCKIFY_API_KEY ?? env.CLOCKIFY_KEY ?? env.CLOCKIFY_TOKEN,
      apiUrl: env.CLOCKIFY_API_URL,
      reportsUrl: env.CLOCKIFY_REPORTS_URL,
      ptoUrl: env.CLOCKIFY_PTO_URL,
      authType: env.CLOCKIFY_AUTH_TYPE,
      workspaceId: env.CLOCKIFY_WORKSPACE_ID,
      workspaceLock: env.CLOCKIFY_WORKSPACE_LOCK ?? env.CLOCKIFY_LOCK_WORKSPACE,
      timeZone: env.CLOCKIFY_TIMEZONE ?? env.TZ,
      readOnly: env.CLOCKIFY_READ_ONLY,
      timeoutMs: env.CLOCKIFY_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ConfigError && /No Clockify API key/.test(error.message)) {
      throw new ConfigError(`CLOCKIFY_API_KEY is not set. ${error.message}`);
    }
    if (error instanceof ConfigError && /Workspace lock/.test(error.message)) {
      throw new ConfigError("CLOCKIFY_WORKSPACE_LOCK=true requires CLOCKIFY_WORKSPACE_ID to be set.");
    }
    throw error;
  }
}
