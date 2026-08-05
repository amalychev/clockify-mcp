import { z } from "zod";
import { resolveDate } from "../time.js";
import {
  compact,
  defineTool,
  json,
  paged,
  pagingShape,
  userShape,
  workspaceShape,
  type ToolContext,
} from "./helpers.js";

/**
 * Holidays and time off. Holidays live on the main API; policies, balances and
 * requests live on the time-off host, which is why they are grouped here.
 */
export function registerTimeOffTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_list_holidays",
    {
      ...workspaceShape,
      ...pagingShape,
      from: z.string().optional().describe("Only holidays on or after this date"),
      to: z.string().optional().describe("Only holidays on or before this date"),
    },
    {
      title: "List holidays",
      description: "Public and company holidays configured in the workspace.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      return paged(client, `/workspaces/${workspaceId}/holidays`, args, {
        "start-date": args.from ? resolveDate(args.from, timeZone) : undefined,
        "end-date": args.to ? resolveDate(args.to, timeZone) : undefined,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_create_holiday",
    {
      ...workspaceShape,
      name: z.string().describe("Holiday name"),
      from: z.string().describe("First day, `2026-12-24`"),
      to: z.string().optional().describe("Last day; defaults to the first"),
      everyone: z.boolean().optional().describe("Applies to the whole workspace (default true)"),
      user_group_ids: z.array(z.string()).optional().describe("Limit to these groups"),
      user_ids: z.array(z.string()).optional().describe("Limit to these people"),
    },
    { title: "Create a holiday", description: "Adds a holiday to the workspace calendar." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const start = resolveDate(args.from, timeZone);
      return json(
        await client.post(`/workspaces/${workspaceId}/holidays`, {
          name: args.name,
          datePeriod: { startDate: start, endDate: args.to ? resolveDate(args.to, timeZone) : start },
          ...compact({
            everyoneIncludingNew: args.everyone ?? (!args.user_ids && !args.user_group_ids),
            userGroupIds: args.user_group_ids,
            userIds: args.user_ids,
          }),
        }),
        "Holiday created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_delete_holiday",
    {
      ...workspaceShape,
      holiday_id: z.string().describe("Holiday id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    { title: "Delete a holiday", description: "Removes a holiday.", destructive: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/holidays/${args.holiday_id}`);
      return json({ deleted: args.holiday_id });
    },
  );

  defineTool(
    ctx,
    "clockify_list_time_off_policies",
    {
      ...workspaceShape,
      status: z.enum(["ACTIVE", "ARCHIVED", "ALL"]).optional().describe("Default ACTIVE"),
    },
    {
      title: "List time-off policies",
      description: "Vacation, sick leave and other policies, with the ids a request needs.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.get(
          `/workspaces/${workspaceId}/policies`,
          compact({ status: args.status }),
          "pto",
        ),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_time_off_balance",
    { ...workspaceShape, ...userShape },
    {
      title: "Time-off balance",
      description: "How many days are left under each policy for a person.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      return json(
        await client.get(`/workspaces/${workspaceId}/balance/user/${userId}`, undefined, "pto"),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_list_time_off_requests",
    {
      ...workspaceShape,
      status: z
        .enum(["PENDING", "APPROVED", "REJECTED", "ALL"])
        .optional()
        .describe("Filter by request status"),
    },
    {
      title: "List time-off requests",
      description: "Requests in the workspace — pending ones are what an approver looks for.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.get(
          `/workspaces/${workspaceId}/requests`,
          compact({ status: args.status }),
          "pto",
        ),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_request_time_off",
    {
      ...workspaceShape,
      ...userShape,
      policy_id: z.string().describe("Policy id from clockify_list_time_off_policies"),
      from: z.string().describe("First day off"),
      to: z.string().describe("Last day off"),
      note: z.string().optional().describe("Reason shown to the approver"),
      half_day: z.boolean().optional().describe("Book half days instead of full ones"),
    },
    {
      title: "Request time off",
      description: "Files a time-off request against a policy.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      const timeZone = await client.timeZone();
      return json(
        await client.post(
          `/workspaces/${workspaceId}/requests`,
          {
            policyId: args.policy_id,
            userId,
            timeOffPeriod: {
              period: {
                start: `${resolveDate(args.from, timeZone)}T00:00:00Z`,
                end: `${resolveDate(args.to, timeZone)}T23:59:59Z`,
              },
              halfDay: args.half_day ?? false,
            },
            ...compact({ note: args.note }),
          },
          undefined,
          "pto",
        ),
        "Time-off request filed.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_list_approval_requests",
    {
      ...workspaceShape,
      ...pagingShape,
      status: z
        .enum(["PENDING", "APPROVED", "WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL", "REJECTED"])
        .optional(),
    },
    {
      title: "List timesheet approvals",
      description: "Submitted timesheets awaiting approval. Needs a paid plan.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/approval-requests`, args, {
        status: args.status,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_submit_approval",
    {
      ...workspaceShape,
      week_start: z.string().describe("First day of the week being submitted, `2026-08-03`"),
    },
    {
      title: "Submit a timesheet",
      description: "Submits your week for approval. Needs a paid plan.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      return json(
        await client.post(`/workspaces/${workspaceId}/approval-requests`, {
          weekStart: `${resolveDate(args.week_start, timeZone)}T00:00:00Z`,
        }),
        "Timesheet submitted.",
      );
    },
  );
}
