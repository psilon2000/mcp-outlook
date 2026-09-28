#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrowserSession } from "./browser.js";
import { eventInput } from "./core.js";
import { loadUiMap } from "./ui.js";

// Local configuration belongs to the operator, never to a tool argument chosen by a model.
const ui = loadUiMap(process.env.OWA_UI_MAP_FILE);
const session = new BrowserSession(ui);
const server = new McpServer({ name: "mcp-outlook", version: "0.1.0" });

function allowed(flag: string) {
  if (process.env[flag] !== "true") throw new Error("data_access_not_configured");
}

function result(data: unknown) {
  const envelope = { ok: true, data };
  return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], structuredContent: envelope };
}

// Never return Playwright errors: they may embed a snapshot of a mailbox or calendar.
const safeCodes = new Set([
  "session_already_open", "owa_unreachable", "closed", "ui_not_calibrated", "login_pending", "invalid_mail_query",
  "mail_listing_not_verified_safe", "mail_open_not_verified_safe", "mail_flag_changed", "mail_not_found", "mail_search_not_calibrated",
  "mail_selection_expired", "mail_stable_id_missing", "mail_folder_not_found_or_ambiguous", "mail_folder_not_selected", "mail_search_not_applied", "mail_list_not_ready", "mail_pane_identity_mismatch",
  "invalid_calendar_query", "invalid_calendar_owner", "calendar_ui_not_calibrated", "calendar_date_navigation_not_verified",
  "calendar_selection_not_verified", "calendar_selection_expired", "calendar_list_not_ready", "calendar_list_changed", "event_details_identity_mismatch", "event_stable_id_missing", "calendar_owner_mismatch", "calendar_time_zone_not_calibrated", "calendar_access_unknown", "too_many_calendar_events", "event_not_found",
  "add_calendar_not_calibrated", "invalid_address", "calendar_address_mismatch", "calendar_add_result_uncertain", "calendar_add_already_attempted",
  "event_editor_not_calibrated", "all_day_not_calibrated", "attendee_role_not_calibrated", "time_zone_not_calibrated", "event_write_already_attempted",
  "recurrence_ui_not_calibrated", "recurrence_none_not_calibrated", "recurrence_option_not_calibrated", "recurrence_weekday_not_calibrated",
  "recurrence_month_rule_not_calibrated", "owa_form_mismatch", "owa_recipient_mismatch", "owa_recurrence_mismatch",
  "preview_expired_or_unknown", "user_cancelled", "event_result_uncertain", "save_confirmation_not_reset", "ui_missing_or_ambiguous",
  "data_access_not_configured", "invalid_or_ambiguous_local_time", "end_must_follow_start", "all_day_requires_midnight_boundaries",
  "duplicate_attendee", "weekly_requires_weekdays", "unsupported_weekdays", "unsupported_month_rule", "unsupported_month",
  "ordinal_requires_one_weekday", "conflicting_month_rules", "invalid_month_pattern", "yearly_requires_month", "recurrence_mode_not_calibrated", "end_before_start",
]);

let pending: Promise<void> = Promise.resolve();
async function run(fn: () => Promise<unknown> | unknown) {
  const previous = pending;
  let release: () => void = () => {};
  pending = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return result(await fn()); }
  catch (error) {
    const message = error instanceof Error && safeCodes.has(error.message) ? error.message : "operation_failed";
    const envelope = { ok: false, code: message };
    return { content: [{ type: "text" as const, text: JSON.stringify(envelope) }], structuredContent: envelope, isError: true };
  }
  finally { release(); }
}

server.registerTool("start_session", { description: "Open an isolated visible OWA login window; the user types the password, not the model" }, async () => run(() => session.start()));
server.registerTool("session_status", { description: "Check whether the user has logged into the OWA window (no mailbox contents)" }, async () => run(() => session.status()));
server.registerTool("close_session", { description: "Close the OWA browser and discard previews and session cookies" }, async () => run(() => session.close()));
server.registerTool("list_mail", {
  description: "List a bounded set of message metadata only after safe reading-pane behavior has been verified",
  inputSchema: { folder: z.string().min(1), limit: z.number().int().min(1).max(25).default(10), query: z.string().max(200).optional() },
}, async (input) => run(() => { allowed("OWA_ALLOW_MAIL_METADATA"); return session.listMail(input.folder, input.limit, input.query); }));
server.registerTool("read_mail", {
  description: "Read a selected message body (may mark it read); only when the operator has configured body access and read receipt behavior",
  inputSchema: { messageId: z.string().regex(/^[0-9a-f]{32}$/), maxChars: z.number().int().min(1).max(4000).default(2000) },
}, async (input) => run(() => { allowed("OWA_ALLOW_MAIL_BODY"); return session.readMail(input.messageId, input.maxChars); }));
server.registerTool("calendar_day", {
  description: "Read event summaries of one selected calendar and date; own or delegated only when access is configured",
  inputSchema: { owner: z.string().min(1).max(255), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), timeZone: z.string().min(1), limit: z.number().int().min(1).max(50).default(25) },
}, async (input) => run(() => { allowed("OWA_ALLOW_CALENDAR_METADATA"); return session.calendarDay(input.date, input.limit, input.owner, input.timeZone); }));
server.registerTool("event_details", {
  description: "Read details of an event returned by calendar_day, with the current calendar's access level",
  inputSchema: { eventId: z.string().regex(/^[0-9a-f]{32}$/) },
}, async (input) => run(() => { allowed("OWA_ALLOW_CALENDAR_DETAILS"); return session.eventDetails(input.eventId); }));
server.registerTool("add_calendar", {
  description: "Only for a separately calibrated OWA UI map; this deployment uses the bounded calibrator CLI for persistent directory additions",
  inputSchema: { address: z.string().email() },
}, async (input) => run(() => { allowed("OWA_ALLOW_SHARED_CALENDARS"); return session.addCalendar(input.address); }));
server.registerTool("preview_event", {
  description: "Validate and preview a calendar event without saving anything. Recurrence examples are estimates until checked in OWA",
  inputSchema: eventInput.shape,
}, async (input) => run(() => session.previews.prepare(input)));
server.registerTool("create_event", {
  description: "Save a single previously previewed event after checking the resolved OWA form and one-off human approval outside the model",
  inputSchema: { previewId: z.string().regex(/^[0-9a-f]{48}$/) },
}, async (input) => run(() => { allowed("OWA_ALLOW_EVENT_WRITE"); return session.createEvent(input.previewId); }));

let closing: Promise<void> | undefined;
const stop = () => closing ??= (async () => { await session.close(); await server.close(); })();
process.on("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
process.stdin.once("end", () => { void stop().finally(() => process.exit(0)); });
process.stdin.once("close", () => { void stop().finally(() => process.exit(0)); });
await server.connect(new StdioServerTransport());
