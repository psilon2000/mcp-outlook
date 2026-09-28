import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", OWA_UI_MAP_FILE: "" },
  });
  client = new Client({ name: "synthetic-mcp-test", version: "1.0.0" });
  await client.connect(transport);
}, 60_000);
afterAll(async () => { await client?.close(); });

describe("MCP without real account or UI map", () => {
  it("registers tools and denies account data and writes by default", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("list_mail");
    expect(tools.tools.map((t) => t.name)).toContain("create_event");
    const status = await client.callTool({ name: "session_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({ ok: true, data: { state: "closed" } });
    const denied = await client.callTool({ name: "list_mail", arguments: { folder: "Inbox" } });
    expect(denied.structuredContent).toMatchObject({ ok: false, code: "data_access_not_configured" });
    const start = await client.callTool({ name: "start_session", arguments: {} });
    expect(start.structuredContent).toMatchObject({ ok: false, code: "ui_not_calibrated" });
  });

  it("allows offline preview but never writes without local configuration", async () => {
    const prepared = await client.callTool({ name: "preview_event", arguments: {
      subject: "Fixture", start: "2026-10-01T10:00", end: "2026-10-01T11:00", timeZone: "Europe/Moscow",
    } });
    expect(prepared.structuredContent).toMatchObject({ ok: true, data: { event: { subject: "Fixture" } } });
    const previewId = (prepared.structuredContent as { data: { id: string } }).data.id;
    const denied = await client.callTool({ name: "create_event", arguments: { previewId } });
    expect(denied.structuredContent).toMatchObject({ ok: false, code: "data_access_not_configured" });
  });
});
