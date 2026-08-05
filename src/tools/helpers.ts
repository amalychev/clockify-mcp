import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { ClockifyError, type ClockifyClient, type ApiSurface, type Query } from "../clockify-client.js";
import type { Config } from "../config.js";
import { TimeError } from "../time.js";

export interface ToolContext {
  server: McpServer;
  client: ClockifyClient;
  config: Config;
}

export type ContentBlock = { type: "text"; text: string };

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/** JSON results are pretty-printed so the model can read them without re-parsing. */
export function json(value: unknown, note?: string): ToolResult {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text(note ? `${note}\n\n${body}` : body);
}

/** Common paging arguments shared by every list tool. */
export const pagingShape = {
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Items per page, max 200 (default 50)"),
  all_pages: z
    .boolean()
    .optional()
    .describe("Follow pagination and return up to `limit` items across pages"),
  limit: z.number().int().min(1).max(5000).optional().describe("Cap for all_pages (default 500)"),
};

export const workspaceShape = {
  workspace_id: z
    .string()
    .optional()
    .describe(
      "Workspace id. Falls back to CLOCKIFY_WORKSPACE_ID, then to the account's active workspace.",
    ),
};

export const userShape = {
  user_id: z
    .string()
    .optional()
    .describe("User id, or `me` (default) for the owner of the API key."),
};

type PagingArgs = { page?: number; page_size?: number; all_pages?: boolean; limit?: number };

/** Runs a list endpoint honouring the shared paging arguments. */
export async function paged<T = unknown>(
  client: ClockifyClient,
  path: string,
  args: PagingArgs & Record<string, unknown>,
  query: Query = {},
  surface: ApiSurface = "api",
): Promise<ToolResult> {
  if (args.all_pages) {
    const items = await client.listAll<T>(path, query, args.limit ?? 500, surface);
    return json({ count: items.length, items });
  }
  const result = await client.list<T>(
    path,
    { ...query, page: args.page, "page-size": args.page_size },
    surface,
  );
  return json({
    count: result.data.length,
    page: result.page,
    page_size: result.pageSize,
    // Clockify returns no total, so this is the only honest signal about more pages.
    has_more: result.hasMore,
    items: result.data,
  });
}

/** Drops undefined keys so we never send `"field": null` to Clockify by accident. */
export function compact<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

interface DefineOptions {
  title: string;
  description: string;
  /** false marks the tool as mutating; it is then blocked in read-only mode. */
  readOnly?: boolean;
  destructive?: boolean;
}

/**
 * Registers a tool with uniform error handling and the read-only guard, so
 * individual handlers stay focused on the Clockify call itself.
 */
export function defineTool<S extends ZodRawShape>(
  ctx: ToolContext,
  name: string,
  schema: S,
  options: DefineOptions,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<ToolResult>,
): void {
  ctx.server.registerTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: schema,
      annotations: {
        title: options.title,
        readOnlyHint: options.readOnly ?? false,
        destructiveHint: options.destructive ?? false,
      },
    },
    (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        if (ctx.config.readOnly && !options.readOnly) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Refused: \`${name}\` changes data in Clockify and the server runs with CLOCKIFY_READ_ONLY=true.`,
              },
            ],
            isError: true,
          };
        }
        return await handler(args);
      } catch (error) {
        const message =
          error instanceof ClockifyError
            ? `${error.message}\n\nRequest: ${error.url}`
            : error instanceof TimeError
              ? error.message
              : (error as Error).message;
        return {
          content: [{ type: "text" as const, text: `Error in ${name}: ${message}` }],
          isError: true,
        };
      }
    }) as never,
  );
}
