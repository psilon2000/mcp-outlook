#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, Frame, Page } from "playwright";
import { approve } from "./browser.js";
import { readLocalCredentials } from "./credentials.js";
import { verifiedOwaSpki } from "./tls.js";

const TARGET_URL = "https://web.modulbank.ru/owa/#path=/calendar/view/Day";
const UI_ACTION = /new|create|add|calendar|appointment|meeting|event|today|day|week|month|more|details|repeat|save|cancel|нов|созд|добав|календар|событ|встреч|сегодня|день|недел|месяц|дополн|подроб|повтор|сохран|отмена/i;
const UI_FIELD = /^(time zone|timezone|часовой пояс|repeat|повтор|recurrence|frequency|частота|ends|завершение)$/i;

// Only interface structure is returned. Never output input values, whole page text, cookies, requests or a screenshot.
async function structure(page: Page | Frame) {
  return page.evaluate((terms) => {
    const actions = new RegExp(terms.actions, "i");
    const fields = new RegExp(terms.fields, "i");
    const safe = (value: string | null) => {
      const text = (value ?? "").trim();
      return text.length <= 70 && !/@|[\r\n]/.test(text) ? text : "";
    };
    const genericField = /^(subject|тема|start|начало|end|конец|date|дата|time|время|time zone|часовой пояс|repeat|повтор|recurrence|frequency|частота|attendees|участники|location|место|body|description|описание|all day|весь день|search|поиск)$/i;
    const genericOption = /^(never|никогда|daily|ежедневно|weekly|еженедельно|monthly|ежемесячно|yearly|ежегодно|every|кажд|after \d+|после \d+|until|до даты|utc[+-]\d{1,2})/i;
    const visible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll("button, [role=button], input, textarea, select, [contenteditable=true]"))
      .filter(visible).slice(0, 300);
    const buttons = controls.filter((element) => element.matches("button, [role=button]"))
      .filter((element) => !element.parentElement?.closest('[class*="appointment" i], [class*="eventItem" i], [class*="calendarItem" i], [class*="meetingItem" i]'))
      .map((element) => ({
        label: safe(element.getAttribute("aria-label")) || safe(element.getAttribute("title")) ||
          (element.closest('nav, header, [role="toolbar"], [role="dialog"]:not([hidden]), [class^="_cx_"]') ? safe(element.textContent) : ""),
        tag: element.tagName.toLowerCase(),
        role: safe(element.getAttribute("role")),
        id: safe(element.id),
      })).filter((item) => actions.test(item.label)).slice(0, 40);
    const buttonStructure = controls.filter((element) => element.matches("button, [role=button]"))
      .slice(0, 45).map((element, index) => ({
        index,
        id: safe(element.id),
        className: safe(typeof element.className === "string" ? element.className : ""),
        parentClass: safe(typeof element.parentElement?.className === "string" ? element.parentElement.className : ""),
        calendarHint: /календар|calendar/i.test(`${element.id} ${element.className} ${element.getAttribute("aria-label")} ${element.getAttribute("title")}`),
      }));
    const inputs = controls.filter((element) => element.matches("input, textarea, select, [contenteditable=true]"))
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: safe(element.id),
        name: safe(element.getAttribute("name")),
        type: safe(element.getAttribute("type")),
        label: (genericField.test(safe(element.getAttribute("aria-label")) || safe(element.getAttribute("placeholder"))) ||
          (element.closest('[role="dialog"], [class^="_cx_"]') && safe(element.getAttribute("placeholder")).length <= 45)
          ? safe(element.getAttribute("aria-label")) || safe(element.getAttribute("placeholder")) : ""),
        options: element instanceof HTMLSelectElement && fields.test(safe(element.getAttribute("aria-label")) || safe(element.id))
          ? Array.from(element.options).slice(0, 30).map((o) => safe(o.textContent)).filter((text) => genericOption.test(text)) : [],
      })).slice(0, 70);
    return { buttons, buttonStructure, inputs, visibleDialogs: Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible).length, controlCounts: {
      button: controls.filter((e) => e.tagName === "BUTTON").length,
      roleButton: controls.filter((e) => e.getAttribute("role") === "button").length,
      input: controls.filter((e) => e.tagName === "INPUT").length,
    }, dialogCount: document.querySelectorAll('[role="dialog"]').length };
  }, { actions: UI_ACTION.source, fields: UI_FIELD.source });
}

