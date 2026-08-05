import { z } from "zod";
import type { Workspace } from "../clockify-client.js";
import { today } from "../time.js";
import { defineTool, json, pagingShape, paged, workspaceShape, type ToolContext } from "./helpers.js";

/** Identity, workspaces and the settings every other tool depends on. */
export function registerCoreTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_whoami",
    {},
    {
      title: "Who am I",
      description:
        "The account behind the API key: name, email, active workspace, time zone, and how this " +
        "server is configured (workspace lock, read-only). Start here when anything looks wrong.",
      readOnly: true,
    },
    async () => {
      const user = await client.me();
      const timeZone = await client.timeZone();
      return json({
        user: { id: user.id, name: user.name, email: user.email },
        active_workspace: user.activeWorkspace,
        default_workspace: user.defaultWorkspace,
        time_zone: timeZone,
        time_zone_source: ctx.config.timeZone ? "server configuration" : "Clockify account settings",
        today: today(timeZone),
        server: {
          api_url: ctx.config.apiUrl,
          workspace_id: ctx.config.defaultWorkspace ?? null,
          workspace_lock: ctx.config.lockToWorkspace,
          read_only: ctx.config.readOnly,
        },
      });
    },
  );

  defineTool(
    ctx,
    "clockify_list_workspaces",
    {},
    {
      title: "List workspaces",
      description: "Every workspace the API key can see. Refused when the server is locked to one.",
      readOnly: true,
    },
    async () => {
      client.assertUnlocked("listing all workspaces");
      const workspaces = await client.get<Workspace[]>("/workspaces");
      return json({
        count: workspaces.length,
        items: workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name })),
      });
    },
  );

  defineTool(
    ctx,
    "clockify_get_workspace",
    { ...workspaceShape },
    {
      title: "Get workspace",
      description: "Full workspace record: settings, features, currencies and your membership in it.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const workspaces = await client.get<Workspace[]>("/workspaces");
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) {
        throw new Error(
          `Workspace ${workspaceId} is not among the workspaces this API key can see.`,
        );
      }
      return json(workspace);
    },
  );

  defineTool(
    ctx,
    "clockify_workspace_users",
    {
      ...workspaceShape,
      ...pagingShape,
      name: z.string().optional().describe("Filter by name, partial match"),
      email: z.string().optional().describe("Filter by exact email"),
      status: z
        .enum(["PENDING", "ACTIVE", "DECLINED", "INACTIVE"])
        .optional()
        .describe("Membership status"),
      include_memberships: z
        .boolean()
        .optional()
        .describe("Include each user's project and group memberships"),
    },
    {
      title: "List workspace users",
      description:
        "People in the workspace, with their ids — needed whenever a tool asks for `user_id`.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/users`, args, {
        name: args.name,
        email: args.email,
        status: args.status,
        memberships: args.include_memberships ? "ALL" : undefined,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_find_user",
    {
      ...workspaceShape,
      query: z.string().describe("Part of a name or email, case-insensitive"),
    },
    {
      title: "Find a user",
      description:
        "Resolves a person to their Clockify id from a name or an email fragment, so a request " +
        'like "what did Anna work on" does not need ids typed by hand.',
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const users = await client.listAll<{ id: string; name: string; email: string; status?: string }>(
        `/workspaces/${workspaceId}/users`,
        { memberships: "NONE" },
        500,
      );
      const needle = args.query.trim().toLowerCase();
      const matches = users.filter(
        (user) =>
          user.name?.toLowerCase().includes(needle) || user.email?.toLowerCase().includes(needle),
      );
      return json({
        query: args.query,
        count: matches.length,
        items: matches.map((user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          status: user.status,
        })),
      });
    },
  );

  defineTool(
    ctx,
    "clockify_list_user_groups",
    { ...workspaceShape, ...pagingShape, name: z.string().optional().describe("Filter by name") },
    {
      title: "List user groups",
      description: "Teams defined in the workspace, with their member ids.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/user-groups`, args, { name: args.name });
    },
  );
}
