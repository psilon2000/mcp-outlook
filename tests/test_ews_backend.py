"""Offline EWS contract checks. No real mailbox or meeting is touched."""

import os
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
from exchangelib import Attendee, Build, CalendarItem, EWSTimeZone, Mailbox, Version

from exchangelib.errors import ErrorFolderNotFound
from ews_backend import EwsBackend, InputError, body_text, parse_date_time, recurrence_for, resolve_own_mailbox, validated_event


BASE = {"subject": "Synthetic event", "start": "2026-10-01T10:00:00+03:00",
        "end": "2026-10-01T11:00:00+03:00", "time_zone": "Europe/Moscow"}


class ContractTests(unittest.TestCase):
    def test_timezone_and_html_body(self):
        event = validated_event(BASE)
        self.assertEqual(event["start"].hour, 7)  # UTC instant, local appointment at 10:00
        with self.assertRaisesRegex(InputError, "time_zone_offset_mismatch"):
            validated_event({**BASE, "start": "2026-10-01T06:00:00+00:00"})
        with self.assertRaisesRegex(InputError, "invalid_date_time"):
            validated_event({**BASE, "start": None})
        self.assertEqual(body_text("<p>Hello</p><script>ignored()</script><p>world</p>").split(), ["Hello", "world"])
        self.assertEqual(body_text("&amp;lt;admin&amp;gt;"), "&lt;admin&gt;")

    def test_supported_recurrence_shapes(self):
        rules = [
            ("2026-10-01", {"frequency": "daily", "ends": {"type": "never"}}, "DailyPattern", "NoEndPattern"),
            ("2026-10-01", {"frequency": "weekly", "weekdays": [1, 4], "ends": {"type": "count", "count": 3}}, "WeeklyPattern", "NumberedPattern"),
            ("2026-10-31", {"frequency": "monthly", "month_day": 31, "ends": {"type": "until", "date": "2026-12-31"}}, "AbsoluteMonthlyPattern", "EndDatePattern"),
            ("2026-10-30", {"frequency": "monthly", "ordinal": -1, "weekdays": [5], "ends": {"type": "never"}}, "RelativeMonthlyPattern", "NoEndPattern"),
            ("2026-10-01", {"frequency": "yearly", "month": 10, "month_day": 1, "ends": {"type": "count", "count": 2}}, "AbsoluteYearlyPattern", "NumberedPattern"),
            ("2026-10-12", {"frequency": "yearly", "month": 10, "ordinal": 2, "weekdays": [1], "ends": {"type": "never"}}, "RelativeYearlyPattern", "NoEndPattern"),
        ]
        for start, rule, pattern, boundary in rules:
            with self.subTest(rule=rule):
                item = recurrence_for(validated_event({**BASE, "start": f"{start}T10:00:00+03:00", "end": f"{start}T11:00:00+03:00", "recurrence": rule}))
                self.assertEqual(type(item.pattern).__name__, pattern)
                self.assertEqual(type(item.boundary).__name__, boundary)
                xml = item.to_xml(Version(build=Build(15, 2, 1544, 0)))
                self.assertEqual({node.tag.split("}")[-1] for node in xml}, {item.pattern.ELEMENT_NAME, item.boundary.ELEMENT_NAME})

    def test_ews_xml_contains_pattern_boundary_and_all_attendee_roles(self):
        spec = {**BASE, "recurrence": {"frequency": "weekly", "weekdays": [4], "ends": {"type": "count", "count": 2}}}
        event = validated_event(spec)
        item = CalendarItem(subject=event["subject"], start=event["start"], end=event["end"], is_all_day=False,
            recurrence=recurrence_for(event),
            required_attendees=[Attendee(mailbox=Mailbox(email_address="required@example.test"))],
            optional_attendees=[Attendee(mailbox=Mailbox(email_address="optional@example.test"))],
            resources=[Attendee(mailbox=Mailbox(email_address="resource@example.test"))])
        xml = item.to_xml(Version(build=Build(15, 2, 1544, 0)))
        names = {element.tag.split("}")[-1] for element in xml.iter()}
        for expected in ("CalendarItem", "WeeklyRecurrence", "NumberedRecurrence", "RequiredAttendees", "OptionalAttendees", "Resources"):
            self.assertIn(expected, names)

    def test_rejects_unrepresentable_or_unsafe_input(self):
        cases = [
            {"recurrence": {"frequency": "yearly", "interval": 2, "month": 10, "month_day": 1, "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "monthly", "month_day": 15, "weekdays": [1], "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "weekly", "weekdays": [1, 1], "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "weekly", "weekdays": [1], "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "monthly", "month_day": 15, "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "yearly", "month": 11, "month_day": 1, "ends": {"type": "never"}}},
            {"recurrence": {"frequency": "daily", "ends": {"type": "never", "count": 5}}},
            {"attendees": [{"role": "required", "email": "a@example.test"}, {"role": "optional", "email": "A@example.test"}]},
            {"unverified_field": "discarding it would be unsafe"},
        ]
        for fields in cases:
            with self.subTest(fields=list(fields)):
                with self.assertRaises(InputError):
                    validated_event({**BASE, **fields})

    def test_ambiguous_directory_resolution_requires_exact_configured_address(self):
        xml = b'''<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><s:Body><m:ResolveNamesResponse><m:ResponseMessages><m:ResolveNamesResponseMessage ResponseClass="Warning"><m:ResponseCode>ErrorNameResolutionMultipleResults</m:ResponseCode><m:ResolutionSet><t:Resolution><t:Mailbox><t:EmailAddress>ivanov@example.test</t:EmailAddress></t:Mailbox></t:Resolution><t:Resolution><t:Mailbox><t:EmailAddress>ivanova@example.test</t:EmailAddress></t:Mailbox></t:Resolution></m:ResolutionSet></m:ResolveNamesResponseMessage></m:ResponseMessages></m:ResolveNamesResponse></s:Body></s:Envelope>'''
        with patch("ews_backend.requests.Session") as session:
            session.return_value.__enter__.return_value.post.return_value = SimpleNamespace(status_code=200, content=xml)
            with self.assertRaisesRegex(InputError, "mailbox_resolution_ambiguous"):
                resolve_own_mailbox("test\\ivanov", "synthetic")
            self.assertEqual(resolve_own_mailbox("test\\ivanov", "synthetic", expected="ivanov@example.test"), "ivanov@example.test")
            with self.assertRaisesRegex(InputError, "configured_mailbox_not_resolved"):
                resolve_own_mailbox("test\\ivanov", "synthetic", expected="other@example.test")

    def test_write_requires_external_confirmation_and_single_attempt(self):
        backend = EwsBackend("unused-test-file")
        preview = backend.preview_event({**BASE, "attendees": [{"role": "required", "email": "fixture@example.test"}]})
        with self.assertRaisesRegex(InputError, "event_write_disabled"):
            backend.create_event(preview["preview_id"], lambda _: True)
        backend._account = SimpleNamespace(calendar=object())
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            with self.assertRaisesRegex(InputError, "user_cancelled"):
                backend.create_event(preview["preview_id"], lambda _: False)
            self.assertEqual(item_cls.return_value.save.call_count, 0)
            next_preview = backend.preview_event({**BASE, "attendees": [{"role": "required", "email": "fixture@example.test"}]})
            created = backend.create_event(next_preview["preview_id"], lambda _: True)
            self.assertEqual(created["state"], "submitted_verify_in_owa")
            self.assertEqual(item_cls.call_count, 2)  # construction is side-effect-free; only one save
            self.assertEqual(item_cls.return_value.save.call_count, 1)
            with self.assertRaisesRegex(InputError, "preview_expired_or_unknown"):
                backend.create_event(next_preview["preview_id"], lambda _: True)
            third = backend.preview_event({**BASE, "attendees": [{"role": "required", "email": "FIXTURE@example.test"}]})
            with self.assertRaisesRegex(InputError, "event_write_already_attempted"):
                backend.create_event(third["preview_id"], lambda _: True)

    def test_save_timeout_is_uncertain_and_equivalent_rule_cannot_retry(self):
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=object())
        rule = {"frequency": "daily", "ends": {"type": "count", "count": 2}}
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item_cls.return_value.save.side_effect = TimeoutError("synthetic disconnected response")
            first = backend.preview_event({**BASE, "recurrence": rule})
            with self.assertRaisesRegex(InputError, "event_result_uncertain"):
                backend.create_event(first["preview_id"], lambda _: True)
            second = backend.preview_event({**BASE, "recurrence": {**rule, "interval": 1}})
            with self.assertRaisesRegex(InputError, "event_write_already_attempted"):
                backend.create_event(second["preview_id"], lambda _: True)
            self.assertEqual(item_cls.return_value.save.call_count, 1)

    def test_sent_and_drafts_return_the_fetched_date_in_recent_first_order(self):
        class FakeQuery:
            def __init__(self, item):
                self.item = item
                self.ordering = None
                self.fields = None

            def order_by(self, value):
                self.ordering = value
                return self

            def only(self, *fields):
                self.fields = fields
                return self

            def __getitem__(self, key):
                return [self.item][:key.stop]

        sent = FakeQuery(SimpleNamespace(id="synthetic-sent", subject="Sent", datetime_sent=datetime(2026, 10, 1, tzinfo=timezone.utc), sender=None))
        drafts = FakeQuery(SimpleNamespace(id="synthetic-draft", subject="Draft", datetime_created=datetime(2026, 10, 2, tzinfo=timezone.utc), sender=None))
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(primary_smtp_address="owner@example.test",
            sent=SimpleNamespace(all=lambda: sent), drafts=SimpleNamespace(all=lambda: drafts))
        self.assertEqual(backend.list_mail("sent", 1)["messages"][0]["date"], "2026-10-01T00:00:00+00:00")
        self.assertEqual(backend.list_mail("drafts", 1)["messages"][0]["date"], "2026-10-02T00:00:00+00:00")
        self.assertEqual(sent.ordering, "-datetime_sent")
        self.assertEqual(drafts.ordering, "-datetime_created")

    def test_failed_prewrite_auth_does_not_block_retry_with_new_preview(self):
        backend = EwsBackend("missing-fixture-file")
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}):
            first = backend.preview_event(BASE)
            with self.assertRaisesRegex(InputError, "credential_file_invalid"):
                backend.create_event(first["preview_id"], lambda _: True)
            self.assertFalse(backend._attempted)
            backend._account = SimpleNamespace(calendar=object())
            with patch("ews_backend.CalendarItem") as item_cls:
                second = backend.preview_event(BASE)
                backend.create_event(second["preview_id"], lambda _: True)
                self.assertEqual(item_cls.return_value.save.call_count, 1)

    def test_all_day_verification_uses_inclusive_end_date_returned_by_exchange(self):
        all_day = {"subject": "All day fixture", "start": "2026-10-01T00:00:00+03:00",
                   "end": "2026-10-02T00:00:00+03:00", "time_zone": "Europe/Moscow", "all_day": True}
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=object())
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item = item_cls.return_value
            item.id = "synthetic-id"
            item.subject = all_day["subject"]
            item.start = datetime(2026, 10, 1, tzinfo=timezone.utc).date()
            item.end = datetime(2026, 10, 1, tzinfo=timezone.utc).date()
            item.required_attendees = item.optional_attendees = item.resources = []
            token = backend.preview_event(all_day)["preview_id"]
            result = backend.create_event(token, lambda _: True)
            self.assertTrue(result["core_fields_verified"])

    def test_simple_event_falls_back_to_calendar_view_if_get_item_cannot_parse(self):
        event = validated_event(BASE)
        local_tz = EWSTimeZone("Europe/Moscow")
        found = SimpleNamespace(id="created-id", subject=BASE["subject"],
            start=event["start"].astimezone(local_tz), end=event["end"].astimezone(local_tz), location="")
        calls = []
        def view(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(only=lambda *fields: [found])
        folder = SimpleNamespace(view=view)
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=folder)
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item_cls.return_value.refresh.side_effect = ValueError("synthetic GetItem parse failure")
            item_cls.return_value.id = "created-id"
            token = backend.preview_event(BASE)["preview_id"]
            result = backend.create_event(token, lambda _: True)
            self.assertTrue(result["core_fields_verified"], f"fallback calls: {len(calls)}")
            self.assertEqual(item_cls.return_value.save.call_count, 1)

    def test_fallback_does_not_verify_an_older_lookalike_with_another_id(self):
        event = validated_event(BASE)
        unrelated = SimpleNamespace(id="older-item-id", subject=BASE["subject"],
            start=event["start"], end=event["end"], location="")
        folder = SimpleNamespace(view=lambda **kwargs: SimpleNamespace(only=lambda *fields: [unrelated]))
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=folder)
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item_cls.return_value.id = "new-item-id"
            item_cls.return_value.refresh.side_effect = ValueError("synthetic GetItem parse failure")
            preview = backend.preview_event(BASE)
            result = backend.create_event(preview["preview_id"], lambda _: True)
            self.assertFalse(result["core_fields_verified"])

    def test_fallback_same_id_but_shifted_start_is_not_verified(self):
        event = validated_event(BASE)
        shifted = SimpleNamespace(id="created-id", subject=BASE["subject"],
            start=event["start"] + timedelta(minutes=1), end=event["end"], location="")
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=SimpleNamespace(view=lambda **kwargs: SimpleNamespace(only=lambda *fields: [shifted])))
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item_cls.return_value.id = "created-id"
            item_cls.return_value.refresh.side_effect = ValueError("synthetic GetItem parse failure")
            token = backend.preview_event(BASE)["preview_id"]
            self.assertFalse(backend.create_event(token, lambda _: True)["core_fields_verified"])

    def test_timed_event_getitem_verification_uses_ews_utc_timezone(self):
        event = validated_event(BASE)
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=object())
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item = item_cls.return_value
            item.id = "synthetic-id"
            item.subject = BASE["subject"]
            local_tz = EWSTimeZone("Europe/Moscow")
            item.start, item.end = event["start"].astimezone(local_tz), event["end"].astimezone(local_tz)
            item.required_attendees = item.optional_attendees = item.resources = []
            token = backend.preview_event(BASE)["preview_id"]
            self.assertTrue(backend.create_event(token, lambda _: True)["core_fields_verified"])

    def test_timed_getitem_same_id_but_shifted_end_is_not_verified(self):
        event = validated_event(BASE)
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(calendar=object())
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_WRITE": "true"}), patch("ews_backend.CalendarItem") as item_cls:
            item = item_cls.return_value
            item.id = "created-id"
            item.subject = BASE["subject"]
            item.start = event["start"]
            item.end = event["end"] + timedelta(minutes=1)
            item.required_attendees = item.optional_attendees = item.resources = []
            token = backend.preview_event(BASE)["preview_id"]
            self.assertFalse(backend.create_event(token, lambda _: True)["core_fields_verified"])

    def test_shared_calendar_falls_back_to_freebusy_without_exposing_hidden_details(self):
        colleague = "colleague@example.test"

        class NoDelegateFolder:
            primary_smtp_address = colleague

            @property
            def calendar(self):
                raise ErrorFolderNotFound("fixture: no delegated folder")

        entry = SimpleNamespace(start=parse_date_time("2026-10-01T10:00:00+03:00"),
            end=parse_date_time("2026-10-01T11:00:00+03:00"), busy_type="Busy",
            details=SimpleNamespace(subject="private detail must not be read"))
        view = SimpleNamespace(view_type="FreeBusy", calendar_events=[entry])
        protocol = SimpleNamespace(get_free_busy_info=lambda **kwargs: [view])
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(primary_smtp_address="owner@example.test", protocol=protocol,
            default_timezone=entry.start.tzinfo)
        backend._shared[colleague] = NoDelegateFolder()
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_SHARED": "true", "OWA_EWS_ALLOW_CALENDAR_DETAILS": "true"}):
            result = backend.calendar_events("2026-10-01T00:00:00+03:00", "2026-10-02T00:00:00+03:00", mailbox=colleague)
            self.assertEqual(result["access"], "freebusy")
            self.assertIsNone(result["events"][0]["subject"])
            self.assertNotIn("private detail", str(result))
            details = backend.event_details(result["events"][0]["id"])
            self.assertEqual(details["access"], "busy")
            self.assertIsNone(details["body"])
            self.assertEqual(backend.add_shared_calendar(colleague)["access"], "freebusy")

    def test_availability_exposes_only_server_granted_nonprivate_details(self):
        address = "colleague@example.test"
        entries = [
            SimpleNamespace(start=parse_date_time("2026-10-01T10:00:00+03:00"),
                end=parse_date_time("2026-10-01T11:00:00+03:00"), busy_type="Busy",
                details=SimpleNamespace(subject="Synthetic shared title", location="Fixture room", is_private=False)),
            SimpleNamespace(start=parse_date_time("2026-10-01T12:00:00+03:00"),
                end=parse_date_time("2026-10-01T13:00:00+03:00"), busy_type="Busy",
                details=SimpleNamespace(subject="Secret fixture", location="Secret fixture room", is_private=True)),
            SimpleNamespace(start=parse_date_time("2026-10-01T14:00:00+03:00"),
                end=parse_date_time("2026-10-01T15:00:00+03:00"), busy_type="Busy",
                details=SimpleNamespace(subject="Unclassified secret", location="Unclassified location", is_private=None)),
        ]
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(protocol=SimpleNamespace(get_free_busy_info=lambda **kwargs: [
            SimpleNamespace(view_type="Detailed", calendar_events=entries)]))
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_CALENDAR_DETAILS": "true"}):
            result = backend._free_busy(address, entries[0].start, entries[-1].end, limit=3)
            self.assertEqual(result["access"], "detailed")
            self.assertEqual(result["events"][0]["subject"], "Synthetic shared title")
            self.assertIsNone(result["events"][1]["subject"])
            self.assertIsNone(result["events"][2]["subject"])
            self.assertNotIn("Secret fixture", str(result))
            self.assertNotIn("Unclassified secret", str(result))
            details = backend.event_details(result["events"][0]["id"])
            self.assertEqual(details["access"], "detailed")
            self.assertIsNone(details["body"])
            backend._account.protocol.get_free_busy_info = lambda **kwargs: [SimpleNamespace(view_type="Detailed", calendar_events=[])]
            self.assertEqual(backend._free_busy(address, entries[0].start, entries[-1].end, limit=1)["access"], "detailed")

    def test_delegated_private_event_is_masked_even_when_folder_is_readable(self):
        address = "colleague@example.test"
        item = SimpleNamespace(id="fixture-id", sensitivity="Private", subject="Delegate secret",
            location="Private location", body="Private body", start=parse_date_time("2026-10-01T10:00:00+03:00"),
            end=parse_date_time("2026-10-01T11:00:00+03:00"), is_all_day=False)
        folder = SimpleNamespace(id="folder-id", effective_rights=SimpleNamespace(read=True), total_count=1,
            view=lambda **kwargs: SimpleNamespace(only=lambda *fields: [item]), get=lambda **kwargs: item)
        backend = EwsBackend("unused-test-file")
        backend._account = SimpleNamespace(primary_smtp_address="owner@example.test")
        backend._shared[address] = SimpleNamespace(primary_smtp_address=address, calendar=folder)
        with patch.dict(os.environ, {"OWA_EWS_ALLOW_SHARED": "true", "OWA_EWS_ALLOW_CALENDAR_DETAILS": "true"}):
            result = backend.calendar_events("2026-10-01T00:00:00+03:00", "2026-10-02T00:00:00+03:00", mailbox=address)
            self.assertEqual(result["access"], "delegate")
            self.assertIsNone(result["events"][0]["subject"])
            self.assertIsNone(result["events"][0]["location"])
            details = backend.event_details(result["events"][0]["id"])
            self.assertEqual(details["access"], "busy")
            self.assertNotIn("Delegate secret", str(details))
            self.assertNotIn("Private body", str(details))
            self.assertEqual(backend.add_shared_calendar(address)["state"], "access_checked")


if __name__ == "__main__":
    unittest.main()
