import { lstatSync, readFileSync } from "node:fs";

// For a one-off local login only. Never expose the result to MCP, logs or a file.
export function readLocalCredentials(path: string): { username: string; password: string } {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 3 || info.size > 4096) {
    throw new Error("credential_file_invalid");
  }
  const lines = readFileSync(path, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const username = lines[0];
  const password = lines[1];
  if (!username || !/^[^\s\\]{1,64}\\[^\s\\]{1,128}$/.test(username) || !password || password.length > 256 || /[\x00-\x1F]/.test(password)) {
    throw new Error("credential_format_invalid");
  }
  return { username, password };
}
