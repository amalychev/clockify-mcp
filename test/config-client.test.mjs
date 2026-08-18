import assert from "node:assert/strict";
import test from "node:test";

import { ClockifyClient } from "../dist/clockify-client.js";
import { ConfigError, loadConfig, normalizeApiUrl, resolveConfig } from "../dist/config.js";

test("normalizes Clockify API roots", () => {
  assert.equal(normalizeApiUrl("clockify.example"), "https://clockify.example/api/v1");
  assert.equal(normalizeApiUrl("https://clockify.example/api/v1/"), "https://clockify.example/api/v1");
});

test("resolves environment-style config", () => {
  const config = resolveConfig({
    apiKey: "key",
    apiUrl: "clockify.example",
    authType: "bearer",
    workspaceId: "workspace-1",
    workspaceLock: "true",
    projectId: "project-1",
    timeZone: "UTC",
    readOnly: "true",
    timeoutMs: "500",
  });

  assert.equal(config.apiUrl, "https://clockify.example/api/v1");
  assert.equal(config.reportsUrl, "https://reports.clockify.example/v1");
  assert.equal(config.ptoUrl, "https://pto.clockify.example/v1");
  assert.equal(config.authHeader, "Authorization");
  assert.equal(config.defaultWorkspace, "workspace-1");
  assert.equal(config.defaultProject, "project-1");
  assert.equal(config.lockToWorkspace, true);
  assert.equal(config.readOnly, true);
  assert.equal(config.timeoutMs, 500);
});

test("requires an API key and validates locked workspaces", () => {
  assert.throws(() => resolveConfig({}), ConfigError);
  assert.throws(() => resolveConfig({ apiKey: "key", workspaceLock: "true" }), ConfigError);
  assert.throws(() => resolveConfig({ apiKey: "key", timeZone: "Not/AZone" }), ConfigError);
  assert.throws(() => loadConfig({ CLOCKIFY_WORKSPACE_LOCK: "true", CLOCKIFY_API_KEY: "key" }), /requires CLOCKIFY_WORKSPACE_ID/);
});

test("builds URLs and respects workspace lock locally", async () => {
  const client = new ClockifyClient(
    resolveConfig({
      apiKey: "key",
      workspaceId: "workspace-1",
      workspaceLock: "true",
      apiUrl: "clockify.example",
    }),
  );

  assert.equal(
    client.url("/workspaces/workspace-1/projects", {
      page: 1,
      empty: "",
      tags: ["alpha", "beta"],
      include: true,
    }),
    "https://clockify.example/api/v1/workspaces/workspace-1/projects?page=1&tags=alpha&tags=beta&include=true",
  );
  assert.equal(await client.workspaceId(), "workspace-1");
  assert.throws(() => client.assertLockedWorkspace("other-workspace"), /out of scope/);
  assert.throws(() => client.assertUnlocked("listing all workspaces"), /reaches beyond workspace workspace-1/);
});
