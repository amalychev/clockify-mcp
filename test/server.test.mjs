import assert from "node:assert/strict";
import test from "node:test";

import { buildServer, SERVER_NAME, SERVER_VERSION } from "../dist/server.js";

const config = {
  apiUrl: "https://api.clockify.me/api/v1",
  reportsUrl: "https://reports.api.clockify.me/v1",
  ptoUrl: "https://pto.api.clockify.me/v1",
  apiKey: "test-key",
  authHeader: "X-Api-Key",
  defaultWorkspace: "workspace-1",
  defaultProject: undefined,
  lockToWorkspace: false,
  timeZone: "UTC",
  timeoutMs: 1000,
  readOnly: false,
};

const expectedTools = [
  "clockify_whoami",
  "clockify_list_workspaces",
  "clockify_get_workspace",
  "clockify_workspace_users",
  "clockify_find_user",
  "clockify_list_user_groups",
  "clockify_current_timer",
  "clockify_start_timer",
  "clockify_stop_timer",
  "clockify_log_time",
  "clockify_log_many",
  "clockify_list_time_entries",
  "clockify_time_summary",
  "clockify_get_time_entry",
  "clockify_update_time_entry",
  "clockify_delete_time_entry",
  "clockify_list_projects",
  "clockify_find_project",
  "clockify_get_project",
  "clockify_create_project",
  "clockify_update_project",
  "clockify_delete_project",
  "clockify_list_clients",
  "clockify_create_client",
  "clockify_update_client",
  "clockify_delete_client",
  "clockify_list_tasks",
  "clockify_get_task",
  "clockify_create_task",
  "clockify_update_task",
  "clockify_delete_task",
  "clockify_list_tags",
  "clockify_create_tag",
  "clockify_update_tag",
  "clockify_delete_tag",
  "clockify_invite_user",
  "clockify_set_user_status",
  "clockify_remove_user",
  "clockify_create_user_group",
  "clockify_update_user_group",
  "clockify_add_user_to_group",
  "clockify_remove_user_from_group",
  "clockify_delete_user_group",
  "clockify_summary_report",
  "clockify_detailed_report",
  "clockify_weekly_report",
  "clockify_list_holidays",
  "clockify_create_holiday",
  "clockify_delete_holiday",
  "clockify_list_time_off_policies",
  "clockify_time_off_balance",
  "clockify_list_time_off_requests",
  "clockify_request_time_off",
  "clockify_list_approval_requests",
  "clockify_submit_approval",
  "clockify_list_custom_fields",
  "clockify_list_expenses",
  "clockify_create_expense",
  "clockify_list_invoices",
  "clockify_list_webhooks",
  "clockify_api_request",
];

function registeredTools(options = {}) {
  const { server } = buildServer({ ...config, ...options });
  return server._registeredTools;
}

test("server metadata is stable", () => {
  assert.equal(SERVER_NAME, "clockify-mcp");
  assert.equal(SERVER_VERSION, "1.0.0");
});

test("registers every declared Clockify tool", () => {
  const tools = registeredTools();

  assert.deepEqual(Object.keys(tools).sort(), [...expectedTools].sort());
  assert.equal(Object.keys(tools).length, 61);

  for (const name of expectedTools) {
    assert.equal(tools[name].enabled, true, `${name} should be enabled`);
    assert.equal(typeof tools[name].description, "string", `${name} should describe itself`);
    assert.ok(tools[name].description.length > 0, `${name} should describe itself`);
    assert.equal(tools[name].annotations.title, tools[name].title);
  }
});

test("read-only mode refuses mutating tools before hitting Clockify", async () => {
  const tools = registeredTools({ readOnly: true });
  const result = await tools.clockify_start_timer.handler({ description: "blocked" }, {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /CLOCKIFY_READ_ONLY=true/);
});

test("workspace lock refuses account-wide workspace listing before hitting Clockify", async () => {
  const tools = registeredTools({ lockToWorkspace: true });
  const result = await tools.clockify_list_workspaces.handler({}, {});

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reaches beyond workspace workspace-1/);
});
