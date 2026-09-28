import { describe, expect, it, vi } from "vitest";
import { estimatedOccurrences, normalizeEvent, PreviewStore } from "../src/core.js";

const base = { subject: "Синтетическая встреча", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow" };

describe("event contract", () => {
  it("rejects invalid order and duplicated recipients", () => {
    expect(() => normalizeEvent({ ...base, end: base.start })).toThrow("end_must_follow_start");
    expect(() => normalizeEvent({ ...base, attendees: [
      { email: "a@example.test", role: "required" }, { email: "A@example.test", role: "optional" },
    ] })).toThrow("duplicate_attendee");
  });

  it("rejects nonexistent and ambiguous local times rather than shifting a meeting", () => {
    expect(() => normalizeEvent({ ...base, start: "2026-03-29T02:30", end: "2026-03-29T04:00", timeZone: "Europe/Berlin" })).toThrow("invalid_or_ambiguous_local_time");
    expect(() => normalizeEvent({ ...base, start: "2026-10-25T02:30", end: "2026-10-25T03:30", timeZone: "Europe/Berlin" })).toThrow("invalid_or_ambiguous_local_time");
  });

  it("previews a weekly series with explicit weekdays; does not invent an Exchange rule", () => {
    const event = normalizeEvent({ ...base, recurrence: { frequency: "weekly", weekdays: [1, 4], ends: { type: "count", count: 4 } } });
    expect(estimatedOccurrences(event)).toEqual(["2026-10-01T10:00", "2026-10-05T10:00", "2026-10-08T10:00", "2026-10-12T10:00"]);
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "weekly", ends: { type: "never" } } })).toThrow("weekly_requires_weekdays");
  });

  it("checks month and end constraints without assuming Exchange's handling of 31st", () => {
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "monthly", interval: 1, monthDay: 31, ordinal: 2, weekdays: [1], ends: { type: "never" } } })).toThrow("conflicting_month_rules");
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "daily", ends: { type: "until", date: "2026-09-30" } } })).toThrow("end_before_start");
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "monthly", monthDay: 15, weekdays: [1], ends: { type: "never" } } })).toThrow("invalid_month_pattern");
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "yearly", month: 10, ends: { type: "never" } } })).toThrow("invalid_month_pattern");
    expect(() => normalizeEvent({ ...base, recurrence: { frequency: "yearly", monthDay: 1, ends: { type: "never" } } })).toThrow("yearly_requires_month");
  });
});

describe("one-off preview", () => {
  it("consumes a token once even when the downstream write fails", () => {
    const store = new PreviewStore();
    const preview = store.prepare(base);
    expect(store.take(preview.id).event.subject).toBe(base.subject);
    expect(() => store.take(preview.id)).toThrow("preview_expired_or_unknown");
  });

  it("expires after two minutes and a new preview invalidates the old one", () => {
    vi.useFakeTimers();
    try {
      const store = new PreviewStore();
      const old = store.prepare(base);
      const next = store.prepare({ ...base, subject: "Другой заголовок" });
      expect(() => store.take(old.id)).toThrow("preview_expired_or_unknown");
      vi.advanceTimersByTime(120_001);
      expect(() => store.take(next.id)).toThrow("preview_expired_or_unknown");
    } finally { vi.useRealTimers(); }
  });
});
