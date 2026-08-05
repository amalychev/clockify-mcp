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

interface Project {
  id: string;
  name: string;
  clientId?: string | null;
  clientName?: string | null;
  archived?: boolean;
  billable?: boolean;
  color?: string;
  duration?: string;
  note?: string;
  public?: boolean;
}

/** Projects and clients — what time gets booked against. */
export function registerProjectTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_list_projects",
    {
      ...workspaceShape,
      ...pagingShape,
      name: z.string().optional().describe("Filter by name, partial match"),
      archived: z.boolean().optional().describe("true for archived only, false for active only"),
      billable: z.boolean().optional().describe("Filter by billable flag"),
      client_ids: z.array(z.string()).optional().describe("Only projects of these clients"),
      hydrated: z.boolean().optional().describe("Include tasks and memberships in each project"),
    },
    {
      title: "List projects",
      description: "Projects in the workspace, with their ids, clients and archived state.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged<Project>(client, `/workspaces/${workspaceId}/projects`, args, {
        name: args.name,
        archived: args.archived,
        billable: args.billable,
        clients: args.client_ids,
        hydrated: args.hydrated,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_find_project",
    {
      ...workspaceShape,
      query: z.string().describe("Part of a project name, case-insensitive"),
      include_archived: z.boolean().optional().describe("Also search archived projects"),
    },
    {
      title: "Find a project",
      description:
        "Looks a project up by name and returns the candidates with their ids — the quickest way " +
        "from what a person calls a project to what the API needs.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projects = await client.listAll<Project>(
        `/workspaces/${workspaceId}/projects`,
        { name: args.query, archived: args.include_archived ? undefined : false },
        200,
      );
      return json({
        query: args.query,
        count: projects.length,
        items: projects.map((project) => ({
          id: project.id,
          name: project.name,
          client: project.clientName ?? null,
          archived: project.archived ?? false,
          billable: project.billable ?? null,
        })),
      });
    },
  );

  defineTool(
    ctx,
    "clockify_get_project",
    { ...workspaceShape, project_id: z.string().describe("Project id") },
    {
      title: "Get a project",
      description: "One project in full: client, estimates, memberships, hourly rate.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.get(`/workspaces/${workspaceId}/projects/${args.project_id}`, { hydrated: true }),
      );
    },
  );

  defineTool(
    ctx,
    "clockify_create_project",
    {
      ...workspaceShape,
      name: z.string().describe("Project name"),
      client_id: z.string().optional().describe("Client id"),
      client_name: z.string().optional().describe("Client name instead of the id"),
      is_public: z.boolean().optional().describe("Visible to everyone in the workspace"),
      billable: z.boolean().optional(),
      color: z.string().optional().describe("Hex colour such as #4CAF50"),
      note: z.string().optional(),
      estimate_hours: z.number().optional().describe("Time estimate for the whole project"),
    },
    {
      title: "Create a project",
      description: "Adds a project to the workspace.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      let clientId = args.client_id;
      if (!clientId && args.client_name) {
        const clients = await client.listAll<{ id: string; name: string }>(
          `/workspaces/${workspaceId}/clients`,
          { name: args.client_name },
          100,
        );
        const exact = clients.find(
          (candidate) => candidate.name.toLowerCase() === args.client_name!.toLowerCase(),
        );
        const match = exact ?? (clients.length === 1 ? clients[0] : undefined);
        if (!match) throw new Error(`No single client matches \`${args.client_name}\`.`);
        clientId = match.id;
      }

      const project = await client.post<Project>(`/workspaces/${workspaceId}/projects`, {
        name: args.name,
        ...compact({
          clientId,
          isPublic: args.is_public,
          billable: args.billable,
          color: args.color,
          note: args.note,
          estimate: args.estimate_hours
            ? { estimate: `PT${args.estimate_hours}H`, type: "MANUAL" }
            : undefined,
        }),
      });
      return json(project, "Project created.");
    },
  );

  defineTool(
    ctx,
    "clockify_update_project",
    {
      ...workspaceShape,
      project_id: z.string().optional().describe("Project id"),
      project_name: z.string().optional().describe("Project name instead of the id"),
      name: z.string().optional().describe("New name"),
      client_id: z.string().optional(),
      is_public: z.boolean().optional(),
      billable: z.boolean().optional(),
      color: z.string().optional(),
      note: z.string().optional(),
      archived: z.boolean().optional().describe("true archives the project, false restores it"),
    },
    {
      title: "Update a project",
      description: "Renames, re-colours, archives or restores a project.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const projectId = await resolveProjectId(
        client,
        workspaceId,
        args.project_id,
        args.project_name,
      );
      if (!projectId) throw new Error("Give `project_id` or `project_name`.");

      const project = await client.put<Project>(
        `/workspaces/${workspaceId}/projects/${projectId}`,
        compact({
          name: args.name,
          clientId: args.client_id,
          isPublic: args.is_public,
          billable: args.billable,
          color: args.color,
          note: args.note,
          archived: args.archived,
        }),
      );
      return json(project, "Project updated.");
    },
  );

  defineTool(
    ctx,
    "clockify_delete_project",
    {
      ...workspaceShape,
      project_id: z.string().describe("Project id"),
      confirm: z.literal(true).describe("Must be true — this also removes its time entries"),
    },
    {
      title: "Delete a project",
      description:
        "Deletes a project. Clockify only allows this once the project is archived, so archive it first.",
      destructive: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/projects/${args.project_id}`);
      return json({ deleted: args.project_id });
    },
  );

  defineTool(
    ctx,
    "clockify_list_clients",
    {
      ...workspaceShape,
      ...pagingShape,
      name: z.string().optional().describe("Filter by name"),
      archived: z.boolean().optional(),
    },
    {
      title: "List clients",
      description: "Clients in the workspace.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return paged(client, `/workspaces/${workspaceId}/clients`, args, {
        name: args.name,
        archived: args.archived,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_create_client",
    {
      ...workspaceShape,
      name: z.string().describe("Client name"),
      address: z.string().optional(),
      note: z.string().optional(),
    },
    { title: "Create a client", description: "Adds a client to the workspace." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.post(`/workspaces/${workspaceId}/clients`, {
          name: args.name,
          ...compact({ address: args.address, note: args.note }),
        }),
        "Client created.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_update_client",
    {
      ...workspaceShape,
      client_id: z.string().describe("Client id"),
      name: z.string().optional(),
      address: z.string().optional(),
      note: z.string().optional(),
      archived: z.boolean().optional(),
    },
    { title: "Update a client", description: "Renames or archives a client." },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      return json(
        await client.put(
          `/workspaces/${workspaceId}/clients/${args.client_id}`,
          compact({
            name: args.name,
            address: args.address,
            note: args.note,
            archived: args.archived,
          }),
        ),
        "Client updated.",
      );
    },
  );

  defineTool(
    ctx,
    "clockify_delete_client",
    {
      ...workspaceShape,
      client_id: z.string().describe("Client id"),
      confirm: z.literal(true).describe("Must be true"),
    },
    { title: "Delete a client", description: "Removes a client.", destructive: true },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/clients/${args.client_id}`);
      return json({ deleted: args.client_id });
    },
  );
}
