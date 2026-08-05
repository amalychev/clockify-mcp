import { z } from "zod";
import { dayBounds, parseInstant, resolveDate, toClockifyTime } from "../time.js";
import { compact, defineTool, json, workspaceShape, type ToolContext } from "./helpers.js";

/**
 * The Reports API. It lives on its own host, takes POST bodies rather than query
 * strings, and needs a paid Clockify plan — on the free plan every call here
 * comes back 403. `clockify_time_summary` covers the common case without it.
 */
export function registerReportTools(ctx: ToolContext): void {
  const { client } = ctx;

  const rangeShape = {
    from: z.string().describe("Range start: `2026-08-01`, `today`, or a full ISO instant"),
    to: z.string().describe("Range end, inclusive when a plain date is given"),
    user_ids: z.array(z.string()).optional().describe("Limit to these users"),
    project_ids: z.array(z.string()).optional().describe("Limit to these projects"),
    client_ids: z.array(z.string()).optional().describe("Limit to these clients"),
    tag_ids: z.array(z.string()).optional().describe("Limit to these tags"),
    billable: z.boolean().optional().describe("Only billable (true) or only non-billable (false)"),
    extra: z
      .record(z.unknown())
      .optional()
      .describe("Extra fields merged into the request body, for filters without a dedicated argument"),
  };

  /** Both ends of the range, with a plain date on `to` meaning end of that day. */
  async function range(args: { from: string; to: string }): Promise<{ start: string; end: string }> {
    const timeZone = await client.timeZone();
    const plainDay = (value: string) =>
      /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ||
      ["today", "yesterday", "tomorrow"].includes(value.trim().toLowerCase());

    const start = plainDay(args.from)
      ? dayBounds(resolveDate(args.from, timeZone), timeZone).start
      : parseInstant(args.from, timeZone);
    const end = plainDay(args.to)
      ? dayBounds(resolveDate(args.to, timeZone), timeZone).end
      : parseInstant(args.to, timeZone);
    return { start: toClockifyTime(start), end: toClockifyTime(end) };
  }

  function filters(args: {
    user_ids?: string[];
    project_ids?: string[];
    client_ids?: string[];
    tag_ids?: string[];
    billable?: boolean;
  }) {
    return compact({
      users: args.user_ids?.length ? { ids: args.user_ids, contains: "CONTAINS" } : undefined,
      projects: args.project_ids?.length
        ? { ids: args.project_ids, contains: "CONTAINS" }
        : undefined,
      clients: args.client_ids?.length ? { ids: args.client_ids, contains: "CONTAINS" } : undefined,
      tags: args.tag_ids?.length ? { ids: args.tag_ids, contains: "CONTAINS" } : undefined,
      billable: args.billable,
    });
  }

  defineTool(
    ctx,
    "clockify_summary_report",
    {
      ...workspaceShape,
      ...rangeShape,
      group_by: z
        .array(z.enum(["PROJECT", "CLIENT", "USER", "TASK", "TAG", "DATE", "TIMEENTRY"]))
        .optional()
        .describe("Grouping levels, outermost first (default PROJECT then USER)"),
    },
    {
      title: "Summary report",
      description:
        "Totals grouped the way the Clockify summary report groups them, for the whole workspace. " +
        "Needs a paid plan; on the free plan use clockify_time_summary instead.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const { start, end } = await range(args);
      return json(
        await client.post(
          `/workspaces/${workspaceId}/reports/summary`,
          {
            dateRangeStart: start,
            dateRangeEnd: end,
            summaryFilter: { groups: args.group_by ?? ["PROJECT", "USER"] },
            exportType: "JSON",
            ...filters(args),
            ...(args.extra ?? {}),
          },
          undefined,
          "reports",
        ),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_detailed_report",
    {
      ...workspaceShape,
      ...rangeShape,
      page: z.number().int().min(1).optional().describe("Page number (default 1)"),
      page_size: z.number().int().min(1).max(1000).optional().describe("Rows per page (default 50)"),
    },
    {
      title: "Detailed report",
      description:
        "Every time entry in the range across the workspace, one row each. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const { start, end } = await range(args);
      return json(
        await client.post(
          `/workspaces/${workspaceId}/reports/detailed`,
          {
            dateRangeStart: start,
            dateRangeEnd: end,
            detailedFilter: { page: args.page ?? 1, pageSize: args.page_size ?? 50 },
            exportType: "JSON",
            ...filters(args),
            ...(args.extra ?? {}),
          },
          undefined,
          "reports",
        ),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_weekly_report",
    {
      ...workspaceShape,
      ...rangeShape,
      group: z.enum(["PROJECT", "USER"]).optional().describe("Rows of the weekly grid (default PROJECT)"),
      subgroup: z
        .enum(["TIME", "EARNINGS"])
        .optional()
        .describe("What each cell shows (default TIME)"),
    },
    {
      title: "Weekly report",
      description: "The weekly grid: rows per project or person, columns per day. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const { start, end } = await range(args);
      return json(
        await client.post(
          `/workspaces/${workspaceId}/reports/weekly`,
          {
            dateRangeStart: start,
            dateRangeEnd: end,
            weeklyFilter: { group: args.group ?? "PROJECT", subgroup: args.subgroup ?? "TIME" },
            exportType: "JSON",
            ...filters(args),
            ...(args.extra ?? {}),
          },
          undefined,
          "reports",
        ),
      );
    },
  );
}
