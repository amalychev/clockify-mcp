import { z } from "zod";
import type { ClockifyClient } from "../clockify-client.js";
import {
  dayBounds,
  humanDuration,
  inZone,
  isoDurationToSeconds,
  parseDuration,
  parseInstant,
  resolveDate,
  toClockifyTime,
  today,
} from "../time.js";
import {
  compact,
  defineTool,
  json,
  pagingShape,
  userShape,
  workspaceShape,
  type ToolContext,
} from "./helpers.js";
import { defaultProjectId, resolveProjectId, resolveTagIds, resolveTaskId } from "./resolve.js";

interface TimeInterval {
  start: string;
  end: string | null;
  duration: string | null;
}

interface TimeEntry {
  id: string;
  description: string;
  billable: boolean;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[] | null;
  userId: string;
  timeInterval: TimeInterval;
  project?: { id: string; name: string; clientName?: string } | null;
  task?: { id: string; name: string } | null;
  tags?: { id: string; name: string }[] | null;
}

/** What goes into a time entry, shared by the create and update tools. */
const entryShape = {
  description: z.string().optional().describe("What was worked on"),
  project_id: z
    .string()
    .optional()
    .describe("Project id. Falls back to CLOCKIFY_PROJECT_ID when the server sets one."),
  project_name: z.string().optional().describe("Project name instead of the id; must be unambiguous"),
  task_id: z.string().optional().describe("Task id"),
  task_name: z.string().optional().describe("Task name instead of the id; needs a project"),
  tag_ids: z.array(z.string()).optional().describe("Tag ids"),
  tag_names: z.array(z.string()).optional().describe("Tag names instead of ids"),
  billable: z.boolean().optional().describe("Mark the entry billable"),
};

type EntryArgs = {
  description?: string;
  project_id?: string;
  project_name?: string;
  task_id?: string;
  task_name?: string;
  tag_ids?: string[];
  tag_names?: string[];
  billable?: boolean;
};

/**
 * Turns the name-or-id arguments into the ids Clockify expects.
 *
 * `useDefault` applies the configured default project to an entry that names
 * none — which is what makes a project-scoped deployment log straight into its
 * project. It is on for the tools that create an entry and off for updates,
 * where silently moving an existing entry would be the wrong kind of helpful.
 */
async function resolveEntryRefs(
  client: ClockifyClient,
  workspaceId: string,
  args: EntryArgs,
  useDefault = false,
): Promise<{ projectId?: string; taskId?: string; tagIds?: string[] }> {
  const named = await resolveProjectId(client, workspaceId, args.project_id, args.project_name);
  const projectId = named ?? (useDefault ? await defaultProjectId(client, workspaceId) : undefined);
  const taskId = await resolveTaskId(client, workspaceId, projectId, args.task_id, args.task_name);
  const tagIds = await resolveTagIds(client, workspaceId, args.tag_ids, args.tag_names);
  return { projectId, taskId, tagIds };
}

/**
 * Compact rendering: a timesheet line rather than a wall of JSON. Write
 * responses come back unhydrated, so a name already known from the request is
 * passed in rather than fetched again.
 */
function summarise(entry: TimeEntry, timeZone: string, projectName?: string) {
  const seconds = isoDurationToSeconds(entry.timeInterval?.duration);
  return {
    id: entry.id,
    description: entry.description || "(no description)",
    project: entry.project?.name ?? projectName ?? entry.projectId ?? null,
    task: entry.task?.name ?? entry.taskId ?? null,
    tags: entry.tags?.map((tag) => tag.name) ?? entry.tagIds ?? [],
    billable: entry.billable,
    start_local: inZone(new Date(entry.timeInterval.start), timeZone),
    end_local: entry.timeInterval.end ? inZone(new Date(entry.timeInterval.end), timeZone) : null,
    duration: entry.timeInterval.end ? humanDuration(seconds) : "running",
    duration_seconds: seconds,
  };
}

/**
 * Time entries — the reason this server exists. Everything here accepts local
 * wall-clock times and resolves them in the account's zone.
 */
