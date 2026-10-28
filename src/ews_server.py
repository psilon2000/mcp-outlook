"""Local stdio MCP server for Exchange Web Services (on-prem NTLM)."""

import json
import logging
import os
from threading import RLock

from mcp.server.fastmcp import FastMCP

from ews_backend import EwsBackend, InputError

logging.getLogger("exchangelib").setLevel(logging.ERROR)  # mail metadata must not reach MCP stderr

mcp = FastMCP("mcp-outlook-ews")
backend = EwsBackend(os.environ.get("OWA_EWS_CREDENTIAL_FILE", ""))
lock = RLock()


def safe(action):
    try:
        with lock:  # one mailbox session and one-time preview state are shared by all MCP calls
            return {"ok": True, "data": action()}
    except InputError as exc:
        return {"ok": False, "code": str(exc)}
    except Exception:
        # Exceptions from the EWS library can contain mailbox IDs and service responses.
        return {"ok": False, "code": "ews_operation_failed"}


def local_approval(event: dict) -> bool:
    try:
        import tkinter as tk

        root = tk.Tk()
        root.attributes("-topmost", True)
        root.title("Подтвердить одно событие OWA")
        summary = json.dumps({
            "subject": event["subject"], "start": event["start"].isoformat(), "end": event["end"].isoformat(),
            "time_zone": event["time_zone"], "location": event.get("location", ""), "body": event.get("body", ""),
            "all_day": event["all_day"], "attendees": event["attendees"], "recurrence": event["recurrence"],
            "show_as": event["show_as"], "sensitivity": event["sensitivity"], "importance": event["importance"],
            "reminder_minutes": event.get("reminder_minutes"), "request_responses": event["request_responses"],
        }, ensure_ascii=False, indent=2)
        approved = False

        def finish(accepted: bool) -> None:
            nonlocal approved
            approved = accepted
            root.quit()

        try:
            tk.Label(root, text="Проверь ВСЕ поля. Подтверждение отправит приглашения участникам.").pack(padx=12, pady=8)
            frame = tk.Frame(root)
            frame.pack(fill="both", expand=True, padx=12)
            scroll = tk.Scrollbar(frame)
            scroll.pack(side="right", fill="y")
            text = tk.Text(frame, height=26, width=100, wrap="word", yscrollcommand=scroll.set)
            text.pack(side="left", fill="both", expand=True)
            scroll.config(command=text.yview)
            text.insert("1.0", summary)
            text.config(state="disabled")
            buttons = tk.Frame(root)
            buttons.pack(pady=10)
            tk.Button(buttons, text="Отмена", command=lambda: finish(False)).pack(side="left", padx=8)
            tk.Button(buttons, text="Создать один раз", command=lambda: finish(True)).pack(side="left", padx=8)
            root.protocol("WM_DELETE_WINDOW", lambda: finish(False))
            root.after(110_000, lambda: finish(False))
            root.mainloop()
            return approved
        finally:
            root.destroy()
    except Exception:
        return False  # cannot write without a working out-of-band dialog


@mcp.tool(description="Check whether on-prem EWS NTLM can open the authenticated mailbox, without returning the address")
def ews_status() -> dict:
    return safe(lambda: {"mail": backend.account.inbox is not None, "calendar": backend.account.calendar is not None})


@mcp.tool(description="List own email metadata entries from inbox, sent or drafts; limit is a positive integer with no fixed upper bound (default 10); no read flag is changed")
def ews_list_mail(folder: str = "inbox", limit: int = 10, subject_query: str | None = None) -> dict:
    return safe(lambda: backend.list_mail(folder, limit, subject_query))


@mcp.tool(description="Read a previously selected own email as bounded plain text, only when explicitly enabled in local config")
def ews_read_mail(message_id: str, max_chars: int = 2000) -> dict:
    return safe(lambda: backend.read_mail(message_id, max_chars))


@mcp.tool(description="Read at most 50 event summaries in an aware ISO-8601 date-time window of no more than 31 days. Shared owner access needs configured permission")
def ews_calendar_events(start: str, end: str, owner: str | None = None, limit: int = 25) -> dict:
    return safe(lambda: backend.calendar_events(start, end, owner, limit))


@mcp.tool(description="Read details of a selected event; respect server-granted visibility of other people's calendar")
def ews_event_details(event_id: str) -> dict:
    return safe(lambda: backend.event_details(event_id))


@mcp.tool(description="Read-only access check for one shared calendar. Does not add an OWA UI shortcut or change Exchange permissions")
def ews_add_shared_calendar(address: str) -> dict:
    return safe(lambda: backend.add_shared_calendar(address))


@mcp.tool(description="Validate a typed event and preview recurrence and recipient roles without writing. Dates must have ISO-8601 offsets, weekdays use ISO numbers 1=Mon..7=Sun")
def ews_preview_event(event: dict) -> dict:
    return safe(lambda: backend.preview_event(event))


@mcp.tool(description="Create exactly one previewed event after local approval. event_result_uncertain means Exchange may already have sent invitations; do not retry")
def ews_create_event(preview_id: str) -> dict:
    return safe(lambda: backend.create_event(preview_id, local_approval))


if __name__ == "__main__":
    mcp.run(transport="stdio")
