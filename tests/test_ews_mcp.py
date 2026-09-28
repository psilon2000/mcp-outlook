"""Verify stdio registration and write denial without a live mailbox."""

import json
import os
import sys
import unittest
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class EwsMcpTests(unittest.IsolatedAsyncioTestCase):
    async def test_tools_and_offline_preview(self):
        script = Path(__file__).resolve().parents[1] / "src" / "ews_server.py"
        parameters = StdioServerParameters(command=sys.executable, args=[str(script)],
            env={**os.environ, "OWA_EWS_CREDENTIAL_FILE": "", "OWA_EWS_ALLOW_WRITE": "false"})
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {tool.name for tool in (await session.list_tools()).tools}
                self.assertIn("ews_list_mail", names)
                self.assertIn("ews_calendar_events", names)
                self.assertIn("ews_preview_event", names)
                self.assertIn("ews_create_event", names)
                spec = {"subject": "Fixture", "start": "2026-10-01T10:00:00+03:00",
                        "end": "2026-10-01T11:00:00+03:00", "time_zone": "Europe/Moscow"}
                preview = await session.call_tool("ews_preview_event", {"event": spec})
                prepared = preview.structuredContent or json.loads(preview.content[0].text)
                self.assertTrue(prepared["ok"])
                denied = await session.call_tool("ews_create_event", {"preview_id": prepared["data"]["preview_id"]})
                outcome = denied.structuredContent or json.loads(denied.content[0].text)
                self.assertEqual(outcome["code"], "event_write_disabled")


if __name__ == "__main__":
    unittest.main()
