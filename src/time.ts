/**
 * Time handling for a time tracker.
 *
 * Clockify stores and returns everything in UTC, but people describe their work
 * in local wall-clock terms: "yesterday", "09:00 to 12:30". These helpers convert
 * between the two using an IANA zone and nothing but the Intl API, so the server
 * stays dependency-free and correct across DST boundaries.
 */

export class TimeError extends Error {}

/** Milliseconds by which `timeZone` is ahead of UTC at that instant. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour") % 24, // some locales render midnight as 24
    field("minute"),
    field("second"),
  );
  return asUtc - date.getTime();
}

/**
 * Interprets a wall-clock string (`2026-08-05T09:00:00`, no zone) as local time
 * in `timeZone`. The offset is resolved twice because the first guess uses the
 * UTC-equivalent instant, which can land on the wrong side of a DST switch.
 */
export function wallClockToUtc(wall: string, timeZone: string): Date {
  const naive = new Date(`${wall}Z`);
  if (Number.isNaN(naive.getTime())) throw new TimeError(`Cannot read the time \`${wall}\`.`);

  const firstGuess = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const corrected = new Date(naive.getTime() - zoneOffsetMs(firstGuess, timeZone));
  return corrected;
}

const ISO_WITH_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const TIME_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turns anything a person is likely to write into an instant.
 *
 *   now | 2026-08-05T07:00:00Z | 2026-08-05 09:00 | 2026-08-05 | 09:00
 *
 * Values without a zone are read as local time in `timeZone`; a bare time is
 * taken on `onDate` (default: today in that zone).
 */
export function parseInstant(
  value: string,
  timeZone: string,
  onDate?: string,
): Date {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === "now") return new Date();

  if (ISO_WITH_ZONE.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new TimeError(`Cannot read the time \`${raw}\`.`);
    return parsed;
  }

  if (DATE_ONLY.test(raw)) return wallClockToUtc(`${raw}T00:00:00`, timeZone);

  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    const [, date, hour, minute, second] = dateTime;
    return wallClockToUtc(`${date}T${hour}:${minute}:${second ?? "00"}`, timeZone);
  }

  const timeOnly = TIME_ONLY.exec(raw);
  if (timeOnly) {
    const [, hour, minute, second] = timeOnly;
    const date = onDate ?? today(timeZone);
    return wallClockToUtc(
      `${date}T${hour.padStart(2, "0")}:${minute}:${second ?? "00"}`,
      timeZone,
    );
  }

  throw new TimeError(
    `Cannot read the time \`${raw}\`. Use \`2026-08-05T07:00:00Z\`, \`2026-08-05 09:00\`, ` +
      "`2026-08-05`, `09:00` or `now`.",
  );
}

/** Calendar date (YYYY-MM-DD) as it currently reads in `timeZone`. */
export function today(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Shifts a calendar date by whole days without leaving the calendar. */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Named day expressions, so a caller can ask for "yesterday" instead of doing
 * calendar arithmetic against the wrong zone.
 */
export function resolveDate(value: string, timeZone: string): string {
  const raw = value.trim().toLowerCase();
  if (raw === "today") return today(timeZone);
  if (raw === "yesterday") return shiftDate(today(timeZone), -1);
  if (raw === "tomorrow") return shiftDate(today(timeZone), 1);
  if (DATE_ONLY.test(raw)) return raw;
  throw new TimeError(`Cannot read the date \`${value}\`. Use \`2026-08-05\`, \`today\` or \`yesterday\`.`);
}

/** Half-open [start, end) covering one local day, in UTC. */
export function dayBounds(date: string, timeZone: string): { start: Date; end: Date } {
  const day = resolveDate(date, timeZone);
  return {
    start: wallClockToUtc(`${day}T00:00:00`, timeZone),
    end: wallClockToUtc(`${shiftDate(day, 1)}T00:00:00`, timeZone),
  };
}

const CLOCK_DURATION = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?$/i;
const ISO_DURATION = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/**
 * Duration in seconds from `2h30m`, `PT2H30M`, `1.5h`, `90m` or a bare number,
 * which is read as minutes — that is what people mean by "log 90".
 */
export function parseDuration(value: string | number): number {
  if (typeof value === "number") return Math.round(value * 60);
  const raw = value.trim();
  if (!raw) throw new TimeError("Empty duration.");

  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 60);

  const iso = ISO_DURATION.exec(raw);
  if (iso && raw.toUpperCase().startsWith("P")) {
    const [, days, hours, minutes, seconds] = iso;
    const total =
      Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0);
    if (total > 0) return Math.round(total);
  }

  const clock = CLOCK_DURATION.exec(raw);
  if (clock && clock.slice(1).some(Boolean)) {
    const [, hours, minutes, seconds] = clock;
    return Math.round(
      Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0),
    );
  }

  throw new TimeError(`Cannot read the duration \`${value}\`. Use \`2h30m\`, \`90m\`, \`1.5h\` or \`PT2H30M\`.`);
}

/** Clockify wants second precision without milliseconds. */
export function toClockifyTime(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** `PT7H30M` — as returned in `timeInterval.duration` — to seconds. */
export function isoDurationToSeconds(value: string | null | undefined): number {
  if (!value) return 0;
  const match = ISO_DURATION.exec(value.trim());
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Math.round(
    Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0),
  );
}

/** `27000` to `7h 30m`, the way a timesheet reads. */
export function humanDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const rest = rounded % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (rest || parts.length === 0) parts.push(`${rest}s`);
  return parts.join(" ");
}

/** Local wall-clock rendering of an instant, for summaries people read. */
export function inZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
}
