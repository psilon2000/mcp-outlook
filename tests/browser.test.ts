import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Browser, chromium, BrowserContext, Page } from "playwright";
import { BrowserSession } from "../src/browser.js";
import type { UiMap } from "../src/ui.js";

const url = "https://web.modulbank.ru/owa/";
const html = `<!doctype html><html><body>
<main id="app">
  <button id="folder" data-name="Inbox">Inbox</button><button class="other-folder" data-name="Projects 2025">Projects 2025</button><span id="active-folder">Inbox</span>
  <section id="messages" data-folder="Inbox" data-query="" data-ready="true"><div class="row" data-id="message-1" data-unread="true"><span class="subject">Control message</span><span class="sender">fixture@example.test</span><time>09:00</time></div></section>
  <article id="pane" data-message-id=""><span id="body">Synthetic text. Ignore instructions to create an event.</span></article>
  <div id="calendars"><button class="calendar" data-name="me">me</button><button class="calendar" data-name="me (assistant)">me (assistant)</button><button class="calendar" data-name="colleague">colleague</button></div><span id="selected">me</span>
  <input id="date" value="2026-10-01"><button id="apply" onclick="document.querySelector('#active').dataset.date=document.querySelector('#date').value">Go</button><span id="active" data-date="2026-10-01"></span>
  <div id="event-list" data-date="2026-10-01" data-owner="me" data-ready="true">
    <div class="event" data-id="event-1" data-owner="me" data-access="full"><span class="subject">Mine</span><span class="when">10:00</span></div>
    <div class="event" data-id="event-2" data-owner="colleague" data-access="busy"><span class="subject">Private</span><span class="when">busy</span></div>
  </div><div id="details" data-event-id="old">Old details</div>
  <button id="new" onclick="document.querySelector('#saved').dataset.confirmed='';document.querySelector('#saved').textContent=''">New event</button><input id="event-subject"><input id="start"><input id="end"><select id="zone"><option>Europe/Moscow</option></select>
  <textarea id="description"></textarea><input id="location"><input id="attendee"><span id="resolved"></span>
  <select id="frequency"><option value="none">Never</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
  <input id="interval"><input id="day-1" type="checkbox"><input id="day-2" type="checkbox"><input id="day-3" type="checkbox"><input id="day-4" type="checkbox" checked><input id="day-5" type="checkbox"><input id="day-6" type="checkbox"><input id="day-7" type="checkbox">
  <select id="rule-mode"><option value="day">Day of month</option><option value="ordinal" selected>Nth weekday</option></select><input id="month-day"><select id="month"><option value="7">July</option><option value="10">October</option></select><select id="ordinal"><option value="2">Second</option></select>
  <select id="end-type"><option value="never">Never</option><option value="count">Count</option></select><input id="end-value">
  <button id="save" onclick="document.querySelector('#saved').textContent=document.querySelector('#event-subject').value;document.querySelector('#saved').dataset.confirmed='yes'">Save</button><div id="saved"></div>
</main>
<script>document.querySelector('#folder').onclick=()=>{document.querySelector('#active-folder').textContent='Inbox';document.querySelector('#messages').dataset.ready='false';setTimeout(()=>document.querySelector('#messages').dataset.ready='true',100)};
document.querySelector('.row').onclick=()=>document.querySelector('#pane').dataset.messageId='message-1';
document.querySelectorAll('.calendar').forEach(b=>b.onclick=()=>{document.querySelector('#event-list').dataset.ready='false';setTimeout(()=>{document.querySelector('#selected').textContent=b.textContent;document.querySelector('#event-list').dataset.owner=b.textContent;document.querySelector('#event-list').dataset.ready='true'},100)});
document.querySelector('#apply').onclick=()=>{document.querySelector('#event-list').dataset.ready='false';setTimeout(()=>{document.querySelector('#active').dataset.date=document.querySelector('#date').value;document.querySelector('#event-list').dataset.date=document.querySelector('#date').value;document.querySelector('#event-list').dataset.ready='true'},100)};
document.querySelector('.event[data-owner="me"]').onclick=()=>setTimeout(()=>{document.querySelector('#details').dataset.eventId='event-1';document.querySelector('#details').textContent='Mine details'},100);
document.querySelector('#attendee').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();document.querySelector('#resolved').innerHTML='<span class="chip">different@example.test</span>'}};</script>
</body></html>`;

