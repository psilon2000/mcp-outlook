import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalCredentials } from "../src/credentials.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(content: string) {
  const dir = mkdtempSync(join(tmpdir(), "owa-credentials-test-"));
  directories.push(dir);
  const path = join(dir, "credentials.txt");
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

describe("one-off credential file reader", () => {
  it("takes the second line exactly, preserving punctuation and ignoring later lines", () => {
    const path = fixture("\uFEFFtest\\Owner\r\nfixture!dash-punct\r\nnot-the-password\r\n");
    expect(readLocalCredentials(path)).toEqual({ username: "test\\Owner", password: "fixture!dash-punct" });
  });

  it("rejects missing, malformed and oversized files before browser login", () => {
    expect(() => readLocalCredentials(fixture("test\\Owner\n"))).toThrow("credential_format_invalid");
    expect(() => readLocalCredentials(fixture("unknown-user\nfixture-value"))).toThrow("credential_format_invalid");
    expect(() => readLocalCredentials(fixture(`test\\Owner\n${"x".repeat(5000)}`))).toThrow("credential_file_invalid");
  });
});
