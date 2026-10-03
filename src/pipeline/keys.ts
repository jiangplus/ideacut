// The MiniMax key is shared with EverCut: same keychain entry (or MINIMAX_API_KEY), so one
// key set in either app works in both.

import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVICE = "dev.evercut.providers";
const ACCOUNT = "minimax";
const home = () => process.env.EVERCUT_HOME ?? join(homedir(), ".evercut");
const credFile = () => join(home(), "credentials.json");
const keychain = () => process.platform === "darwin" && !process.env.EVERCUT_NO_KEYCHAIN;

function readFileStore(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(credFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Shared with EverCut: ~/.evercut/providers.json → { minimax: { baseUrl } }. */
const settingsFile = () => join(home(), "providers.json");
export function getMiniMaxBaseUrl(): string | undefined {
  if (process.env.MINIMAX_BASE_URL) return process.env.MINIMAX_BASE_URL;
  try {
    return (JSON.parse(readFileSync(settingsFile(), "utf8")) as { minimax?: { baseUrl?: string } }).minimax?.baseUrl;
  } catch {
    return undefined;
  }
}
export function setMiniMaxBaseUrl(baseUrl: string) {
  let all: Record<string, Record<string, unknown>> = {};
  try {
    all = JSON.parse(readFileSync(settingsFile(), "utf8"));
  } catch {
    /* new file */
  }
  all.minimax = { ...all.minimax, baseUrl };
  mkdirSync(home(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(all, null, 2));
}

export async function getMiniMaxKey(): Promise<{ key: string; source: "env" | "keychain" | "file" } | undefined> {
  if (process.env.MINIMAX_API_KEY) return { key: process.env.MINIMAX_API_KEY, source: "env" };
  if (keychain()) {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
      if (stdout.trim()) return { key: stdout.trim(), source: "keychain" };
    } catch {
      /* not stored */
    }
  }
  const k = readFileStore()[ACCOUNT];
  return k ? { key: k, source: "file" } : undefined;
}

export async function setMiniMaxKey(key: string): Promise<"keychain" | "file"> {
  if (keychain()) {
    await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-l", "EverCut minimax API key", "-w", key]);
    return "keychain";
  }
  mkdirSync(home(), { recursive: true });
  writeFileSync(credFile(), JSON.stringify({ ...readFileStore(), [ACCOUNT]: key }, null, 2), { mode: 0o600 });
  chmodSync(credFile(), 0o600);
  return "file";
}

export const maskKey = (k: string) => (k.length <= 10 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`);