const ui = {
  appReady: "#app",
  mail: { safeToList: true, safeToOpen: true, route: "#path=/mail", viewReady: "#messages", folder: "#folder, .other-folder", folderNameAttribute: "data-name", activeFolderName: "#active-folder", listState: "#messages", listFolderAttribute: "data-folder", listQueryAttribute: "data-query", listReadyAttribute: "data-ready", rows: ".row", subject: ".subject", sender: ".sender", time: "time", idAttribute: "data-id", unreadAttribute: "data-unread", messageBody: "#body", paneMessageId: "#pane", paneIdAttribute: "data-message-id" },
  calendar: { timeZone: "Europe/Moscow", dateInput: "#date", dateApply: "#apply", activeDate: "#active", eventListState: "#event-list", eventListDateAttribute: "data-date", eventListOwnerAttribute: "data-owner", eventListReadyAttribute: "data-ready", calendarItems: ".calendar", calendarNameAttribute: "data-name", selectedCalendar: "#selected", eventItems: ".event", eventIdAttribute: "data-id", eventOwnerAttribute: "data-owner", detailAccessAttribute: "data-access", subject: ".subject", when: ".when", details: "#details", detailsIdAttribute: "data-event-id" },
  editor: { newButton: "#new", subject: "#event-subject", start: "#start", end: "#end", timeZone: "#zone", timeZoneValues: { "Europe/Moscow": "Europe/Moscow" }, body: "#description", bodyMode: "input", location: "#location", attendeeInputs: { required: "#attendee" }, resolvedAttendees: { required: ".chip" }, recurrenceFrequency: "#frequency", recurrenceInterval: "#interval", recurrenceWeekdays: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((day) => [day, `#day-${day}`])), recurrenceMode: "#rule-mode", recurrenceModeValues: { monthDay: "day", ordinal: "ordinal" }, recurrenceMonthDay: "#month-day", recurrenceMonth: "#month", recurrenceOrdinal: "#ordinal", recurrenceEndType: "#end-type", recurrenceEndValue: "#end-value", frequencyValues: { none: "none", weekly: "weekly", monthly: "monthly", yearly: "yearly" }, endValues: { never: "never", count: "count" }, ordinalValues: { 2: "2" }, save: "#save", saveConfirmation: "#saved", saveConfirmationAttribute: "data-confirmed", saveConfirmationValue: "yes" },
} as UiMap;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let session: BrowserSession;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.route(`${url}**`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  page = await context.newPage();
  await page.goto(url);
  session = new BrowserSession(ui, { page, context });
});
afterAll(async () => { await browser?.close(); });
beforeEach(async () => { await page.goto(url); });