export function registerTimeEntryTools(ctx: ToolContext): void {
  const { client } = ctx;

  defineTool(
    ctx,
    "clockify_current_timer",
    { ...workspaceShape, ...userShape },
    {
      title: "Running timer",
      description:
        "The timer running right now, with how long it has been going. Returns nothing when the clock is stopped.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      const timeZone = await client.timeZone();
      const running = await client.get<TimeEntry[]>(
        `/workspaces/${workspaceId}/user/${userId}/time-entries`,
        { "in-progress": true, hydrated: true },
      );
      if (!running.length) return json({ running: false }, "No timer is running.");

      const entry = running[0];
      const elapsed = Math.round((Date.now() - new Date(entry.timeInterval.start).getTime()) / 1000);
      return json({
        running: true,
        elapsed: humanDuration(elapsed),
        elapsed_seconds: elapsed,
        entry: summarise(entry, timeZone),
      });
    },
  );

  defineTool(
    ctx,
    "clockify_start_timer",
    {
      ...workspaceShape,
      ...entryShape,
      start: z
        .string()
        .optional()
        .describe("When the timer started; default now. `09:15`, `2026-08-05 09:15` or full ISO."),
    },
    {
      title: "Start a timer",
      description:
        "Starts the clock. Clockify keeps one running timer per user, so this stops an already " +
        "running one first.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const refs = await resolveEntryRefs(client, workspaceId, args, true);
      const start = parseInstant(args.start ?? "now", timeZone);

      const entry = await client.post<TimeEntry>(`/workspaces/${workspaceId}/time-entries`, {
        ...compact({
          description: args.description,
          projectId: refs.projectId,
          taskId: refs.taskId,
          tagIds: refs.tagIds,
          billable: args.billable,
        }),
        start: toClockifyTime(start),
      });
      return json(summarise(entry, timeZone, args.project_name), "Timer started.");
    },
  );

  defineTool(
    ctx,
    "clockify_stop_timer",
    {
      ...workspaceShape,
      ...userShape,
      end: z.string().optional().describe("When it stopped; default now"),
    },
    {
      title: "Stop the timer",
      description: "Stops the running timer and returns the finished entry with its duration.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      const timeZone = await client.timeZone();
      const entry = await client.patch<TimeEntry>(
        `/workspaces/${workspaceId}/user/${userId}/time-entries`,
        { end: toClockifyTime(parseInstant(args.end ?? "now", timeZone)) },
      );
      return json(summarise(entry, timeZone), "Timer stopped.");
    },
  );

  defineTool(
    ctx,
    "clockify_log_time",
    {
      ...workspaceShape,
      ...userShape,
      ...entryShape,
      date: z
        .string()
        .optional()
        .describe("Day the work happened: `2026-08-05`, `today` (default) or `yesterday`"),
      start: z.string().describe("Start time, local: `09:00`, or a full ISO instant"),
      end: z.string().optional().describe("End time, local. Give this or `duration`."),
      duration: z
        .string()
        .optional()
        .describe("Length instead of an end time: `2h30m`, `90m`, `1.5h`, `PT2H30M`"),
    },
    {
      title: "Log finished work",
      description:
        "Writes a completed time entry. Times are local to the account's zone, so " +
        '"yesterday 09:00 for 2h30m" lands where a person expects it to.',
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const date = resolveDate(args.date ?? "today", timeZone);
      const start = parseInstant(args.start, timeZone, date);

      if (!args.end && !args.duration) {
        throw new Error("Give either `end` or `duration` — an entry without an end is a running timer.");
      }
      const end = args.end
        ? parseInstant(args.end, timeZone, date)
        : new Date(start.getTime() + parseDuration(args.duration!) * 1000);

      if (end.getTime() <= start.getTime()) {
        throw new Error(
          `The entry would end before it starts (${inZone(start, timeZone)} → ${inZone(end, timeZone)}). ` +
            "For work crossing midnight, pass full dates.",
        );
      }

      const refs = await resolveEntryRefs(client, workspaceId, args, true);
      const userId = args.user_id ? await client.userId(args.user_id) : undefined;
      const me = await client.me();
      // Writing for somebody else needs the admin-only, user-scoped endpoint.
      const path =
        userId && userId !== me.id
          ? `/workspaces/${workspaceId}/user/${userId}/time-entries`
          : `/workspaces/${workspaceId}/time-entries`;

      const entry = await client.post<TimeEntry>(path, {
        ...compact({
          description: args.description,
          projectId: refs.projectId,
          taskId: refs.taskId,
          tagIds: refs.tagIds,
          billable: args.billable,
        }),
        start: toClockifyTime(start),
        end: toClockifyTime(end),
      });
      return json(summarise(entry, timeZone, args.project_name), "Logged.");
    },
  );

  defineTool(
    ctx,
    "clockify_log_many",
    {
      ...workspaceShape,
      ...userShape,
      date: z.string().optional().describe("Day all entries belong to, unless one sets its own"),
      entries: z
        .array(
          z.object({
            ...entryShape,
            date: z.string().optional().describe("Overrides the shared date"),
            start: z.string().describe("Start time, local"),
            end: z.string().optional(),
            duration: z.string().optional(),
          }),
        )
        .min(1)
        .max(50)
        .describe("The entries to write, in order"),
      stop_on_error: z
        .boolean()
        .optional()
        .describe("Abort at the first failure instead of reporting per entry (default false)"),
    },
    {
      title: "Log a whole day",
      description:
        "Writes several finished entries in one call — a full workday reconstructed from notes or " +
        "commits. Each entry reports its own result, so one bad line does not lose the rest.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const userId = args.user_id ? await client.userId(args.user_id) : undefined;
      const me = await client.me();
      const path =
        userId && userId !== me.id
          ? `/workspaces/${workspaceId}/user/${userId}/time-entries`
          : `/workspaces/${workspaceId}/time-entries`;

      const results: unknown[] = [];
      let written = 0;
      let seconds = 0;

      for (const [index, item] of args.entries.entries()) {
        try {
          const date = resolveDate(item.date ?? args.date ?? "today", timeZone);
          const start = parseInstant(item.start, timeZone, date);
          if (!item.end && !item.duration) throw new Error("Neither `end` nor `duration` was given.");
          const end = item.end
            ? parseInstant(item.end, timeZone, date)
            : new Date(start.getTime() + parseDuration(item.duration!) * 1000);
          if (end.getTime() <= start.getTime()) throw new Error("Ends before it starts.");

          const refs = await resolveEntryRefs(client, workspaceId, item, true);
          const entry = await client.post<TimeEntry>(path, {
            ...compact({
              description: item.description,
              projectId: refs.projectId,
              taskId: refs.taskId,
              tagIds: refs.tagIds,
              billable: item.billable,
            }),
            start: toClockifyTime(start),
            end: toClockifyTime(end),
          });
          written += 1;
          seconds += Math.round((end.getTime() - start.getTime()) / 1000);
          results.push({ index, ok: true, ...summarise(entry, timeZone, item.project_name) });
        } catch (error) {
          results.push({ index, ok: false, error: (error as Error).message, entry: item });
          if (args.stop_on_error) break;
        }
      }

      return json(
        { written, failed: args.entries.length - written, total: humanDuration(seconds), results },
        `Wrote ${written} of ${args.entries.length} entries (${humanDuration(seconds)}).`,
      );
    },
  );

  defineTool(
    ctx,
    "clockify_list_time_entries",
    {
      ...workspaceShape,
      ...userShape,
      ...pagingShape,
      date: z.string().optional().describe("A single day: `2026-08-05`, `today`, `yesterday`"),
      from: z.string().optional().describe("Range start, local (`2026-08-01` or a full ISO instant)"),
      to: z.string().optional().describe("Range end, local; inclusive of that day when a date is given"),
      project_id: z.string().optional().describe("Only this project"),
      project_name: z.string().optional().describe("Only this project, by name"),
      description: z.string().optional().describe("Only entries whose description contains this"),
      in_progress: z.boolean().optional().describe("Only the running entry"),
    },
    {
      title: "List time entries",
      description:
        "Time entries for a person over a day or a range, newest first, with a total. Without any " +
        "date arguments it returns today.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      const timeZone = await client.timeZone();
      const projectId = await resolveProjectId(client, workspaceId, args.project_id, args.project_name);

      let start: Date;
      let end: Date;
      if (args.from || args.to) {
        const fromDate = args.from ?? today(timeZone);
        start = parseInstant(fromDate, timeZone);
        // A bare date as `to` means "through the end of that day", not midnight.
        end = args.to
          ? /^\d{4}-\d{2}-\d{2}$/.test(args.to.trim()) || ["today", "yesterday", "tomorrow"].includes(args.to.trim().toLowerCase())
            ? dayBounds(args.to, timeZone).end
            : parseInstant(args.to, timeZone)
          : new Date();
      } else {
        ({ start, end } = dayBounds(args.date ?? "today", timeZone));
      }

      const query = {
        start: toClockifyTime(start),
        end: toClockifyTime(end),
        project: projectId,
        description: args.description,
        "in-progress": args.in_progress,
        hydrated: true,
      };

      const entries = args.all_pages
        ? await client.listAll<TimeEntry>(
            `/workspaces/${workspaceId}/user/${userId}/time-entries`,
            query,
            args.limit ?? 500,
          )
        : (
            await client.list<TimeEntry>(`/workspaces/${workspaceId}/user/${userId}/time-entries`, {
              ...query,
              page: args.page,
              "page-size": args.page_size,
            })
          ).data;

      const seconds = entries.reduce(
        (sum, entry) => sum + isoDurationToSeconds(entry.timeInterval?.duration),
        0,
      );
      return json({
        range_local: `${inZone(start, timeZone)} → ${inZone(end, timeZone)}`,
        time_zone: timeZone,
        count: entries.length,
        total: humanDuration(seconds),
        total_seconds: seconds,
        items: entries.map((entry) => summarise(entry, timeZone)),
      });
    },
  );

  defineTool(
    ctx,
    "clockify_time_summary",
    {
      ...workspaceShape,
      ...userShape,
      date: z.string().optional().describe("A single day"),
      from: z.string().optional().describe("Range start"),
      to: z.string().optional().describe("Range end, inclusive"),
      group_by: z
        .enum(["project", "task", "description", "day", "tag"])
        .optional()
        .describe("What to total by (default project)"),
    },
    {
      title: "Summarise tracked time",
      description:
        "Totals per project, task, day or tag for a period — computed from the entries themselves, " +
        "so it also works on the free plan, where the Reports API is not available.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const userId = await client.userId(args.user_id);
      const timeZone = await client.timeZone();

      const start = args.from
        ? parseInstant(args.from, timeZone)
        : dayBounds(args.date ?? "today", timeZone).start;
      const end = args.to
        ? dayBounds(args.to, timeZone).end
        : args.from
          ? new Date()
          : dayBounds(args.date ?? "today", timeZone).end;

      const entries = await client.listAll<TimeEntry>(
        `/workspaces/${workspaceId}/user/${userId}/time-entries`,
        { start: toClockifyTime(start), end: toClockifyTime(end), hydrated: true },
        5000,
      );

      const buckets = new Map<string, number>();
      let total = 0;
      for (const entry of entries) {
        const seconds = isoDurationToSeconds(entry.timeInterval?.duration);
        total += seconds;
        const keys =
          args.group_by === "tag"
            ? (entry.tags?.map((tag) => tag.name) ?? ["(no tag)"])
            : [
                args.group_by === "description"
                  ? entry.description || "(no description)"
                  : args.group_by === "task"
                    ? (entry.task?.name ?? "(no task)")
                    : args.group_by === "day"
                      ? inZone(new Date(entry.timeInterval.start), timeZone).slice(0, 10)
                      : (entry.project?.name ?? "(no project)"),
              ];
        for (const key of keys.length ? keys : ["(no tag)"]) {
          buckets.set(key, (buckets.get(key) ?? 0) + seconds);
        }
      }

      const groups = [...buckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, seconds]) => ({
          name,
          duration: humanDuration(seconds),
          seconds,
          share: total ? `${Math.round((seconds / total) * 100)}%` : "0%",
        }));

      return json({
        range_local: `${inZone(start, timeZone)} → ${inZone(end, timeZone)}`,
        grouped_by: args.group_by ?? "project",
        entries: entries.length,
        total: humanDuration(total),
        total_seconds: total,
        groups,
      });
    },
  );

  defineTool(
    ctx,
    "clockify_get_time_entry",
    {
      ...workspaceShape,
      time_entry_id: z.string().describe("Time entry id"),
    },
    {
      title: "Get a time entry",
      description: "One time entry in full, with its project, task and tags resolved.",
      readOnly: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const entry = await client.get<TimeEntry>(
        `/workspaces/${workspaceId}/time-entries/${args.time_entry_id}`,
        { hydrated: true },
      );
      return json({ ...summarise(entry, timeZone), raw: entry });
    },
  );

  defineTool(
    ctx,
    "clockify_update_time_entry",
    {
      ...workspaceShape,
      ...entryShape,
      time_entry_id: z.string().describe("Time entry id"),
      date: z.string().optional().describe("Move the entry to this day"),
      start: z.string().optional().describe("New start time"),
      end: z.string().optional().describe("New end time"),
      duration: z.string().optional().describe("New length, keeping the start"),
    },
    {
      title: "Update a time entry",
      description:
        "Changes description, project, tags or times. Clockify replaces the whole entry on update, " +
        "so the current values are read first and only the given fields change.",
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      const timeZone = await client.timeZone();
      const current = await client.get<TimeEntry>(
        `/workspaces/${workspaceId}/time-entries/${args.time_entry_id}`,
      );

      const day = args.date ? resolveDate(args.date, timeZone) : undefined;
      const currentStart = new Date(current.timeInterval.start);
      const start = args.start
        ? parseInstant(args.start, timeZone, day)
        : day
          ? parseInstant(inZone(currentStart, timeZone).slice(11), timeZone, day)
          : currentStart;

      let end = current.timeInterval.end ? new Date(current.timeInterval.end) : null;
      if (args.end) end = parseInstant(args.end, timeZone, day);
      else if (args.duration) end = new Date(start.getTime() + parseDuration(args.duration) * 1000);
      else if (end && (args.start || day)) {
        // Moving the start without a new end keeps the length the entry had.
        const length = new Date(current.timeInterval.end!).getTime() - currentStart.getTime();
        end = new Date(start.getTime() + length);
      }

      const refs = await resolveEntryRefs(client, workspaceId, args);
      const entry = await client.put<TimeEntry>(
        `/workspaces/${workspaceId}/time-entries/${args.time_entry_id}`,
        {
          start: toClockifyTime(start),
          end: end ? toClockifyTime(end) : null,
          description: args.description ?? current.description,
          projectId: refs.projectId ?? current.projectId,
          taskId: refs.taskId ?? current.taskId,
          tagIds: refs.tagIds ?? current.tagIds,
          billable: args.billable ?? current.billable,
        },
      );
      return json(summarise(entry, timeZone, args.project_name), "Updated.");
    },
  );

  defineTool(
    ctx,
    "clockify_delete_time_entry",
    {
      ...workspaceShape,
      time_entry_id: z.string().describe("Time entry id"),
      confirm: z.literal(true).describe("Must be true — the entry is gone for good"),
    },
    {
      title: "Delete a time entry",
      description: "Removes a time entry permanently. Requires `confirm: true`.",
      destructive: true,
    },
    async (args) => {
      const workspaceId = await client.workspaceId(args.workspace_id);
      await client.delete(`/workspaces/${workspaceId}/time-entries/${args.time_entry_id}`);
      return json({ deleted: args.time_entry_id });
    },
  );
}
