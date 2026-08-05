import { z } from "zod";
import {
  compact,
  defineTool,
  json,
  paged,
  pagingShape,
  workspaceShape,
  type ToolContext,
} from "./helpers.js";
import { resolveProjectId } from "./resolve.js";

/** Tasks live inside a project and are what longer work is booked against. */
export function registerTaskTools(ctx: ToolContext): void {
  const { client } = ctx;

  /** Every tool here needs a project, by id or by name. */
  async function projectOf(
    workspaceId: string,
    args: { project_id?: string; project_name?: string },
  ): Promise<string> {
    const projectId = await resolveProjectId(client, workspaceId, args.project_id, args.project_name);
    if (!projectId) throw new Error("Give `project_id` or `project_name`.");
    return projectId;
  }

  const projectRef = {
    project_id: z.string().optional().describe("Project id"),
    project_name: z.string().optional().describe("Project name instead of the id"),
  };

  defineTool(
    ctx,
    "clockify_list_tasks",
    {
      ...workspaceShape,
      ...projectRef,
      ...pagingShape,
      name: z.string().optional().describe("Filter by name"),
      is_active: z.boolean().optional().describe("Only active (true) or only done (false) tasks"),
    },
    { title: "List tasks", description: "Tasks of a project, with their ids and status.", readOnly: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await projectOf(workspaceId, args);
      return paged(client, `/workspaces/${workspaceId}/projects/${projectId}/tasks`, args, {
        name: args.name,
        "is-active": args.is_active,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_get_task",
    { ...workspaceShape, ...projectRef, task_id: z.string().describe("Task id") },
    { title: "Get a task", description: "One task in full.", readOnly: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await projectOf(workspaceId, args);
      return json(
        await client.get(`/workspaces/${workspaceId}/projects/${projectId}/tasks/${args.task_id}`),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_create_task",
    {
      ...workspaceShape,
      ...projectRef,
      name: z.string().describe("Task name"),
      assignee_ids: z.array(z.string()).optional().describe("User ids to assign"),
      estimate_hours: z.number().optional().describe("Time estimate"),
      billable: z.boolean().optional(),
      status: z.enum(["ACTIVE", "DONE"]).optional(),
    },
    { title: "Create a task", description: "Adds a task to a project." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await projectOf(workspaceId, args);
      return json(
        await client.post(`/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
          name: args.name,
          ...compact({
            assigneeIds: args.assignee_ids,
            estimate: args.estimate_hours ? `PT${args.estimate_hours}H` : undefined,
            billable: args.billable,
            status: args.status,
          }),
        }),
        "Task created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_update_task",
    {
      ...workspaceShape,
      ...projectRef,
      task_id: z.string().describe("Task id"),
      name: z.string().optional(),
      assignee_ids: z.array(z.string()).optional(),
      estimate_hours: z.number().optional(),
      billable: z.boolean().optional(),
      status: z.enum(["ACTIVE", "DONE"]).optional().describe("DONE marks the task finished"),
    },
    { title: "Update a task", description: "Renames a task, reassigns it or marks it done." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await projectOf(workspaceId, args);
      return json(
        await client.put(
          `/workspaces/${workspaceId}/projects/${projectId}/tasks/${args.task_id}`,
          compact({
            name: args.name,
            assigneeIds: args.assignee_ids,
            estimate: args.estimate_hours ? `PT${args.estimate_hours}H` : undefined,
            billable: args.billable,
            status: args.status,
          }),
        ),
        "Task updated.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_delete_task",
    {
      ...workspaceShape,
      ...projectRef,
      task_id: z.string().describe("Task id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    { title: "Delete a task", description: "Removes a task from a project.", destructive: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await projectOf(workspaceId, args);
      await client.delete(`/workspaces/${workspaceId}/projects/${projectId}/tasks/${args.task_id}`);
      return json({ deleted: args.task_id });
    },
  );
}
