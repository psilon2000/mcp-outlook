"""Bounded EWS operations. No credential, cookie or mailbox dump is written to disk."""

from __future__ import annotations

import os
import re
import secrets
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

import requests
from requests_ntlm import HttpNtlmAuth
from exchangelib import (
    Account, Attendee, CalendarItem, Configuration, Credentials, DELEGATE, EWSDate, EWSDateTime,
    EWSTimeZone, Mailbox, NTLM, UTC,
)
from exchangelib.items import SEND_TO_ALL_AND_SAVE_COPY, SEND_TO_NONE
from exchangelib.errors import ErrorAccessDenied, ErrorFolderNotFound
from exchangelib.recurrence import (
    AbsoluteMonthlyPattern, AbsoluteYearlyPattern, DailyPattern, EndDatePattern, NoEndPattern,
    NumberedPattern, Recurrence, RelativeMonthlyPattern, RelativeYearlyPattern, WeeklyPattern,
)

ENDPOINT = "https://web.modulbank.ru/EWS/Exchange.asmx"
CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt"


class InputError(Exception):
    """A stable, non-sensitive error or operational outcome code for MCP callers."""


def credentials_from_file(path: str) -> tuple[str, str]:
    file = Path(path)
    if not file.is_file() or file.is_symlink() or not 3 <= file.stat().st_size <= 4096:
        raise InputError("credential_file_invalid")
    lines = file.read_text(encoding="utf-8-sig").splitlines()
    if len(lines) < 2 or not re.fullmatch(r"[^\s\\]{1,64}\\[^\s\\]{1,128}", lines[0]) or not 1 <= len(lines[1]) <= 256:
        raise InputError("credential_format_invalid")
    return lines[0], lines[1]


def resolve_own_mailbox(username: str, password: str, expected: str | None = None) -> str:
    soap = ET.Element("{http://schemas.xmlsoap.org/soap/envelope/}Envelope")
    header = ET.SubElement(soap, "{http://schemas.xmlsoap.org/soap/envelope/}Header")
    ET.SubElement(header, "{http://schemas.microsoft.com/exchange/services/2006/types}RequestServerVersion", Version="Exchange2013_SP1")
    body = ET.SubElement(soap, "{http://schemas.xmlsoap.org/soap/envelope/}Body")
    command = ET.SubElement(body, "{http://schemas.microsoft.com/exchange/services/2006/messages}ResolveNames", ReturnFullContactData="false", SearchScope="ActiveDirectory")
    ET.SubElement(command, "{http://schemas.microsoft.com/exchange/services/2006/messages}UnresolvedEntry").text = username.split("\\", 1)[1]
    with requests.Session() as session:
        session.trust_env = False
        session.auth = HttpNtlmAuth(username, password)
        session.verify = CA_BUNDLE
        response = session.post(ENDPOINT, data=ET.tostring(soap, encoding="utf-8"), timeout=25,
            headers={"Content-Type": "text/xml; charset=utf-8", "SOAPAction": "http://schemas.microsoft.com/exchange/services/2006/messages/ResolveNames"})
    if response.status_code != 200:
        raise InputError("ews_authentication_failed")
    root = ET.fromstring(response.content)
    codes = [elem.text for elem in root.iter() if elem.tag.endswith("}ResponseCode")]
    addresses = {elem.text for elem in root.iter() if elem.tag.endswith("}EmailAddress") and elem.text and "@" in elem.text}
    if expected:
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", expected):
            raise InputError("configured_mailbox_invalid")
        exact = [address for address in addresses if address.lower() == expected.lower()]
        if exact and codes in (["NoError"], ["ErrorNameResolutionMultipleResults"]):
            return exact[0]
        raise InputError("configured_mailbox_not_resolved")
    if codes != ["NoError"] or len(addresses) != 1:
        raise InputError("mailbox_resolution_ambiguous")
    return addresses.pop()