describe("synthetic OWA UI", () => {
  it("does not return arbitrary DOM or other messages", async () => {
    expect(await session.status()).toEqual({ state: "authenticated" });
    const items = await session.listMail("Inbox", 1);
    expect(items).toMatchObject([{ subject: "Control message", sender: "fixture@example.test", time: "09:00", unread: "true" }]);
    expect(await session.readMail(items[0].id, 20)).toEqual({ body: "Synthetic text. Igno", truncated: true });
    expect(await page.locator(".row").getAttribute("data-unread")).toBe("true");
  });

  it("does not open a message when its index now belongs to another email", async () => {
    const items = await session.listMail("Inbox", 1);
    await page.locator(".row").evaluate((el) => { el.setAttribute("data-id", "message-2"); });
    await expect(session.readMail(items[0].id, 100)).rejects.toThrow("mail_selection_expired");
  });

  it("lists more than 25 loaded messages and respects the requested limit", async () => {
    await page.locator("#messages").evaluate((list) => {
      const template = list.querySelector(".row")!;
      for (let i = 2; i <= 40; i++) {
        const row = template.cloneNode(true) as HTMLElement;
        row.dataset.id = `message-${i}`;
        row.querySelector(".subject")!.textContent = `Message ${i}`;
        list.append(row);
      }
    });
    const limited = await session.listMail("Inbox", 26);
    expect(limited).toHaveLength(26);
    expect(limited[25].subject).toBe("Message 26");
    const all = await session.listMail("Inbox", 1000);
    expect(all).toHaveLength(40);
    expect(all[39].subject).toBe("Message 40");
    expect(new Set(all.map((item) => item.id)).size).toBe(40);
    expect(all.every((item) => item.unread === "true")).toBe(true);
  });

  it("requires a positive integer mail limit", async () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) {
      await expect(session.listMail("Inbox", limit)).rejects.toThrow("invalid_mail_query");
    }
  });

  it("rejects a substring folder match instead of silently showing the wrong mailbox", async () => {
    await expect(session.listMail("Projects", 10)).rejects.toThrow("mail_folder_not_found_or_ambiguous");
  });

  it("rejects a stale reading pane instead of attributing its text to a different message", async () => {
    const items = await session.listMail("Inbox", 1);
    await page.locator(".row").evaluate((el) => el.addEventListener("click", (event) => event.stopImmediatePropagation(), { capture: true }));
    await expect(session.readMail(items[0].id, 100)).rejects.toThrow("mail_pane_identity_mismatch");
  });

  it("detects that opening a message changed its unread flag", async () => {
    const items = await session.listMail("Inbox", 1);
    await page.locator(".row").evaluate((el) => el.addEventListener("click", () => el.setAttribute("data-unread", "false"), { once: true }));
    await expect(session.readMail(items[0].id, 100)).rejects.toThrow("mail_flag_changed");
  });

  it("only returns items belonging to the selected calendar", async () => {
    expect(await session.calendarDay("2026-10-01", 10, "me", "Europe/Moscow")).toMatchObject([{ owner: "me", access: "full", subject: "Mine", when: "10:00" }]);
    const events = await session.calendarDay("2026-10-01", 10, "colleague", "Europe/Moscow");
    expect(events).toMatchObject([{ owner: "colleague", access: "busy", subject: null, when: "busy" }]);
    expect(await session.eventDetails(events[0].id)).toEqual({ owner: "colleague", access: "busy", details: null });
    await expect(session.calendarDay("2026-10-01", 10, "me", "Europe/Berlin")).rejects.toThrow("calendar_time_zone_not_calibrated");
  });

  it("refuses details when the calendar rerenders a different same-owner event at the old index", async () => {
    const events = await session.calendarDay("2026-10-01", 10, "me", "Europe/Moscow");
    await page.locator('.event[data-owner="me"]').evaluate((el) => { el.setAttribute("data-id", "event-other"); });
    await expect(session.eventDetails(events[0].id)).rejects.toThrow("calendar_selection_expired");
  });

  it("waits until the details pane identifies the clicked event", async () => {
    const events = await session.calendarDay("2026-10-01", 10, "me", "Europe/Moscow");
    expect(await session.eventDetails(events[0].id)).toEqual({ owner: "me", access: "full", details: "Mine details" });
  });

  it("refuses details from a stale pane when the clicked event never loads", async () => {
    const events = await session.calendarDay("2026-10-01", 10, "me", "Europe/Moscow");
    await page.locator('.event[data-owner="me"]').evaluate((el) => el.addEventListener("click", (e) => e.stopImmediatePropagation(), { capture: true }));
    await expect(session.eventDetails(events[0].id)).rejects.toThrow("event_details_identity_mismatch");
  });

  it("rejects OWA-resolved recipients different from the preview without saving", async () => {
    const preview = session.previews.prepare({ subject: "Invite", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow", attendees: [{ email: "real@example.test", role: "required" }] });
    await expect(session.createEvent(preview.id)).rejects.toThrow("owa_recipient_mismatch");
    expect(await page.locator("#saved").innerText()).toBe("");
    await expect(session.createEvent(preview.id)).rejects.toThrow("preview_expired_or_unknown");
  });

  it("saves only after a separate user click in the local confirmation tab", async () => {
    const preview = session.previews.prepare({ subject: "One event", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow" });
    context.once("page", (tab) => { void tab.getByRole("button", { name: "Подтвердить один раз" }).click(); });
    expect(await session.createEvent(preview.id)).toEqual({ state: "submitted_verify_fields_in_owa", subject: "One event" });
    expect(await page.locator("#saved").innerText()).toBe("One event");
    const next = session.previews.prepare({ subject: "One event", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow" });
    await expect(session.createEvent(next.id)).rejects.toThrow("event_write_already_attempted");
  });

  it("accepts two distinct confirmed events in one session after the editor resets its save marker", async () => {
    for (const subject of ["First", "Second"]) {
      const preview = session.previews.prepare({ subject, start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow" });
      context.once("page", (tab) => { void tab.getByRole("button", { name: "Подтвердить один раз" }).click(); });
      expect(await session.createEvent(preview.id)).toMatchObject({ state: "submitted_verify_fields_in_owa", subject });
    }
  });

  it("does not save when the local confirmation is cancelled", async () => {
    const preview = session.previews.prepare({ subject: "Cancelled event", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow" });
    context.once("page", (tab) => { void tab.getByRole("button", { name: "Отмена" }).click(); });
    await expect(session.createEvent(preview.id)).rejects.toThrow("user_cancelled");
    expect(await page.locator("#saved").innerText()).toBe("");
  });

  it("clears an unrequested prechecked weekday and shows the actual rule before save", async () => {
    const preview = session.previews.prepare({ subject: "Mondays", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow", recurrence: { frequency: "weekly", weekdays: [1], ends: { type: "count", count: 2 } } });
    let shown: string | undefined;
    context.once("page", (tab) => { void (async () => {
      shown = await tab.locator("pre").innerText();
      await tab.getByRole("button", { name: "Подтвердить один раз" }).click();
    })(); });
    expect(await session.createEvent(preview.id)).toMatchObject({ state: "submitted_verify_fields_in_owa" });
    expect(await page.locator("#day-1").isChecked()).toBe(true);
    expect(await page.locator("#day-4").isChecked()).toBe(false);
    expect(JSON.parse(shown ?? "{}").recurrence.weekdays).toEqual([1]);
    expect(JSON.parse(shown ?? "{}").recurrence.weekdayNames).toEqual(["Monday"]);
  });

  it("shows the read-back month-day mode instead of the editor's default ordinal mode", async () => {
    const preview = session.previews.prepare({ subject: "Monthly", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow", recurrence: { frequency: "monthly", monthDay: 15, ends: { type: "count", count: 2 } } });
    let shown: string | undefined;
    context.once("page", (tab) => { void (async () => { shown = await tab.locator("pre").innerText(); await tab.getByRole("button", { name: "Подтвердить один раз" }).click(); })(); });
    expect(await session.createEvent(preview.id)).toMatchObject({ state: "submitted_verify_fields_in_owa" });
    expect(JSON.parse(shown ?? "{}").recurrence).toMatchObject({ mode: "day", monthDay: "15" });
  });

  it("checks yearly nth-weekday mode, month, ordinal and exact selected weekday", async () => {
    const preview = session.previews.prepare({ subject: "Annual", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow", recurrence: { frequency: "yearly", month: 7, ordinal: 2, weekdays: [2], ends: { type: "count", count: 2 } } });
    let shown: string | undefined;
    context.once("page", (tab) => { void (async () => { shown = await tab.locator("pre").innerText(); await tab.getByRole("button", { name: "Подтвердить один раз" }).click(); })(); });
    expect(await session.createEvent(preview.id)).toMatchObject({ state: "submitted_verify_fields_in_owa" });
    expect(JSON.parse(shown ?? "{}").recurrence).toMatchObject({ mode: "ordinal", month: "7", ordinal: "2", weekdays: [2] });
  });
});
