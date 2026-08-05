#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { httpOptionsFromEnv, startHttpServer } from "./http.js";
import { buildServer } from "./server.js";

// stdout is the MCP channel in stdio mode — everything human-readable goes to stderr.
const log = (message: string) => process.stderr.write(`[clockify-mcp] ${message}\n`);

function wantsHttp(): boolean {
  const transport = (process.env.MCP_TRANSPORT ?? "").toLowerCase();
  if (transport === "http" || transport === "streamable-http") return true;
  if (transport === "stdio") return false;
  return process.argv.includes("--http");
}

async function runStdio(): Promise<void> {
  const config = loadConfig();
  const { server } = buildServer(config);

  await server.connect(new StdioServerTransport());
  log(
    `ready — ${config.apiUrl}` +
      (config.defaultWorkspace ? `, workspace ${config.defaultWorkspace}` : "") +
      (config.lockToWorkspace ? " (locked)" : "") +
      (config.timeZone ? `, time zone ${config.timeZone}` : "") +
      (config.readOnly ? ", read-only" : ""),
  );
}

function runHttp(): void {
  const options = httpOptionsFromEnv();
  startHttpServer(options, log);
  log(
    options.allowedInstances.length
      ? `restricted to: ${options.allowedInstances.join(", ")}`
      : "any public Clockify host may be targeted; private addresses are refused",
  );
}

async function main(): Promise<void> {
  if (wantsHttp()) {
    runHttp();
    return;
  }
  await runStdio();
}

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : (error as Error).message;
  log(`fatal: ${message}`);
  process.exit(1);
});
