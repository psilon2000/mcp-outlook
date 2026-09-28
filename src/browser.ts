import { createHash, randomBytes } from "node:crypto";
import { chromium, Browser, BrowserContext, Locator, Page } from "playwright";
import { EventInput, PreviewStore } from "./core.js";
import { verifiedOwaSpki } from "./tls.js";
import { UiMap } from "./ui.js";

const BASE = "https://web.modulbank.ru/owa/";

function guard(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

async function one(locator: Locator): Promise<Locator> {
  await locator.first().waitFor({ state: "attached", timeout: 5000 }).catch(() => { throw new Error("ui_missing_or_ambiguous"); });
  if (await locator.count() !== 1) throw new Error("ui_missing_or_ambiguous");
  return locator;
}

function shorten(s: string, max: number) { return s.trim().slice(0, max); }

function escapeHtml(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function approve(context: BrowserContext, summary: string): Promise<boolean> {
  const tab = await context.newPage();
  try {
    await tab.setContent(`<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"></head><body><h1>Подтвердить действие в OWA</h1><pre style="white-space:pre-wrap">${escapeHtml(summary)}</pre><button onclick="document.body.dataset.decision='yes'">Подтвердить один раз</button><button onclick="document.body.dataset.decision='no'">Отмена</button></body></html>`);
    await tab.bringToFront();
    await tab.waitForFunction(() => !!document.body.dataset.decision, undefined, { timeout: 120_000 });
    return await tab.locator("body").getAttribute("data-decision") === "yes";
  } catch { return false; }
  finally { await tab.close(); }
}

export class BrowserSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private selectedOwner?: string;
  private selectedDate?: string;
  private events = new Map<string, { index: number; stableId: string; owner: string; date: string; access: string }>();
  private mails = new Map<string, { folder: string; index: number; stableId: string; subject: string; sender: string; time: string; unread: string | null }>();
  private calendarAddsAttempted = new Set<string>();
  private eventWritesAttempted = new Set<string>();
  readonly previews = new PreviewStore();

  constructor(private readonly ui?: UiMap, testing?: { page: Page; context: BrowserContext }) {
    if (testing) { this.page = testing.page; this.context = testing.context; }
  }

  async start() {
    guard(!this.browser, "session_already_open");
    guard(this.ui, "ui_not_calibrated");
    const pin = await verifiedOwaSpki();
    this.browser = await chromium.launch({ headless: false, args: [`--ignore-certificate-errors-spki-list=${pin}`] });
    this.context = await this.browser.newContext({ acceptDownloads: false });
    this.page = await this.context.newPage();
    try { await this.page.goto(`${BASE}#path=/calendar/view/Day`, { waitUntil: "domcontentloaded", timeout: 30_000 }); }
    catch { await this.close(); throw new Error("owa_unreachable"); }
    return { state: "login_in_visible_browser", uiCalibrated: !!this.ui };
  }

  async status() {
    if (!this.page || this.page.isClosed()) return { state: "closed" };
    if (!this.ui) return { state: "ui_not_calibrated" };
    const authenticated = this.page.url().startsWith(BASE) && await this.page.locator(this.ui.appReady).count() === 1;
    return { state: authenticated ? "authenticated" : "login_pending" };
  }

  private async ready(): Promise<Page> {
    const status = await this.status();
    guard(status.state === "authenticated" && this.page, status.state);
    return this.page;
  }

  async close() {
    this.previews.clear();
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
    this.context = undefined;
    this.selectedOwner = undefined;
    this.selectedDate = undefined;
    this.events.clear();
    this.mails.clear();
    this.calendarAddsAttempted.clear();
    this.eventWritesAttempted.clear();
  }

  async listMail(folder: string, limit: number, query?: string) {
    const page = await this.ready();
    const ui = this.ui?.mail;
    guard(ui?.safeToList, "mail_listing_not_verified_safe");
    guard(folder.length > 0 && folder.length <= 100 && limit >= 1 && limit <= 25, "invalid_mail_query");
    this.mails.clear();
    await page.goto(`${BASE}${ui.route}`, { waitUntil: "domcontentloaded" });
    await one(page.locator(ui.viewReady));
    const folders = page.locator(ui.folder);
    await folders.first().waitFor({ state: "attached", timeout: 5000 }).catch(() => { throw new Error("mail_folder_not_found_or_ambiguous"); });
    const countFolders = await folders.count();
    const matching = [];
    for (let i = 0; i < countFolders; i++) if (await folders.nth(i).getAttribute(ui.folderNameAttribute) === folder) matching.push(folders.nth(i));
    guard(matching.length === 1, "mail_folder_not_found_or_ambiguous");
    await matching[0].click();
    await page.waitForFunction(([selector, name]) => document.querySelector(selector)?.textContent?.trim() === name, [ui.activeFolderName, folder], { timeout: 5000 })
      .catch(() => { throw new Error("mail_folder_not_selected"); });
    if (query) {
      guard(ui.searchInput && ui.searchSubmit && ui.searchResultMarker && ui.searchAppliedAttribute && query.length <= 200, "mail_search_not_calibrated");
      await (await one(page.locator(ui.searchInput))).fill(query);
      await (await one(page.locator(ui.searchSubmit))).click();
      await page.waitForFunction(([selector, attribute, expected]) => document.querySelector(selector)?.getAttribute(attribute) === expected,
        [ui.searchResultMarker, ui.searchAppliedAttribute, query], { timeout: 5000 }).catch(() => { throw new Error("mail_search_not_applied"); });
    }
    await page.waitForFunction(({ selector, folderAttr, queryAttr, readyAttr, folderName, expectedQuery }) => {
      const list = document.querySelector(selector);
      return list?.getAttribute(folderAttr) === folderName && list.getAttribute(queryAttr) === expectedQuery && list.getAttribute(readyAttr) === "true";
    }, { selector: ui.listState, folderAttr: ui.listFolderAttribute, queryAttr: ui.listQueryAttribute, readyAttr: ui.listReadyAttribute, folderName: folder, expectedQuery: query ?? "" }, { timeout: 5000 })
      .catch(() => { throw new Error("mail_list_not_ready"); });
    const rows = page.locator(ui.rows);
    const count = Math.min(await rows.count(), limit);
    const result = [];
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const id = randomBytes(16).toString("hex");
      const stableId = await row.getAttribute(ui.idAttribute);
      guard(stableId, "mail_stable_id_missing");
      const item = {
        id,
        subject: shorten(await (await one(row.locator(ui.subject))).innerText(), 200),
        sender: shorten(await (await one(row.locator(ui.sender))).innerText(), 200),
        time: shorten(await (await one(row.locator(ui.time))).innerText(), 100),
        unread: await row.getAttribute(ui.unreadAttribute),
      };
      this.mails.set(id, { folder, index: i, stableId, subject: item.subject, sender: item.sender, time: item.time, unread: item.unread });
      result.push(item);
    }
    // Fail rather than report a "read-only" result after an unexpected change.
    for (const item of result) {
      if (await rows.nth(this.mails.get(item.id)!.index).getAttribute(ui.unreadAttribute) !== item.unread) throw new Error("mail_flag_changed");
    }
    return result;
  }

  async readMail(id: string, maxChars: number) {
    const page = await this.ready();
    const ui = this.ui?.mail;
    guard(ui?.safeToOpen, "mail_open_not_verified_safe");
    guard(maxChars > 0 && maxChars <= 4000, "invalid_mail_query");
    const selected = this.mails.get(id);
    guard(selected, "mail_selection_expired");
    this.mails.clear();
    const row = page.locator(ui.rows).nth(selected.index);
    guard(await row.count() === 1, "mail_not_found");
    guard(await row.getAttribute(ui.idAttribute) === selected.stableId &&
      shorten(await (await one(row.locator(ui.subject))).innerText(), 200) === selected.subject &&
      shorten(await (await one(row.locator(ui.sender))).innerText(), 200) === selected.sender &&
      shorten(await (await one(row.locator(ui.time))).innerText(), 100) === selected.time &&
      await row.getAttribute(ui.unreadAttribute) === selected.unread, "mail_selection_expired");
    await row.click();
    await page.waitForFunction(([selector, attribute, expected]) => document.querySelector(selector)?.getAttribute(attribute) === expected,
      [ui.paneMessageId, ui.paneIdAttribute, selected.stableId], { timeout: 5000 }).catch(() => { throw new Error("mail_pane_identity_mismatch"); });
    const body = await (await one(page.locator(ui.messageBody))).innerText();
    await page.waitForTimeout(250);
    const after = await row.getAttribute(ui.unreadAttribute);
    if (after !== selected.unread) throw new Error("mail_flag_changed");
    return { body: shorten(body, maxChars), truncated: body.length > maxChars };
  }

  async calendarDay(date: string, limit: number, owner: string, timeZone: string) {
    const page = await this.ready();
    const ui = this.ui?.calendar;
    guard(ui, "calendar_ui_not_calibrated");
    this.selectedOwner = undefined;
    this.selectedDate = undefined;
    this.events.clear();
    guard(/^\d{4}-\d{2}-\d{2}$/.test(date) && limit >= 1 && limit <= 50, "invalid_calendar_query");
    guard(ui.timeZone === timeZone, "calendar_time_zone_not_calibrated");
    guard(owner.length > 0 && owner.length <= 255, "invalid_calendar_owner");
    await page.goto(`${BASE}#path=/calendar/view/Day`, { waitUntil: "domcontentloaded" });
    const calendars = page.locator(ui.calendarItems);
    await calendars.first().waitFor({ state: "attached", timeout: 5000 }).catch(() => { throw new Error("calendar_selection_not_verified"); });
    const matching = [];
    for (let i = 0; i < await calendars.count(); i++) if ((await calendars.nth(i).getAttribute(ui.calendarNameAttribute))?.trim() === owner) matching.push(calendars.nth(i));
    guard(matching.length === 1, "calendar_selection_not_verified");
    await matching[0].click();
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent?.trim() === expected,
      { selector: ui.selectedCalendar, expected: owner }, { timeout: 5000 })
      .catch(() => { throw new Error("calendar_selection_not_verified"); });
    await (await one(page.locator(ui.dateInput))).fill(date);
    await (await one(page.locator(ui.dateApply))).click();
    await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.getAttribute("data-date") === expected,
      { selector: ui.activeDate, expected: date }, { timeout: 5000 })
      .catch(() => { throw new Error("calendar_date_navigation_not_verified"); });
    await page.waitForFunction(({ selector, dateAttr, ownerAttr, readyAttr, dateValue, ownerValue }) => {
      const list = document.querySelector(selector);
      return list?.getAttribute(dateAttr) === dateValue && list.getAttribute(ownerAttr) === ownerValue && list.getAttribute(readyAttr) === "true";
    }, { selector: ui.eventListState, dateAttr: ui.eventListDateAttribute, ownerAttr: ui.eventListOwnerAttribute, readyAttr: ui.eventListReadyAttribute, dateValue: date, ownerValue: owner }, { timeout: 5000 })
      .catch(() => { throw new Error("calendar_list_not_ready"); });
    const events = page.locator(ui.eventItems);
    guard(await events.count() <= 500, "too_many_calendar_events");
    const result = [];
    for (let i = 0; i < await events.count() && result.length < limit; i++) {
      const item = events.nth(i);
      if (await item.getAttribute(ui.eventOwnerAttribute) !== owner) continue;
      const access = await item.getAttribute(ui.detailAccessAttribute);
      guard(access === "full" || access === "busy", "calendar_access_unknown");
      const stableId = await item.getAttribute(ui.eventIdAttribute);
      guard(stableId, "event_stable_id_missing");
      const subject = access === "full" ? shorten(await (await one(item.locator(ui.subject))).innerText(), 255) : null;
      const when = shorten(await (await one(item.locator(ui.when))).innerText(), 120);
      guard(await item.getAttribute(ui.eventOwnerAttribute) === owner && await item.getAttribute(ui.eventIdAttribute) === stableId &&
        await item.getAttribute(ui.detailAccessAttribute) === access, "calendar_list_changed");
      const id = randomBytes(16).toString("hex");
      this.events.set(id, { index: i, stableId, owner, date, access });
      result.push({ id, owner, access, subject, when });
    }
    this.selectedOwner = owner;
    this.selectedDate = date;
    return result;
  }

  async eventDetails(id: string) {
    const page = await this.ready();
    const ui = this.ui?.calendar;
    guard(ui, "calendar_ui_not_calibrated");
    const selected = this.events.get(id);
    guard(selected && this.selectedOwner === selected.owner && this.selectedDate === selected.date, "calendar_selection_expired");
    this.events.clear();
    guard((await (await one(page.locator(ui.activeDate))).getAttribute("data-date")) === selected.date &&
      (await (await one(page.locator(ui.selectedCalendar))).innerText()).trim() === selected.owner, "calendar_selection_expired");
    const event = page.locator(ui.eventItems).nth(selected.index);
    guard(await event.count() === 1, "event_not_found");
    guard(await event.getAttribute(ui.eventOwnerAttribute) === selected.owner &&
      await event.getAttribute(ui.eventIdAttribute) === selected.stableId, "calendar_selection_expired");
    const access = await event.getAttribute(ui.detailAccessAttribute);
    guard(access === selected.access, "calendar_access_unknown");
    if (access === "busy") return { owner: selected.owner, access, details: null };
    await event.click();
    await page.waitForFunction(({ selector, attribute, expected }) => document.querySelector(selector)?.getAttribute(attribute) === expected,
      { selector: ui.details, attribute: ui.detailsIdAttribute, expected: selected.stableId }, { timeout: 5000 })
      .catch(() => { throw new Error("event_details_identity_mismatch"); });
    return { owner: selected.owner, access, details: shorten(await (await one(page.locator(ui.details))).innerText(), 4000) };
  }

  async addCalendar(address: string) {
    const page = await this.ready();
    const ui = this.ui?.calendar;
    guard(ui?.addButton && ui.addAddress && ui.addSelectedAddress && ui.addSave && ui.addedCalendar && this.context, "add_calendar_not_calibrated");
    guard(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) && address.length < 255, "invalid_address");
    guard(!this.calendarAddsAttempted.has(address.toLowerCase()), "calendar_add_already_attempted");
    await page.goto(`${BASE}#path=/calendar/view/Day`, { waitUntil: "domcontentloaded" });
    await (await one(page.locator(ui.addButton))).click();
    await (await one(page.locator(ui.addAddress))).fill(address);
    const resolved = shorten(await (await one(page.locator(ui.addSelectedAddress))).innerText(), 255);
    guard(resolved.toLowerCase() === address.toLowerCase(), "calendar_address_mismatch");
    guard(await approve(this.context, `Добавить чужой календарь: ${resolved}`), "user_cancelled");
    this.calendarAddsAttempted.add(address.toLowerCase());
    try {
      await (await one(page.locator(ui.addSave))).click();
      const added = await (await one(page.locator(ui.addedCalendar))).innerText();
      guard(added.toLowerCase().includes(resolved.toLowerCase()), "calendar_add_result_uncertain");
    } catch { throw new Error("calendar_add_result_uncertain"); }
    return { state: "added", address: resolved };
  }

  private async fill(page: Page, selector: string, text: string) { await (await one(page.locator(selector))).fill(text); }

  async createEvent(id: string) {
    const page = await this.ready();
    const ui = this.ui?.editor;
    guard(ui && this.context, "event_editor_not_calibrated");
    const event = this.previews.peek(id).event;
    const fingerprint = createHash("sha256").update(JSON.stringify({
      subject: event.subject, start: event.start, end: event.end, timeZone: event.timeZone,
      attendees: event.attendees.map((a) => `${a.role}:${a.email.toLowerCase()}`).sort(),
      recurrence: event.recurrence ? { ...event.recurrence, weekdays: event.recurrence.weekdays?.slice().sort((a, b) => a - b) } : null,
    })).digest("hex");
    guard(!this.eventWritesAttempted.has(fingerprint), "event_write_already_attempted");
    guard(ui.timeZoneValues[event.timeZone], "time_zone_not_calibrated");
    guard(ui.frequencyValues.none, "recurrence_none_not_calibrated");
    if (event.allDay) guard(ui.allDay, "all_day_not_calibrated");
    for (const a of event.attendees) guard(ui.attendeeInputs[a.role] && ui.resolvedAttendees[a.role], "attendee_role_not_calibrated");
    if (event.recurrence) {
      const r = event.recurrence;
      guard(ui.recurrenceFrequency && ui.recurrenceInterval && ui.recurrenceEndType && ui.recurrenceEndValue, "recurrence_ui_not_calibrated");
      guard(ui.frequencyValues[r.frequency] && ui.endValues[r.ends.type], "recurrence_option_not_calibrated");
      if (r.weekdays) guard([1, 2, 3, 4, 5, 6, 7].every((n) => ui.recurrenceWeekdays[n]), "recurrence_weekday_not_calibrated");
      if (r.monthDay) guard(ui.recurrenceMonthDay, "recurrence_month_rule_not_calibrated");
      if (r.month) guard(ui.recurrenceMonth, "recurrence_month_rule_not_calibrated");
      if (r.ordinal) guard(ui.recurrenceOrdinal && ui.ordinalValues[r.ordinal], "recurrence_month_rule_not_calibrated");
      if (r.frequency === "monthly" || r.frequency === "yearly") guard(ui.recurrenceMode && ui.recurrenceModeValues, "recurrence_mode_not_calibrated");
    }
    this.previews.take(id); // consumed before any page interaction
    await page.goto(`${BASE}#path=/calendar/view/Day`, { waitUntil: "domcontentloaded" });
    await (await one(page.locator(ui.newButton))).click();
    await this.fill(page, ui.subject, event.subject);
    await this.fill(page, ui.start, event.start);
    await this.fill(page, ui.end, event.end);
    await this.fill(page, ui.body, event.body);
    await this.fill(page, ui.location, event.location);
    await (await one(page.locator(ui.timeZone))).selectOption(ui.timeZoneValues[event.timeZone]);
    if (event.allDay) await (await one(page.locator(ui.allDay!))).check();
    if (event.attendees.length) {
      for (const a of event.attendees) {
        const input = await one(page.locator(ui.attendeeInputs[a.role]));
        await input.fill(a.email);
        await input.press("Enter");
      }
    }
    if (event.recurrence) {
      const r = event.recurrence;
      await (await one(page.locator(ui.recurrenceFrequency!))).selectOption(ui.frequencyValues[r.frequency]);
      await this.fill(page, ui.recurrenceInterval!, `${r.interval}`);
      if (r.frequency === "monthly" || r.frequency === "yearly") await (await one(page.locator(ui.recurrenceMode!))).selectOption(r.ordinal ? ui.recurrenceModeValues!.ordinal : ui.recurrenceModeValues!.monthDay);
      if (r.weekdays) for (const day of [1, 2, 3, 4, 5, 6, 7]) {
        const box = await one(page.locator(ui.recurrenceWeekdays[day]));
        if (r.weekdays.includes(day)) await box.check(); else await box.uncheck();
      }
      if (r.monthDay) { guard(ui.recurrenceMonthDay, "recurrence_month_rule_not_calibrated"); await this.fill(page, ui.recurrenceMonthDay, `${r.monthDay}`); }
      if (r.month) { guard(ui.recurrenceMonth, "recurrence_month_rule_not_calibrated"); await (await one(page.locator(ui.recurrenceMonth))).selectOption(`${r.month}`); }
      if (r.ordinal) {
        guard(ui.recurrenceOrdinal && ui.ordinalValues[r.ordinal], "recurrence_month_rule_not_calibrated");
        await (await one(page.locator(ui.recurrenceOrdinal))).selectOption(ui.ordinalValues[r.ordinal]);
      }
      await (await one(page.locator(ui.recurrenceEndType!))).selectOption(ui.endValues[r.ends.type]);
      if (r.ends.type !== "never") await this.fill(page, ui.recurrenceEndValue!, r.ends.type === "count" ? `${r.ends.count}` : r.ends.date);
    } else await (await one(page.locator(ui.recurrenceFrequency))).selectOption(ui.frequencyValues.none);
    const values = {
      subject: await (await one(page.locator(ui.subject))).inputValue(),
      start: await (await one(page.locator(ui.start))).inputValue(),
      end: await (await one(page.locator(ui.end))).inputValue(),
      body: ui.bodyMode === "contenteditable" ? await (await one(page.locator(ui.body))).innerText() : await (await one(page.locator(ui.body))).inputValue(),
      location: await (await one(page.locator(ui.location))).inputValue(),
      timeZone: await (await one(page.locator(ui.timeZone))).inputValue(),
      allDay: ui.allDay ? await (await one(page.locator(ui.allDay))).isChecked() : false,
      attendees: await Promise.all((["required", "optional", "resource"] as const).map(async (role) => ({ role, emails: ui.resolvedAttendees[role] ? (await page.locator(ui.resolvedAttendees[role]).allInnerTexts()).map((v) => v.trim().toLowerCase()) : [] }))),
    };
    guard(values.subject === event.subject && values.start === event.start && values.end === event.end && values.body === event.body && values.location === event.location && values.timeZone === ui.timeZoneValues[event.timeZone] && values.allDay === event.allDay, "owa_form_mismatch");
    const frequencyValue = await (await one(page.locator(ui.recurrenceFrequency))).inputValue();
    guard(frequencyValue === (event.recurrence ? ui.frequencyValues[event.recurrence.frequency] : ui.frequencyValues.none), "owa_recurrence_mismatch");
    for (const role of ["required", "optional", "resource"] as const) {
      const expected = event.attendees.filter((a) => a.role === role).map((a) => a.email.toLowerCase()).sort();
      const actual = values.attendees.filter((a) => a.role === role).flatMap((a) => a.emails).sort();
      guard(JSON.stringify(expected) === JSON.stringify(actual), "owa_recipient_mismatch");
    }
    let actualRecurrence: unknown = null;
    if (event.recurrence) {
      const r = event.recurrence;
      guard(await (await one(page.locator(ui.recurrenceInterval!))).inputValue() === `${r.interval}`, "owa_recurrence_mismatch");
      guard(await (await one(page.locator(ui.recurrenceEndType!))).inputValue() === ui.endValues[r.ends.type], "owa_recurrence_mismatch");
      if (r.weekdays) for (const day of [1, 2, 3, 4, 5, 6, 7]) guard(await (await one(page.locator(ui.recurrenceWeekdays[day]))).isChecked() === r.weekdays.includes(day), "owa_recurrence_mismatch");
      if (r.monthDay) guard(await (await one(page.locator(ui.recurrenceMonthDay!))).inputValue() === `${r.monthDay}`, "owa_recurrence_mismatch");
      if (r.month) guard(await (await one(page.locator(ui.recurrenceMonth!))).inputValue() === `${r.month}`, "owa_recurrence_mismatch");
      if (r.ordinal) guard(await (await one(page.locator(ui.recurrenceOrdinal!))).inputValue() === ui.ordinalValues[r.ordinal], "owa_recurrence_mismatch");
      if (r.frequency === "monthly" || r.frequency === "yearly") guard(await (await one(page.locator(ui.recurrenceMode!))).inputValue() === (r.ordinal ? ui.recurrenceModeValues!.ordinal : ui.recurrenceModeValues!.monthDay), "owa_recurrence_mismatch");
      if (r.ends.type !== "never") guard(await (await one(page.locator(ui.recurrenceEndValue!))).inputValue() === (r.ends.type === "count" ? `${r.ends.count}` : r.ends.date), "owa_recurrence_mismatch");
      actualRecurrence = {
        frequencyValue,
        interval: await (await one(page.locator(ui.recurrenceInterval!))).inputValue(),
        weekdays: r.weekdays ? await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (day) => (await (await one(page.locator(ui.recurrenceWeekdays[day]))).isChecked()) ? day : null)).then((days) => days.filter((day) => day !== null)) : undefined,
        monthDay: r.monthDay ? await (await one(page.locator(ui.recurrenceMonthDay!))).inputValue() : undefined,
        month: r.month ? await (await one(page.locator(ui.recurrenceMonth!))).inputValue() : undefined,
        ordinal: r.ordinal ? await (await one(page.locator(ui.recurrenceOrdinal!))).inputValue() : undefined,
        mode: r.frequency === "monthly" || r.frequency === "yearly" ? await (await one(page.locator(ui.recurrenceMode!))).inputValue() : undefined,
        endValue: await (await one(page.locator(ui.recurrenceEndType!))).inputValue(),
        endCondition: r.ends.type === "never" ? null : await (await one(page.locator(ui.recurrenceEndValue!))).inputValue(),
      };
    }
    const recheck = async () => ({
      subject: await (await one(page.locator(ui.subject))).inputValue(),
      start: await (await one(page.locator(ui.start))).inputValue(),
      end: await (await one(page.locator(ui.end))).inputValue(),
      body: ui.bodyMode === "contenteditable" ? await (await one(page.locator(ui.body))).innerText() : await (await one(page.locator(ui.body))).inputValue(),
      location: await (await one(page.locator(ui.location))).inputValue(),
      timeZone: await (await one(page.locator(ui.timeZone))).inputValue(),
      allDay: ui.allDay ? await (await one(page.locator(ui.allDay))).isChecked() : false,
      attendees: await Promise.all((["required", "optional", "resource"] as const).map(async (role) => ({ role, emails: ui.resolvedAttendees[role] ? (await page.locator(ui.resolvedAttendees[role]).allInnerTexts()).map((v) => v.trim().toLowerCase()) : [] }))),
      frequencyValue: await (await one(page.locator(ui.recurrenceFrequency))).inputValue(),
      recurrence: event.recurrence ? {
        frequencyValue: await (await one(page.locator(ui.recurrenceFrequency))).inputValue(),
        interval: await (await one(page.locator(ui.recurrenceInterval!))).inputValue(),
        weekdays: event.recurrence.weekdays ? await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (day) => (await (await one(page.locator(ui.recurrenceWeekdays[day]))).isChecked()) ? day : null)).then((days) => days.filter((day) => day !== null)) : undefined,
        monthDay: event.recurrence.monthDay ? await (await one(page.locator(ui.recurrenceMonthDay!))).inputValue() : undefined,
        month: event.recurrence.month ? await (await one(page.locator(ui.recurrenceMonth!))).inputValue() : undefined,
        ordinal: event.recurrence.ordinal ? await (await one(page.locator(ui.recurrenceOrdinal!))).inputValue() : undefined,
        mode: event.recurrence.frequency === "monthly" || event.recurrence.frequency === "yearly" ? await (await one(page.locator(ui.recurrenceMode!))).inputValue() : undefined,
        endValue: await (await one(page.locator(ui.recurrenceEndType!))).inputValue(),
        endCondition: event.recurrence.ends.type === "never" ? null : await (await one(page.locator(ui.recurrenceEndValue!))).inputValue(),
      } : null,
    });
    const beforeApproval = await recheck();
    guard(JSON.stringify(beforeApproval) === JSON.stringify({ ...values, frequencyValue, recurrence: actualRecurrence }), "owa_form_mismatch");
    const beforeSave = await page.locator(ui.saveConfirmation).first().getAttribute(ui.saveConfirmationAttribute).catch(() => null);
    guard(beforeSave !== ui.saveConfirmationValue, "save_confirmation_not_reset");
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const approvalSummary = { ...beforeApproval, recurrence: beforeApproval.recurrence ? {
      ...beforeApproval.recurrence,
      weekdayNames: beforeApproval.recurrence.weekdays?.map((day) => days[day - 1]),
    } : null };
    // Never approve based solely on arguments from a model or on a preview id.
    guard(await approve(this.context, JSON.stringify(approvalSummary, null, 2)), "user_cancelled");
    guard(JSON.stringify(beforeApproval) === JSON.stringify(await recheck()), "owa_form_mismatch");
    this.eventWritesAttempted.add(fingerprint);
    try {
      await (await one(page.locator(ui.save))).click(); // exactly one attempt
      await page.waitForFunction(({ selector, attr, expected }) => document.querySelector(selector)?.getAttribute(attr) === expected,
        { selector: ui.saveConfirmation, attr: ui.saveConfirmationAttribute, expected: ui.saveConfirmationValue }, { timeout: 5000 });
    } catch { throw new Error("event_result_uncertain"); }
    // Matching text alone is not proof of persisted fields or delivery; never invite a blind retry.
    return { state: "submitted_verify_fields_in_owa", subject: event.subject };
  }
}
