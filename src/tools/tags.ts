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

/** Tags cut across projects: "meeting", "code review", "billable travel". */
export function registerTagTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_list_tags",
    {
      ...workspaceShape,
      ...pagingShape,
      name: z.string().optional().describe("Filter by name"),
      archived: z.boolean().optional(),
    },
    { title: "List tags", description: "Tags defined in the workspace.", readOnly: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/tags`, args, {
        name: args.name,
        archived: args.archived,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_create_tag",
    { ...workspaceShape, name: z.string().describe("Tag name") },
    { title: "Create a tag", description: "Adds a tag to the workspace." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.post(`/workspaces/${workspaceId}/tags`, { name: args.name }),
        "Tag created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_update_tag",
    {
      ...workspaceShape,
      tag_id: z.string().describe("Tag id"),
      name: z.string().optional(),
      archived: z.boolean().optional(),
    },
    { title: "Update a tag", description: "Renames or archives a tag." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.put(
          `/workspaces/${workspaceId}/tags/${args.tag_id}`,
          compact({ name: args.name, archived: args.archived }),
        ),
        "Tag updated.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_delete_tag",
    {
      ...workspaceShape,
      tag_id: z.string().describe("Tag id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    { title: "Delete a tag", description: "Removes a tag.", destructive: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/tags/${args.tag_id}`);
      return json({ deleted: args.tag_id });
    },
  );
}