const pin = await verifiedOwaSpki();
const browser = await chromium.launch({ headless: false, args: [`--ignore-certificate-errors-spki-list=${pin}`] });
try {
  const context = await browser.newContext({ acceptDownloads: false });
  const page = await context.newPage();
  let pageErrors = 0;
  page.on("pageerror", () => { pageErrors++; });
  const authResponses: number[] = [];
  let redirectReason: string | null = null;
  page.on("response", (response) => {
    try {
      const path = new URL(response.url()).pathname.toLowerCase();
      if (response.request().method() === "POST" && (path.endsWith("/auth.owa") || path.includes("/auth/"))) {
        authResponses.push(response.status());
        const location = response.headers()["location"];
        const reason = location ? new URL(location, response.url()).searchParams.get("reason") : null;
        redirectReason = reason && /^\d{1,3}$/.test(reason) ? reason : null;
      }
    } catch { /* no URL or response contents are logged */ }
  });
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const credentialFile = process.env.OWA_CREDENTIAL_FILE;
  if (credentialFile) {
    const { username, password } = readLocalCredentials(credentialFile);
    const login = page.locator('input#username[name="username"]');
    const secret = page.locator('input#password[name="password"]');
    if (await login.count() !== 1 || await secret.count() !== 1) throw new Error("login_form_unexpected");
    await login.fill(username);
    await secret.fill(password);
    await secret.press("Enter", { timeout: 10_000 }).catch(() => { throw new Error("login_submit_failed"); }); // one attempt; no retries or credential logging
    console.log(JSON.stringify({ stage: "login_submitted", credentialsFromFile: true }));
  } else {
    console.log(JSON.stringify({ stage: "login_window_open", passwordRequired: true }));
  }
  let authenticated = false;
  const seconds = Math.min(1800, Math.max(30, Number(process.env.OWA_CALIBRATION_WAIT_SECONDS) || 180));
  for (let i = 0; i < seconds; i++) {
    await page.waitForTimeout(1000);
    if (page.url().startsWith("https://web.modulbank.ru/owa/") && await page.locator('input[type="password"]').count() === 0) {
      authenticated = true;
      break;
    }
    if (credentialFile && i === 10) {
      const text = await page.locator("body").innerText().catch(() => "");
      const current = new URL(page.url());
      const pageReason = current.searchParams.get("reason");
      const flags = {
        invalidCredentials: /incorrect|invalid (user|pass)|not correct|неверн|неправильн|ошибочн(ый|ая) пароль/i.test(text),
        lockedOrExpired: /locked|expired|заблокирован|истёк|истек/i.test(text),
        additionalStep: /verification|verify|второй фактор|подтвержден|код подтвержден|captcha|капча/i.test(text),
      };
      console.log(JSON.stringify({ stage: "login_diagnostic", stillOnLogin: await page.locator('input[type="password"]').count() > 0,
        onOwaHost: current.hostname === "web.modulbank.ru", pathname: current.hostname === "web.modulbank.ru" ? current.pathname : "other_host",
        reason: pageReason && /^\d{1,3}$/.test(pageReason) ? pageReason : redirectReason, postStatuses: authResponses.slice(0, 3), flags }));
      if (flags.invalidCredentials || flags.lockedOrExpired || (await page.locator('input[type="password"]').count() > 0 && authResponses.length > 0 && !flags.additionalStep)) break;
    }
  }
  if (!authenticated) {
    console.log(JSON.stringify({ stage: "login_not_completed", inspected: false }));
  } else {
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(12_000);
    let route = new URL(page.url()).hash.match(/^#path=\/[A-Za-z/]+/i)?.[0] ?? "unknown";
    if (route !== "#path=/calendar/view/Day") {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(5000);
      route = new URL(page.url()).hash.match(/^#path=\/[A-Za-z/]+/i)?.[0] ?? "unknown";
    }
    const frames = await Promise.all(page.frames().map(async (frame) => ({
      frame,
      path: (() => { try { const url = new URL(frame.url()); return url.hostname === "web.modulbank.ru" ? url.pathname : "other_host"; } catch { return "non_http"; } })(),
      controls: await frame.locator("button, input, select, [role=button]").count().catch(() => 0),
      visible: await frame.locator("button:visible, input:visible, select:visible, [role=button]:visible").count().catch(() => 0),
    })));
    const chosen = [...frames].sort((a, b) => b.visible - a.visible)[0];
    console.log(JSON.stringify({ stage: "calendar_meta", pathname: new URL(page.url()).pathname, route,
      stillOnLogin: await page.locator('input[type="password"]').count() > 0,
      frameSummary: frames.map(({ path, controls, visible }) => ({ path, controls, visible })), pageErrors }));
    if (!chosen || await page.locator('input[type="password"]').count() > 0) throw new Error("calendar_not_loaded");
    const initialStructure = await structure(chosen.frame);
    console.log(JSON.stringify({ stage: "calendar_controls", structure: process.env.OWA_CALIBRATE_ACTION === "add_calendar"
      ? { buttons: initialStructure.buttons, controlCounts: initialStructure.controlCounts } : initialStructure }));
    if (process.env.OWA_CALIBRATE_ACTION === "check_calendar_sidebar") {
      const surname = process.env.OWA_CALIBRATE_TARGET_SURNAME;
      if (!surname || !/^[\p{L}-]{2,60}$/u.test(surname)) throw new Error("target_surname_required");
      const matches = chosen.frame.locator('[role="menuitemradio"]:visible').filter({ hasText: new RegExp(surname, "i") });
      const structure = await matches.evaluateAll((elements) => elements.slice(0, 12).map((element) => {
        const css = (node: Element | null) => node && typeof node.className === "string" ? node.className.slice(0, 70) : "";
        const parent = element.parentElement;
        return { tag: element.tagName.toLowerCase(), ariaChecked: element.getAttribute("aria-checked"), parentRole: parent?.getAttribute("role") ?? null,
          className: css(element), parentClass: css(parent), hasCheckbox: Boolean(parent?.querySelector('input[type="checkbox"], [role="checkbox"]')) };
      }));
      console.log(JSON.stringify({ stage: "calendar_sidebar_check", visibleOwnerItems: await matches.count(), structures: structure }));
    } else if (process.env.OWA_CALIBRATE_ACTION === "add_calendar") {
      if (process.env.OWA_CALIBRATE_OPEN_SELECTED === "true") {
        const surname = process.env.OWA_CALIBRATE_TARGET_SURNAME;
        if (!surname || !/^[\p{L}-]{2,60}$/u.test(surname)) throw new Error("target_surname_required");
        const existing = chosen.frame.locator('[role="menuitemradio"]:visible').filter({ hasText: new RegExp(surname, "i") });
        if (await existing.count() !== 0) throw new Error("calendar_already_present_or_ambiguous");
      }
      const add = chosen.frame.locator('button[title*="Добавить календарь" i], button[aria-label*="Добавить календарь" i]');
      if (await add.count() === 1) {
        await add.click(); // opens a selector only; no calendar is added
        await page.waitForTimeout(700);
        const menu = await chosen.frame.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] a'))
          .filter((element) => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
          .map((element) => ({ role: element.getAttribute("role"), label: (element.getAttribute("aria-label") || element.textContent || "").trim() }))
          .filter((item) => item.label.length <= 70 && !/@|[\r\n]/.test(item.label) && /календар|каталог|адрес|общ|интернет|calendar|directory|shared|internet/i.test(item.label)).slice(0, 30));
        console.log(JSON.stringify({ stage: "add_calendar_menu", menu }));
        const directory = chosen.frame.getByRole("menuitem", { name: "Из каталога", exact: true });
        if (await directory.count() >= 1 && await directory.count() <= 2) {
          await directory.first().click(); // opens contact lookup; no address is selected or added
          await page.waitForTimeout(800);
          const directoryStructure = await structure(chosen.frame);
          console.log(JSON.stringify({ stage: "add_calendar_directory", structure: {
            buttons: directoryStructure.buttons, inputs: directoryStructure.inputs, controlCounts: directoryStructure.controlCounts,
          } }));
          const pages = context.pages();
          console.log(JSON.stringify({ stage: "directory_pages", pages: await Promise.all(pages.map(async (tab) => ({
            pathname: (() => { try { const url = new URL(tab.url()); return url.hostname === "web.modulbank.ru" ? url.pathname : "other_host"; } catch { return "non_http"; } })(),
            route: (() => { try { return new URL(tab.url()).hash.match(/^#path=\/[A-Za-z/]+/i)?.[0] ?? "unknown"; } catch { return "unknown"; } })(),
            visibleControls: await tab.locator('button:visible, input:visible, [role="button"]:visible').count().catch(() => 0),
          }))) }));
          const fields = await chosen.frame.locator('input:visible, textarea:visible, select:visible, [contenteditable="true"]:visible').evaluateAll((elements) =>
            elements.slice(0, 20).map((element) => {
              const safe = (value: string | null) => value && value.trim().length <= 70 && !/@|[\r\n]/.test(value) ? value.trim() : "";
              return { tag: element.tagName.toLowerCase(), type: safe(element.getAttribute("type")), id: safe(element.id),
                className: safe(typeof element.className === "string" ? element.className : ""),
                parentClass: safe(typeof element.parentElement?.className === "string" ? element.parentElement.className : ""),
                placeholder: safe(element.getAttribute("placeholder")), ariaLabel: safe(element.getAttribute("aria-label")),
                role: safe(element.getAttribute("role")), disabled: (element as HTMLInputElement).disabled ?? null,
                readOnly: (element as HTMLInputElement).readOnly ?? null };
            }));
          console.log(JSON.stringify({ stage: "directory_form_fields", fields }));
          if ((process.env.OWA_CALIBRATE_SELF_SEARCH === "true" || process.env.OWA_CALIBRATE_TARGET_EMAIL) && credentialFile) {
            let phase = "resolve_own_address";
            try {
              const address = process.env.OWA_CALIBRATE_TARGET_EMAIL ?? (() => {
                const python = process.env.OWA_EWS_PYTHON;
                if (!python) throw new Error("ews_python_not_configured");
                const code = "from ews_backend import credentials_from_file, resolve_own_mailbox; import os; u,p=credentials_from_file(os.environ['OWA_EWS_CREDENTIAL_FILE']); print(resolve_own_mailbox(u,p))";
                return execFileSync(python, ["-c", code], {
                  encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"],
                  env: { ...process.env, PYTHONPATH: resolve(dirname(fileURLToPath(import.meta.url)), "../src"), OWA_EWS_CREDENTIAL_FILE: credentialFile },
                }).trim();
              })();
              if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error("invalid_self_address");
              phase = "locate_search";
              const labeledSearch = chosen.frame.locator('input[aria-label^="Поле поиска календаря" i]:visible');
              const search = await labeledSearch.count() === 1 && await labeledSearch.isDisabled()
                ? chosen.frame.locator('._fp_3 input:visible:not(:disabled)') : labeledSearch;
              const searchCount = await search.count();
              if (searchCount !== 1) throw new Error("search_field_ambiguous");
              console.log(JSON.stringify({ stage: "self_search_field_state", state: await search.evaluate((element) => ({
                readOnly: (element as HTMLInputElement).readOnly, disabled: (element as HTMLInputElement).disabled,
                ariaDisabled: element.getAttribute("aria-disabled"), tabIndex: (element as HTMLInputElement).tabIndex,
                inDom: element.isConnected,
              })) }));
              phase = "fill_search";
              await search.fill(address);
              phase = "submit_search";
              await search.press("Enter"); // read-only directory lookup, no add/save
              await page.waitForTimeout(3000);
              phase = "inspect_result";
              const found = await chosen.frame.getByText(address, { exact: true }).count();
              const current = await structure(chosen.frame);
              console.log(JSON.stringify({ stage: "self_calendar_search", exactVisibleMatches: found,
                buttons: current.buttons, inputs: current.inputs, visibleControls: current.controlCounts }));
              if (found === 1) {
                const candidate = chosen.frame.getByText(address, { exact: true });
                const candidateMeta = await candidate.evaluate((element) => {
                  const root = element.closest('[role="option"], [role="listitem"], li, button') || element.parentElement;
                  const css = (node: Element | null) => node && typeof node.className === "string" ? node.className.slice(0, 70) : "";
                  return { tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), className: css(element),
                    parentClass: css(element.parentElement), selectableTag: root?.tagName.toLowerCase() ?? null,
                    selectableRole: root?.getAttribute("role") ?? null, selectableClass: css(root) };
                });
                console.log(JSON.stringify({ stage: "candidate_structure", candidate: candidateMeta }));
                const selectable = candidateMeta.selectableRole === "option" ||
                  (candidateMeta.selectableTag === "div" && candidateMeta.selectableClass.startsWith("_pe_"));
                if (process.env.OWA_CALIBRATE_SELECT_RESULT === "true" && selectable) {
                  await candidate.click(); // option selection only; no Add/Save action
                  await page.waitForTimeout(700);
                  const actions = await chosen.frame.locator('button:visible, [role="button"]:visible').evaluateAll((elements) =>
                    elements.map((element) => ({ text: (element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent || "").trim(),
                      disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true",
                      className: typeof element.className === "string" ? element.className.slice(0, 70) : "" }))
                      .filter((item) => item.text.length <= 45 && !/@|[\r\n]/.test(item.text) && /добав|сохран|готов|отмена|откры|add|save|done|open|cancel/i.test(item.text)).slice(0, 20));
                  console.log(JSON.stringify({ stage: "candidate_selected_no_save", actions }));
                  if (process.env.OWA_CALIBRATE_OPEN_SELECTED === "true" && process.env.OWA_CALIBRATE_TARGET_EMAIL) {
                    const open = chosen.frame.locator('button._fce_W:visible').filter({ hasText: /^Открыть$/ });
                    if (await open.count() !== 1 || !await open.isEnabled()) throw new Error("open_calendar_button_ambiguous");
                    if (!await approve(context, `Добавить календарь в OWA: ${address}`)) {
                      console.log(JSON.stringify({ stage: "calendar_add_cancelled" }));
                    } else {
                      phase = "open_clicked"; // network/navigation errors from here may follow a committed change
                      await open.click(); // exactly one confirmed persistent calendar addition
                      await page.waitForTimeout(3000);
                      const pickerStillOpen = await chosen.frame.locator('input[aria-label^="Поле поиска календаря" i]:visible').count() > 0;
                      const surname = process.env.OWA_CALIBRATE_TARGET_SURNAME!;
                      const ownerVisible = await chosen.frame.locator('[role="menuitemradio"]:visible').filter({ hasText: new RegExp(surname, "i") }).count() === 1;
                      console.log(JSON.stringify({ stage: "calendar_open_result", verdict: ownerVisible && !pickerStillOpen ? "verified" : "uncertain", pickerStillOpen, ownerVisible,
                        route: new URL(page.url()).hash.match(/^#path=\/[A-Za-z/]+/i)?.[0] ?? "unknown" }));
                    }
                  }
                }
              }
            } catch (error) {
              const failure = error as { name?: string; code?: string; status?: number | null; signal?: string | null };
              const code = failure instanceof Error && ["invalid_self_address", "search_field_ambiguous", "ews_python_not_configured"].includes(failure.message) ? failure.message : null;
              console.log(JSON.stringify({ stage: phase === "open_clicked" ? "calendar_add_result_uncertain" : "self_calendar_search_unavailable",
                followUp: phase === "open_clicked" ? "check_calendar_sidebar_before_any_retry" : null,
                phase, kind: failure.name ?? "Error",
                safeCode: code,
                code: failure.code ?? null, exitStatus: failure.status ?? null, signal: failure.signal ?? null }));
            }
          }
        } else {
          console.log(JSON.stringify({ stage: "directory_option_not_identified", matches: await directory.count() }));
        }
      } else {
        console.log(JSON.stringify({ stage: "add_calendar_not_identified", matches: await add.count() }));
      }
    } else {
      const createButtons = chosen.frame.getByRole("button", { name: /^(создать|new|new event|новое событие|создать событие)$/i });
      if (await createButtons.count() === 1) {
        await createButtons.click(); // opens an unsaved form, never clicks Save
        await page.waitForTimeout(500);
        console.log(JSON.stringify({ stage: "empty_event_form", structure: await structure(chosen.frame) }));
      } else {
        console.log(JSON.stringify({ stage: "event_editor_not_identified", matches: await createButtons.count() }));
      }
    }
  }
} finally {
  await browser.close();
}
