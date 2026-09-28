import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import recurrenceLibrary from "rrule";
import { z } from "zod";

// rrule's package main is CommonJS; Node ESM does not expose its named exports.
const { RRule, Weekday } = recurrenceLibrary;

const attendee = z.object({
  email: z.string().email(),
  role: z.enum(["required", "optional", "resource"]),
});

const recurrence = z.object({
  frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().min(1).max(99).default(1),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional().describe("ISO 8601 weekdays: 1=Monday, 2=Tuesday, ..., 7=Sunday"),
  monthDay: z.number().int().min(1).max(31).optional(),
  month: z.number().int().min(1).max(12).optional(),
  ordinal: z.number().int().min(-1).max(5).refine((n) => n !== 0).optional(),
  ends: z.discriminatedUnion("type", [
    z.object({ type: z.literal("never") }),
    z.object({ type: z.literal("count"), count: z.number().int().min(1).max(1000) }),
    z.object({ type: z.literal("until"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  ]),
});

export const eventInput = z.object({
  subject: z.string().trim().min(1).max(255),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timeZone: z.string().min(1),
  allDay: z.boolean().default(false),
  body: z.string().max(10000).default(""),
  location: z.string().max(255).default(""),
  attendees: z.array(attendee).max(100).default([]),
  recurrence: recurrence.optional(),
});

export type EventInput = z.output<typeof eventInput>;

function localTime(value: string, zone: string) {
  const dt = DateTime.fromISO(value, { zone });
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== value || dt.getPossibleOffsets().length !== 1) {
    throw new Error("invalid_or_ambiguous_local_time");
  }
  return dt;
}

export function normalizeEvent(raw: unknown): EventInput {
  const event = eventInput.parse(raw);
  const start = localTime(event.start, event.timeZone);
  const end = localTime(event.end, event.timeZone);
  if (end.toMillis() <= start.toMillis()) throw new Error("end_must_follow_start");
  if (event.allDay && (start.hour !== 0 || start.minute !== 0 || end.hour !== 0 || end.minute !== 0)) {
    throw new Error("all_day_requires_midnight_boundaries");
  }
  const addresses = event.attendees.map((a) => a.email.toLowerCase());
  if (new Set(addresses).size !== addresses.length) throw new Error("duplicate_attendee");
  if (event.recurrence) {
    const r = event.recurrence;
    if (r.frequency === "weekly" && !r.weekdays?.length) throw new Error("weekly_requires_weekdays");
    if (r.frequency !== "weekly" && r.frequency !== "monthly" && r.frequency !== "yearly" && r.weekdays) throw new Error("unsupported_weekdays");
    if (r.frequency !== "monthly" && r.frequency !== "yearly" && (r.monthDay || r.ordinal)) throw new Error("unsupported_month_rule");
    if (r.frequency !== "yearly" && r.month) throw new Error("unsupported_month");
    if (r.ordinal && r.weekdays?.length !== 1) throw new Error("ordinal_requires_one_weekday");
    if (r.monthDay && r.ordinal) throw new Error("conflicting_month_rules");
    if ((r.frequency === "monthly" || r.frequency === "yearly") && (r.monthDay ? !!r.weekdays : !r.ordinal || r.weekdays?.length !== 1)) throw new Error("invalid_month_pattern");
    if (r.frequency === "yearly" && !r.month) throw new Error("yearly_requires_month");
    if (r.ends.type === "until" && DateTime.fromISO(r.ends.date, { zone: event.timeZone }).endOf("day") < start) throw new Error("end_before_start");
  }
  return event;
}

// These dates are advisory only: the Exchange recurrence semantics must be verified in OWA.
export function estimatedOccurrences(event: EventInput, limit = 4): string[] {
  if (!event.recurrence) return [event.start];
  const r = event.recurrence;
  const start = localTime(event.start, event.timeZone);
  const options: ConstructorParameters<typeof RRule>[0] = {
    freq: { daily: RRule.DAILY, weekly: RRule.WEEKLY, monthly: RRule.MONTHLY, yearly: RRule.YEARLY }[r.frequency],
    interval: r.interval,
    dtstart: new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute)),
    ...(r.weekdays && { byweekday: r.weekdays.map((d) => new Weekday((d - 1) % 7)) }),
    ...(r.monthDay && { bymonthday: r.monthDay }),
    ...(r.month && { bymonth: r.month }),
    ...(r.ordinal && r.weekdays && { byweekday: [new Weekday(r.weekdays[0] - 1, r.ordinal)] }),
    ...(r.ends.type === "count" && { count: r.ends.count }),
    ...(r.ends.type === "until" && { until: new Date(`${r.ends.date}T23:59:59Z`) }),
  };
  const rule = new RRule(options);
  const dates: string[] = [];
  rule.all((date) => {
    dates.push(date.toISOString().slice(0, 16));
    return dates.length < limit;
  });
  return dates;
}

export interface Preview {
  id: string;
  event: EventInput;
  expires: number;
  estimates: string[];
}

export class PreviewStore {
  private current?: Preview;

  prepare(raw: unknown): Preview {
    const event = normalizeEvent(raw);
    const preview: Preview = {
      id: randomBytes(24).toString("hex"),
      event,
      expires: Date.now() + 120_000,
      estimates: estimatedOccurrences(event),
    };
    this.current = preview;
    return preview;
  }

  peek(id: string): Preview {
    const preview = this.current;
    if (!preview || preview.id !== id || preview.expires < Date.now()) throw new Error("preview_expired_or_unknown");
    return preview;
  }

  take(id: string): Preview {
    const preview = this.peek(id);
    this.current = undefined; // no retry after an uncertain write
    return preview;
  }

  clear() { this.current = undefined; }
}
