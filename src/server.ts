import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClockifyClient } from "./clockify-client.js";
import type { Config } from "./config.js";
import { registerCoreTools } from "./tools/core.js";
import type { ToolContext } from "./tools/helpers.js";
import { registerMiscTools } from "./tools/misc.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerReportTools } from "./tools/reports.js";
import { registerTagTools } from "./tools/tags.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerTimeEntryTools } from "./tools/time-entries.js";
import { registerTimeOffTools } from "./tools/timeoff.js";
import { registerUserTools } from "./tools/users.js";

export const SERVER_NAME = "clockify-mcp";
export const SERVER_VERSION = "1.0.0";

/**
 * Builds a fully configured MCP server. Called once in stdio mode and once per
 * request in HTTP mode, where each caller brings their own API key.
 */
export function buildServer(config: Config): { server: McpServer; client: ClockifyClient } {
  const client = new ClockifyClient(config);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Clockify MCP server for ${config.apiUrl}.\n` +
        "Times may be given as local wall clock (`09:00`, `2026-08-05 09:00`, `yesterday`); they " +
        "are resolved in the account's time zone, which clockify_whoami reports.\n" +
        "Projects, tasks and tags can be named instead of addressed by id.\n" +
        "clockify_time_summary totals tracked time without the paid Reports API.\n" +
        "Any endpoint without a dedicated tool is reachable through clockify_api_request.",
    },
  );

  const ctx: ToolContext = { server, client, config };
  registerCoreTools(ctx);
  registerTimeEntryTools(ctx);
  registerProjectTools(ctx);
  registerTaskTools(ctx);
  registerTagTools(ctx);
  registerUserTools(ctx);
  registerReportTools(ctx);
  registerTimeOffTools(ctx);
  registerMiscTools(ctx);

  return { server, client };
}
