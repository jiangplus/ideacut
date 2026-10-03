// Small FFmpeg helpers (FFmpeg runs as a separate program, as in EverCut).

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

function find(name: string, envVar: string): string {
  if (process.env[envVar]) return process.env[envVar]!;
  const dirs = (process.env.PATH ?? "").split(":");
  if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const d of dirs) if (d && existsSync(join(d, name))) return join(d, name);
  throw new Error(`${name} not found. Install FFmpeg (macOS: brew install ffmpeg) or set ${envVar}.`);
}

export async function ffmpeg(args: string[]): Promise<void> {
  await run(find("ffmpeg", "EVERCUT_FFMPEG"), ["-hide_banner", "-loglevel", "error", "-y", ...args], { maxBuffer: 1 << 26 });
}

export async function audioDuration(file: string): Promise<number> {
  const { stdout } = await run(find("ffprobe", "EVERCUT_FFPROBE"), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  return Number(stdout.trim()) || 0;
}

/** Silence of a given length (demo voice-over). */
export async function silence(seconds: number, out: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=32000:cl=mono", "-t", seconds.toFixed(3), "-c:a", "libmp3lame", "-b:a", "64k", out]);
}

/**
 * A calm synthesized pad (A-minor-ish chord with slow tremolo), used when AI music isn't
 * available. Loops cleanly enough for background use.
 */
export async function ambientPad(seconds: number, out: string): Promise<void> {
  const notes = [110, 164.81, 220, 261.63, 329.63];
  const inputs = notes.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:sample_rate=44100:duration=${seconds.toFixed(2)}`]);
  const mix = `${notes.map((_, i) => `[${i}:a]`).join("")}amix=inputs=${notes.length}:normalize=1,tremolo=f=0.15:d=0.35,lowpass=f=1800,volume=0.5,afade=t=in:d=2,afade=t=out:st=${Math.max(0, seconds - 3).toFixed(2)}:d=3[out]`;
  await ffmpeg([...inputs, "-filter_complex", mix, "-map", "[out]", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", out]);
}
