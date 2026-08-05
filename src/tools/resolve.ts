import type { ClockifyClient } from "../clockify-client.js";

/**
 * Name-to-id lookups. People say "log two hours to Velocorner Frontend", not
 * "log two hours to 5f2a…", so every tool that takes an id also takes a name and
 * resolves it here. An ambiguous name is an error listing the candidates rather
 * than a silent guess at the wrong project.
 */

interface Named {
  id: string;
  name: string;
  archived?: boolean;
}

function pick(candidates: Named[], name: string, kind: string): string {
  const needle = name.trim().toLowerCase();
  const exact = candidates.filter((item) => item.name?.toLowerCase() === needle);
  const matches = exact.length > 0 ? exact : candidates;

  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    throw new Error(`No ${kind} named \`${name}\` in this workspace.`);
  }
  const names = matches.slice(0, 12).map((item) => `${item.name} (${item.id})`).join(", ");
  throw new Error(
    `\`${name}\` matches ${matches.length} ${kind}s: ${names}. Use the exact name or pass the id.`,
  );
}

export async function resolveProjectId(
  client: ClockifyClient,
  workspaceId: string,
  projectId?: string,
  projectName?: string,
): Promise<string | undefined> {
  if (projectId?.trim()) return projectId.trim();
  if (!projectName?.trim()) return undefined;

  const candidates = await client.listAll<Named>(
    `/workspaces/${workspaceId}/projects`,
    { name: projectName.trim(), archived: false },
    200,
  );
  return pick(candidates, projectName, "project");
}

/** Clockify hands out MongoDB object ids; anything else was meant as a name. */
const CLOCKIFY_ID = /^[0-9a-f]{24}$/i;

/**
 * Resolved default projects, keyed by workspace and configured value. In HTTP
 * mode a client is built per request, so a name given as the default would
 * otherwise cost a project lookup on every entry written.
 */
const defaultProjectCache = new Map<string, string>();

/**
 * The project a write falls back to when the call names none — `CLOCKIFY_PROJECT_ID`
 * in stdio mode, `X-Clockify-Project-Id` over HTTP. An id is used as it stands, a
 * name is looked up once per workspace.
 */
export async function defaultProjectId(
  client: ClockifyClient,
  workspaceId: string,
): Promise<string | undefined> {
  const configured = client.config.defaultProject?.trim();
  if (!configured) return undefined;
  if (CLOCKIFY_ID.test(configured)) return configured;

  const key = `${workspaceId}|${configured.toLowerCase()}`;
  const cached = defaultProjectCache.get(key);
  if (cached) return cached;

  let resolved: string;
  try {
    resolved = (await resolveProjectId(client, workspaceId, undefined, configured))!;
  } catch (error) {
    throw new Error(
      `The configured default project (CLOCKIFY_PROJECT_ID / X-Clockify-Project-Id = ` +
        `\`${configured}\`) could not be used: ${(error as Error).message}`,
    );
  }
  defaultProjectCache.set(key, resolved);
  return resolved;
}

export async function resolveTaskId(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string | undefined,
  taskId?: string,
  taskName?: string,
): Promise<string | undefined> {
  if (taskId?.trim()) return taskId.trim();
  if (!taskName?.trim()) return undefined;
  if (!projectId) throw new Error("A task name can only be resolved together with a project.");

  const candidates = await client.listAll<Named>(
    `/workspaces/${workspaceId}/projects/${projectId}/tasks`,
    { name: taskName.trim() },
    200,
  );
  return pick(candidates, taskName, "task");
}

export async function resolveTagIds(
  client: ClockifyClient,
  workspaceId: string,
  tagIds?: string[],
  tagNames?: string[],
): Promise<string[] | undefined> {
  const ids = [...(tagIds ?? [])];
  if (tagNames?.length) {
    const all = await client.listAll<Named>(`/workspaces/${workspaceId}/tags`, {}, 500);
    for (const name of tagNames) {
      ids.push(pick(all.filter((tag) => tag.name?.toLowerCase().includes(name.trim().toLowerCase())), name, "tag"));
    }
  }
  return ids.length ? ids : undefined;
}
