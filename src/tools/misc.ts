import { z } from "zod";
import type { ApiSurface } from "../clockify-client.js";
import { resolveDate } from "../time.js";
import {
  compact,
  defineTool,
  json,
  paged,
  pagingShape,
  workspaceShape,
  type ToolContext,
} from "./helpers.js";

/**
 * Paid-plan corners of the API, plus the escape hatch for everything without a
 * dedicated tool.
 */
export function registerMiscTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_list_custom_fields",
    { ...workspaceShape, ...pagingShape },
    {
      title: "List custom fields",
      description: "Custom fields defined on the workspace. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/custom-fields`, args);
    },
  );

  defineTool(
    ctx,
    "clockify_list_expenses",
    {
      ...workspaceShape,
      ...pagingShape,
      user_id: z.string().optional().describe("Only this person's expenses"),
    },
    {
      title: "List expenses",
      description: "Expenses recorded in the workspace. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/expenses`, args, {
        "user-id": args.user_id,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_create_expense",
    {
      ...workspaceShape,
      category_id: z.string().describe("Expense category id"),
      project_id: z.string().optional().describe("Project to charge"),
      date: z.string().describe("Date of the expense"),
      amount: z.number().describe("Amount in the workspace currency"),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
    },
    { title: "Create an expense", description: "Records an expense. Needs a paid plan." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      return json(
        await client.post(`/workspaces/${workspaceId}/expenses`, {
          categoryId: args.category_id,
          date: `${resolveDate(args.date, timeZone)}T00:00:00Z`,
          total: args.amount,
          ...compact({
            projectId: args.project_id,
            notes: args.notes,
            billable: args.billable,
          }),
        }),
        "Expense created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_list_invoices",
    {
      ...workspaceShape,
      ...pagingShape,
      status: z
        .enum(["UNSENT", "SENT", "PAID", "VOID", "OVERDUE", "PARTIALLY_PAID"])
        .optional()
        .describe("Filter by invoice status"),
    },
    {
      title: "List invoices",
      description: "Invoices in the workspace. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/invoices`, args, { status: args.status });
    },
  );

  defineTool(
    ctx,
    "clockify_list_webhooks",
    { ...workspaceShape },
    {
      title: "List webhooks",
      description: "Webhooks registered on the workspace. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(await client.get(`/workspaces/${workspaceId}/webhooks`));
    },
  );

  /**
   * Paths a locked server still allows: they are about the caller, not about a
   * workspace, so they cannot leak another workspace's data.
   */
  const LOCKED_SAFE_PATHS = [/^\/user\b/];

  defineTool(
    ctx,
    "clockify_api_request",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      path: z
        .string()
        .describe("Path below the API root, e.g. `/workspaces/{id}/projects` — no host, no /api/v1"),
      surface: z
        .enum(["api", "reports", "pto"])
        .optional()
        .describe("Which Clockify host: main API (default), reports, or time off"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Query string parameters"),
      body: z.record(z.unknown()).optional().describe("JSON request body"),
    },
    {
      title: "Raw Clockify API request",
      description:
        "Any Clockify endpoint that has no dedicated tool. Paths are relative to the API root; " +
        "pick `surface` to reach the reports or time-off hosts. Respects read-only mode and the " +
        "workspace lock.",
      // Reads are the point of this tool; writes are refused below in read-only mode.
      readOnly: true,
    },
    async (args) => {
      const method = args.method.toUpperCase();
      if (ctx.config.readOnly && method !== "GET") {
        throw new Error(
          `Refused: ${method} changes data and the server runs with CLOCKIFY_READ_ONLY=true.`,
        );
      }

      const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
      if (client.isLocked && !LOCKED_SAFE_PATHS.some((safe) => safe.test(path))) {
        const match = /^\/workspaces\/([^/]+)/.exec(path);
        if (!match) {
          throw new Error(
            `Refused: this server is locked to workspace ${ctx.config.defaultWorkspace}, so raw ` +
              `requests must address \`/workspaces/${ctx.config.defaultWorkspace}/…\`.`,
          );
        }
        client.assertLockedWorkspace(match[1]);
      }

      const result = await client.request(method, path, {
        query: args.query,
        body: args.body,
        surface: (args.surface ?? "api") as ApiSurface,
      });
      return json(result);
    },
  );
}