class TextOnly(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("script", "style"):
            self.skip += 1
        elif tag in ("br", "p", "div", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.skip:
            self.skip -= 1

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)

    def result(self) -> str:
        return "".join(self.parts).strip()


def body_text(value: object) -> str:
    content = str(value or "")
    parser = TextOnly()
    parser.feed(content)
    return parser.result()


def parse_date_time(value: str) -> EWSDateTime:
    if not isinstance(value, str):
        raise InputError("invalid_date_time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("missing timezone")
        return EWSDateTime.from_datetime(parsed.astimezone(timezone.utc))
    except (ValueError, TypeError) as exc:
        raise InputError("invalid_date_time") from exc


def validated_event(spec: dict) -> dict:
    if not isinstance(spec, dict) or set(spec) - {"subject", "start", "end", "time_zone", "all_day", "body", "location", "attendees", "recurrence", "show_as", "sensitivity", "importance", "reminder_minutes", "request_responses"}:
        raise InputError("unsupported_event_field")
    subject = spec.get("subject")
    if not isinstance(subject, str) or not 1 <= len(subject.strip()) <= 255:
        raise InputError("invalid_subject")
    start = parse_date_time(spec.get("start", ""))
    end = parse_date_time(spec.get("end", ""))
    if end <= start:
        raise InputError("end_must_follow_start")
    zone_name = spec.get("time_zone")
    try:
        zone = ZoneInfo(zone_name)
        EWSTimeZone.from_timezone(zone)
    except (KeyError, TypeError, ValueError) as exc:
        raise InputError("invalid_time_zone") from exc
    if type(spec.get("all_day", False)) is not bool or type(spec.get("request_responses", True)) is not bool:
        raise InputError("invalid_event_option")
    if spec.get("show_as", "Busy") not in ("Free", "Tentative", "Busy", "OOF", "WorkingElsewhere") or spec.get("sensitivity", "Normal") not in ("Normal", "Personal", "Private", "Confidential") or spec.get("importance", "Normal") not in ("Low", "Normal", "High"):
        raise InputError("invalid_event_option")
    reminder = spec.get("reminder_minutes")
    if reminder is not None and (type(reminder) is not int or not 0 <= reminder <= 10080):
        raise InputError("invalid_event_option")
    for value in (start, end):
        local = value.astimezone(zone)
        source = datetime.fromisoformat(spec["start" if value is start else "end"].replace("Z", "+00:00"))
        if source.utcoffset() != local.utcoffset():
            raise InputError("time_zone_offset_mismatch")
    if spec.get("all_day", False) and (start.astimezone(zone).time() != datetime.min.time() or end.astimezone(zone).time() != datetime.min.time()):
        raise InputError("all_day_requires_midnight_boundaries")
    attendees = spec.get("attendees", [])
    if not isinstance(attendees, list) or len(attendees) > 100:
        raise InputError("invalid_attendees")
    addresses: set[str] = set()
    for attendee in attendees:
        if not isinstance(attendee, dict) or set(attendee) != {"role", "email"} or attendee.get("role") not in ("required", "optional", "resource"):
            raise InputError("invalid_attendees")
        email = attendee.get("email", "")
        if not isinstance(email, str) or len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or email.lower() in addresses:
            raise InputError("invalid_attendees")
        addresses.add(email.lower())
    recurrence = spec.get("recurrence")
    if recurrence is not None:
        if not isinstance(recurrence, dict):
            raise InputError("invalid_recurrence")
        freq = recurrence.get("frequency")
        interval = recurrence.get("interval", 1)
        weekdays = recurrence.get("weekdays")
        month_day = recurrence.get("month_day")
        month = recurrence.get("month")
        ordinal = recurrence.get("ordinal")
        ends = recurrence.get("ends", {})
        if set(recurrence) - {"frequency", "interval", "weekdays", "month_day", "month", "ordinal", "ends"} or freq not in ("daily", "weekly", "monthly", "yearly") or type(interval) is not int or not 1 <= interval <= 99 or not isinstance(ends, dict):
            raise InputError("invalid_recurrence")
        if freq == "weekly":
            if not isinstance(weekdays, list) or not weekdays or any(type(day) is not int or not 1 <= day <= 7 for day in weekdays) or len(set(weekdays)) != len(weekdays) or any(v is not None for v in (month_day, month, ordinal)):
                raise InputError("invalid_weekly_recurrence")
        elif freq in ("monthly", "yearly"):
            if (month_day is None) == (ordinal is None) or (ordinal is not None and (ordinal not in (1, 2, 3, 4, -1) or not isinstance(weekdays, list) or len(weekdays) != 1 or type(weekdays[0]) is not int or not 1 <= weekdays[0] <= 7)) or (month_day is not None and (type(month_day) is not int or not 1 <= month_day <= 31 or weekdays)):
                raise InputError("invalid_month_pattern")
            if freq == "yearly" and (type(month) is not int or not 1 <= month <= 12 or interval != 1):
                raise InputError("invalid_yearly_recurrence")
            if freq == "monthly" and month is not None:
                raise InputError("invalid_monthly_recurrence")
        elif any(v is not None for v in (weekdays, month_day, month, ordinal)):
            raise InputError("invalid_daily_recurrence")
        if ends.get("type") not in ("never", "count", "until"):
            raise InputError("invalid_recurrence_end")
        if set(ends) - ({"type", "count"} if ends["type"] == "count" else {"type", "date"} if ends["type"] == "until" else {"type"}):
            raise InputError("invalid_recurrence_end")
        if ends["type"] == "count" and (type(ends.get("count")) is not int or not 1 <= ends["count"] <= 999):
            raise InputError("invalid_recurrence_end")
        if ends["type"] == "until":
            try:
                until = date.fromisoformat(ends["date"])
            except (ValueError, TypeError, KeyError) as exc:
                raise InputError("invalid_recurrence_end") from exc
            if until < start.astimezone(zone).date():
                raise InputError("invalid_recurrence_end")
        local_start = start.astimezone(zone).date()
        if freq == "weekly" and local_start.isoweekday() not in weekdays:
            raise InputError("recurrence_start_mismatch")
        if freq in ("monthly", "yearly"):
            if (freq == "yearly" and local_start.month != month) or (month_day is not None and local_start.day != month_day):
                raise InputError("recurrence_start_mismatch")
            if ordinal is not None:
                if local_start.isoweekday() != weekdays[0]:
                    raise InputError("recurrence_start_mismatch")
                if ordinal == -1:
                    if (local_start + timedelta(days=7)).month == local_start.month:
                        raise InputError("recurrence_start_mismatch")
                elif (local_start.day - 1) // 7 + 1 != ordinal:
                    raise InputError("recurrence_start_mismatch")
    for name, cap in (("body", 10_000), ("location", 255)):
        value = spec.get(name, "")
        if not isinstance(value, str) or len(value) > cap:
            raise InputError(f"invalid_{name}")
    return {**spec, "subject": subject.strip(), "start": start, "end": end, "time_zone": zone_name,
            "attendees": attendees, "recurrence": recurrence, "all_day": spec.get("all_day", False),
            "show_as": spec.get("show_as", "Busy"), "sensitivity": spec.get("sensitivity", "Normal"),
            "importance": spec.get("importance", "Normal"), "request_responses": spec.get("request_responses", True)}


def recurrence_for(event: dict):
    r = event["recurrence"]
    if not r:
        return None
    interval = r.get("interval", 1)
    if r["frequency"] == "daily":
        pattern = DailyPattern(interval=interval)
    elif r["frequency"] == "weekly":
        pattern = WeeklyPattern(interval=interval, weekdays=r["weekdays"], first_day_of_week=1)
    elif r["frequency"] == "monthly":
        pattern = (AbsoluteMonthlyPattern(interval=interval, day_of_month=r["month_day"]) if r.get("month_day") else
                   RelativeMonthlyPattern(interval=interval, weekday=r["weekdays"][0], week_number=5 if r["ordinal"] == -1 else r["ordinal"]))
    else:
        pattern = (AbsoluteYearlyPattern(day_of_month=r["month_day"], month=r["month"]) if r.get("month_day") else
                   RelativeYearlyPattern(weekday=r["weekdays"][0], week_number=5 if r["ordinal"] == -1 else r["ordinal"], month=r["month"]))
    local_start = event["start"].astimezone(ZoneInfo(event["time_zone"]))
    start = EWSDate(local_start.year, local_start.month, local_start.day)
    ends = r["ends"]
    if ends["type"] == "never":
        boundary = NoEndPattern(start=start)
    elif ends["type"] == "count":
        boundary = NumberedPattern(start=start, number=ends["count"])
    else:
        boundary = EndDatePattern(start=start, end=EWSDate.from_date(date.fromisoformat(ends["date"])))
    return Recurrence(pattern=pattern, boundary=boundary)


@dataclass
class Selection:
    mailbox: str
    item_id: str
    expires: float
    folder: str = "inbox"


@dataclass
class AvailabilitySelection:
    owner: str
    start: str
    end: str
    busy_type: str
    subject: str | None
    location: str | None
    expires: float


class EwsBackend:
    def __init__(self, credential_file: str):
        self.credential_file = credential_file
        self._account: Account | None = None
        self._shared: dict[str, Account] = {}
        self._messages: dict[str, Selection] = {}
        self._events: dict[str, Selection] = {}
        self._availability: dict[str, AvailabilitySelection] = {}
        self._previews: dict[str, tuple[dict, float]] = {}
        self._attempted: set[tuple] = set()

    @property
    def account(self) -> Account:
        if self._account is None:
            os.environ["REQUESTS_CA_BUNDLE"] = CA_BUNDLE
            username, password = credentials_from_file(self.credential_file)
            mailbox = resolve_own_mailbox(username, password, os.environ.get("OWA_EWS_MAILBOX"))
            self._config = Configuration(service_endpoint=ENDPOINT, credentials=Credentials(username=username, password=password), auth_type=NTLM, max_connections=1)
            self._account = Account(primary_smtp_address=mailbox, config=self._config, autodiscover=False, access_type=DELEGATE)
        return self._account

    def _owner(self, mailbox: str | None) -> Account:
        own = self.account
        if not mailbox or mailbox.lower() == own.primary_smtp_address.lower():
            return own
        if os.environ.get("OWA_EWS_ALLOW_SHARED") != "true":
            raise InputError("shared_calendar_disabled")
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", mailbox) or len(mailbox) > 254:
            raise InputError("invalid_mailbox")
        address = mailbox.lower()
        if address not in self._shared:
            self._shared[address] = Account(primary_smtp_address=mailbox, config=self._config, autodiscover=False, access_type=DELEGATE)
        return self._shared[address]

    def list_mail(self, folder: str, limit: int, subject_query: str | None = None) -> dict:
        if folder not in ("inbox", "sent", "drafts") or not 1 <= limit <= 25 or subject_query and len(subject_query) > 120:
            raise InputError("invalid_mail_query")
        self._messages.clear()
        account = self.account
        source = getattr(account, folder)
        items = source.filter(subject__icontains=subject_query) if subject_query else source.all()
        date_field = {"inbox": "datetime_received", "sent": "datetime_sent", "drafts": "datetime_created"}[folder]
        items = items.order_by(f"-{date_field}").only("subject", "sender", date_field)
        result = []
        for item in items[:limit]:
            token = secrets.token_hex(16)
            self._messages[token] = Selection(mailbox=account.primary_smtp_address, item_id=item.id, expires=time.monotonic() + 120, folder=folder)
            dt = getattr(item, date_field, None)
            result.append({"id": token, "subject": str(item.subject or "")[:200],
                           "date": dt.isoformat() if dt else None,
                           "sender": getattr(getattr(item, "sender", None), "email_address", None)})
        return {"folder": folder, "messages": result}

    def read_mail(self, token: str, max_chars: int = 2000) -> dict:
        if os.environ.get("OWA_EWS_ALLOW_MAIL_BODY") != "true":
            raise InputError("mail_body_disabled")
        if not 1 <= max_chars <= 4000:
            raise InputError("invalid_mail_query")
        selected = self._messages.pop(token, None)
        if not selected or selected.expires < time.monotonic():
            raise InputError("message_selection_expired")
        source = getattr(self.account, selected.folder)
        item = source.get(id=selected.item_id)  # EWS GetItem is read-only
        text = body_text(item.body)
        return {"subject": str(item.subject or "")[:200], "body": text[:max_chars], "truncated": len(text) > max_chars}

    def calendar_events(self, start: str, end: str, mailbox: str | None = None, limit: int = 25) -> dict:
        begin, finish = parse_date_time(start), parse_date_time(end)
        if finish <= begin or finish - begin > timedelta(days=31) or not 1 <= limit <= 50:
            raise InputError("invalid_calendar_range")
        account = self._owner(mailbox)
        self._events.clear()
        self._availability.clear()
        events = []
        try:
            folder = account.calendar
            if account != self.account and (not folder.id or getattr(getattr(folder, "effective_rights", None), "read", None) is not True):
                return self._free_busy(account.primary_smtp_address, begin, finish, limit)
            for item in folder.view(start=begin, end=finish, max_items=limit).only("subject", "start", "end", "is_all_day", "location", "sensitivity"):
                token = secrets.token_hex(16)
                self._events[token] = Selection(mailbox=account.primary_smtp_address, item_id=item.id, expires=time.monotonic() + 120)
                private = getattr(item, "sensitivity", None) == "Private" and account != self.account
                events.append({"id": token, "owner": account.primary_smtp_address, "start": item.start.isoformat() if item.start else None,
                               "end": item.end.isoformat() if item.end else None, "all_day": item.is_all_day,
                               "subject": None if private else str(item.subject or "")[:255], "location": None if private else str(item.location or "")[:255]})
                if len(events) >= limit:
                    break
            return {"access": "delegate", "events": events}
        except (ErrorFolderNotFound, ErrorAccessDenied):
            if account == self.account:
                raise
            self._events.clear()
            return self._free_busy(account.primary_smtp_address, begin, finish, limit)

    def _free_busy(self, address: str, start: EWSDateTime, end: EWSDateTime, limit: int) -> dict:
        views = list(self.account.protocol.get_free_busy_info(
            accounts=[(address, "Required", False)], start=start, end=end, requested_view="Detailed"))
        if len(views) != 1 or views[0].view_type in ("None", "MergedOnly"):
            raise InputError("shared_calendar_unavailable")
        detailed_view = views[0].view_type in ("Detailed", "DetailedMerged")
        events = []
        for entry in (views[0].calendar_events or [])[:limit]:
            token = secrets.token_hex(16)
            start_iso, end_iso = entry.start.isoformat(), entry.end.isoformat()
            details = entry.details if detailed_view else None
            if details and details.is_private is False:
                subject, location = str(details.subject or "")[:255], str(details.location or "")[:255]
            else:
                subject, location = None, None
            self._availability[token] = AvailabilitySelection(address, start_iso, end_iso, str(entry.busy_type),
                subject, location, time.monotonic() + 120)
            events.append({"id": token, "owner": address, "start": start_iso, "end": end_iso,
                           "busy_type": str(entry.busy_type), "subject": subject, "location": location})
        return {"access": "detailed" if detailed_view else "freebusy", "events": events}

    def event_details(self, token: str) -> dict:
        if os.environ.get("OWA_EWS_ALLOW_CALENDAR_DETAILS") != "true":
            raise InputError("calendar_details_disabled")
        available = self._availability.pop(token, None)
        if available:
            if available.expires < time.monotonic():
                raise InputError("event_selection_expired")
            return {"owner": available.owner, "access": "detailed" if available.subject is not None else "busy",
                    "start": available.start, "end": available.end, "busy_type": available.busy_type,
                    "subject": available.subject, "location": available.location, "body": None}
        selected = self._events.pop(token, None)
        if not selected or selected.expires < time.monotonic():
            raise InputError("event_selection_expired")
        account = self._owner(selected.mailbox)
        item = account.calendar.get(id=selected.item_id)
        if getattr(item, "sensitivity", None) == "Private" and account != self.account:
            return {"owner": account.primary_smtp_address, "access": "busy", "details": None}
        return {"owner": account.primary_smtp_address, "access": "full", "subject": str(item.subject or "")[:255],
                "start": item.start.isoformat(), "end": item.end.isoformat(), "location": str(item.location or "")[:255],
                "body": body_text(item.body)[:4000], "recurrence": str(item.recurrence)[:500] if item.recurrence else None,
                "required": [a.mailbox.email_address for a in (item.required_attendees or [])][:100],
                "optional": [a.mailbox.email_address for a in (item.optional_attendees or [])][:100],
                "resources": [a.mailbox.email_address for a in (item.resources or [])][:100]}

    def add_shared_calendar(self, address: str) -> dict:
        account = self._owner(address)
        try:
            folder = account.calendar
            if not folder.id or getattr(getattr(folder, "effective_rights", None), "read", None) is not True:
                raise InputError("folder_read_not_confirmed")
            _ = folder.total_count
            access = "delegate"
        except (ErrorFolderNotFound, ErrorAccessDenied, InputError):
            now = EWSDateTime.now(tz=self.account.default_timezone)
            access = self._free_busy(account.primary_smtp_address, now, now + timedelta(days=1), limit=1)["access"]
        return {"state": "access_checked", "owner": account.primary_smtp_address, "access": access}

    def preview_event(self, spec: dict) -> dict:
        event = validated_event(spec)
        recurrence_for(event)  # build the EWS pattern objects; validated_event checks the fields
        token = secrets.token_hex(24)
        self._previews = {token: (event, time.monotonic() + 120)}
        return {"preview_id": token, "subject": event["subject"], "start": event["start"].isoformat(),
                "end": event["end"].isoformat(), "time_zone": event["time_zone"],
                "attendees": event["attendees"], "recurrence": event["recurrence"],
                "note": "Preview is not a confirmed occurrence expansion"}

    def create_event(self, token: str, confirm: callable) -> dict:
        if os.environ.get("OWA_EWS_ALLOW_WRITE") != "true":
            raise InputError("event_write_disabled")
        selection = self._previews.pop(token, None)
        if not selection or selection[1] < time.monotonic():
            raise InputError("preview_expired_or_unknown")
        event = selection[0]
        rule = event["recurrence"]
        normalized_rule = None if rule is None else (
            rule["frequency"], rule.get("interval", 1), tuple(sorted(rule.get("weekdays") or [])),
            rule.get("month_day"), rule.get("month"), rule.get("ordinal"), rule["ends"]["type"],
            rule["ends"].get("count"), rule["ends"].get("date"),
        )
        fingerprint = (event["subject"], event["start"].isoformat(), event["end"].isoformat(),
                       tuple(sorted((a["role"], a["email"].lower()) for a in event["attendees"])), normalized_rule)
        if fingerprint in self._attempted:
            raise InputError("event_write_already_attempted")
        account = self.account
        guests = {role: [Attendee(mailbox=Mailbox(email_address=a["email"])) for a in event["attendees"] if a["role"] == role]
                  for role in ("required", "optional", "resource")}
        tz = EWSTimeZone.from_timezone(ZoneInfo(event["time_zone"]))
        item = CalendarItem(folder=account.calendar, subject=event["subject"], body=event.get("body", ""),
                            start=event["start"], end=event["end"], is_all_day=event["all_day"],
                            location=event.get("location", ""), recurrence=recurrence_for(event),
                            _start_timezone=tz, _end_timezone=tz,
                            legacy_free_busy_status=event["show_as"], sensitivity=event["sensitivity"],
                            importance=event["importance"], is_response_requested=event["request_responses"],
                            reminder_is_set=event.get("reminder_minutes") is not None,
                            reminder_minutes_before_start=event.get("reminder_minutes") or 0,
                            required_attendees=guests["required"], optional_attendees=guests["optional"], resources=guests["resource"])
        if not confirm(event):
            raise InputError("user_cancelled")
        self._attempted.add(fingerprint)  # only after pre-write checks; uncertain saves cannot be retried
        try:
            item.save(send_meeting_invitations=SEND_TO_ALL_AND_SAVE_COPY if event["attendees"] else SEND_TO_NONE)
        except Exception as exc:
            # Exchange may have committed CreateItem before the network/response failed.
            raise InputError("event_result_uncertain") from exc
        core_fields_verified = False
        try:
            item.refresh()  # read-only GetItem; no repeated CreateItem on failures
            def instant_matches(actual, expected):
                return isinstance(actual, datetime) and actual.astimezone(UTC) == expected.astimezone(UTC)

            def addresses(attendees):
                return sorted(a.mailbox.email_address.lower() for a in (attendees or []))

            if event["all_day"]:
                zone = ZoneInfo(event["time_zone"])
                local_start = event["start"].astimezone(zone)
                local_end = event["end"].astimezone(zone) - timedelta(days=1)
                dates_match = (isinstance(item.start, date) and not isinstance(item.start, datetime) and
                               isinstance(item.end, date) and not isinstance(item.end, datetime) and
                               item.start == date(local_start.year, local_start.month, local_start.day) and
                               item.end == date(local_end.year, local_end.month, local_end.day))
            else:
                dates_match = instant_matches(item.start, event["start"]) and instant_matches(item.end, event["end"])
            core_fields_verified = bool(item.id and item.subject == event["subject"] and
                dates_match and
                addresses(item.required_attendees) == sorted(a["email"].lower() for a in event["attendees"] if a["role"] == "required") and
                addresses(item.optional_attendees) == sorted(a["email"].lower() for a in event["attendees"] if a["role"] == "optional") and
                addresses(item.resources) == sorted(a["email"].lower() for a in event["attendees"] if a["role"] == "resource"))
        except Exception:
            # A newly-created item may fail GetItem deserialization on this Exchange
            # build. A fresh bounded CalendarView can still verify a simple appointment.
            if not event["attendees"] and not event["recurrence"] and not event["all_day"]:
                try:
                    matches = [found for found in account.calendar.view(
                        start=event["start"] - timedelta(minutes=1), end=event["end"] + timedelta(minutes=1),
                        max_items=50).only("subject", "start", "end", "location")
                        if found.id == item.id and found.subject == event["subject"] and
                        found.start.astimezone(UTC) == event["start"].astimezone(UTC) and
                        found.end.astimezone(UTC) == event["end"].astimezone(UTC)]
                    core_fields_verified = len(matches) == 1 and str(matches[0].location or "") == event.get("location", "")
                except Exception:
                    pass
        return {"state": "submitted_verify_in_owa", "core_fields_verified": core_fields_verified,
                "subject": event["subject"], "attendee_count": len(event["attendees"])}
