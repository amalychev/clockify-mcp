import { z } from "zod";
import { compact, defineTool, json, workspaceShape, type ToolContext } from "./helpers.js";

/** Membership management: who is in the workspace and in which groups. */
export function registerUserTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_invite_user",
    {
      ...workspaceShape,
      email: z.string().email().describe("Email address to invite"),
    },
    {
      title: "Invite a user",
      description: "Sends a workspace invitation. Needs admin rights and a free seat.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.post(`/workspaces/${workspaceId}/users`, { email: args.email }),
        "Invitation sent.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_set_user_status",
    {
      ...workspaceShape,
      user_id: z.string().describe("User id"),
      status: z.enum(["ACTIVE", "INACTIVE"]).describe("INACTIVE frees the seat but keeps the data"),
    },
    {
      title: "Activate or deactivate a user",
      description: "Changes a member's status in the workspace without deleting their history.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.put(`/workspaces/${workspaceId}/users/${args.user_id}`, {
          status: args.status,
        }),
        "Status updated.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_remove_user",
    {
      ...workspaceShape,
      user_id: z.string().describe("User id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    {
      title: "Remove a user",
      description: "Removes someone from the workspace. Their time entries stay.",
      destructive: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/users/${args.user_id}`);
      return json({ removed: args.user_id });
    },
  );

  defineTool(
    ctx,
    "clockify_create_user_group",
    { ...workspaceShape, name: z.string().describe("Group name") },
    { title: "Create a user group", description: "Adds a team to the workspace." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.post(`/workspaces/${workspaceId}/user-groups`, { name: args.name }),
        "Group created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_update_user_group",
    {
      ...workspaceShape,
      group_id: z.string().describe("Group id"),
      name: z.string().optional().describe("New name"),
    },
    { title: "Update a user group", description: "Renames a team." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.put(
          `/workspaces/${workspaceId}/user-groups/${args.group_id}`,
          compact({ name: args.name }),
        ),
        "Group updated.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_add_user_to_group",
    {
      ...workspaceShape,
      group_id: z.string().describe("Group id"),
      user_id: z.string().describe("User id"),
    },
    { title: "Add a user to a group", description: "Puts someone into a team." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.post(`/workspaces/${workspaceId}/user-groups/${args.group_id}/users`, {
          userId: args.user_id,
        }),
        "User added to the group.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_remove_user_from_group",
    {
      ...workspaceShape,
      group_id: z.string().describe("Group id"),
      user_id: z.string().describe("User id"),
    },
    { title: "Remove a user from a group", description: "Takes someone out of a team." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(
        `/workspaces/${workspaceId}/user-groups/${args.group_id}/users/${args.user_id}`,
      );
      return json({ removed: args.user_id, from_group: args.group_id });
    },
  );

  defineTool(
    ctx,
    "clockify_delete_user_group",
    {
      ...workspaceShape,
      group_id: z.string().describe("Group id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    { title: "Delete a user group", description: "Removes a team.", destructive: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/user-groups/${args.group_id}`);
      return json({ deleted: args.group_id });
    },
  );
}
