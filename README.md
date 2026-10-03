# IdeaCut

From a startup idea to a project intro video, in one flow:

**想法 → AI 追问 → 项目方案 → 分镜 → 一键出片**

IdeaCut is a focused desktop app built on [EverCut](../ideacut): it writes, voices and assembles the
video, then hands a normal EverCut project over for fine-tuning if you want it.

## How the workflow stays reliable

- Every step is saved to `~/IdeaCut/<project>/ideacut.json`; reopen a project and continue anywhere.
- Editing an earlier step only marks the later ones as out of date — nothing is thrown away.
- All model output is JSON checked against a schema; invalid replies are sent back for repair,
  and after three failures a rule-based fallback is used, so the flow never dead-ends.
- Voice-over and music are cached by content, so re-producing after a small edit is quick.
- Music is optional: MiniMax music first, a built-in synthesized bed if it's unavailable.
- Video assembly is a pure function of the storyboard + voice timings (same input → same timeline).
- Without an API key the whole flow runs in **demo mode** (rule-based writing, silent voice-over).

## AI services

One MiniMax API key (shared with EverCut, stored in the macOS Keychain) covers:
text (`MiniMax-M3.1-Flash-Preview` when the account offers it, else `MiniMax-M3` / `M2.7`), voice (`speech-2.8-hd`, with sentence timings for captions) and music
(`music-3.0`). Usage is billed by MiniMax to your account.

## Requirements

- Node 22+, pnpm, FFmpeg on PATH (`brew install ffmpeg`)
- For development and packaging only: EverCut checked out next to this folder (`../ideacut`,
  or set `EVERCUT_DIR`) and built (`cd ../ideacut && pnpm install && pnpm build`). End users
  don't need this — the packaged app contains EverCut.

## Run

```sh
pnpm install
pnpm build && pnpm start     # or: pnpm dev
pnpm test                    # unit tests + an end-to-end demo run through EverCut
```

## Package (macOS, Apple Silicon)

```sh
cd ../ideacut && pnpm build          # EverCut must be built first
cd ../ideacut-app && pnpm package    # → release/IdeaCut-<version>-arm64.dmg / .zip
release/mac-arm64/IdeaCut.app/Contents/MacOS/IdeaCut --selftest=/tmp/ideacut-selftest   # demo run end to end
```

Users install **only IdeaCut** — EverCut is not a separate install. The app bundles everything it needs: EverCut's runtime (Resources/evercut, loaded by the same
binary for render workers and "在 EverCut 中精修") and a static GPLv3 FFmpeg (Resources/ffmpeg,
run as a separate program; source/link in its README.txt). Users enter their own MiniMax key in
Settings; the platform (international `api.minimax.io` or China `api.minimaxi.com`) is detected
from the key. The build is ad-hoc signed (no Developer ID yet): on another Mac, right-click →
Open the first time, or run `xattr -cr /Applications/IdeaCut.app`.

## Layout

```
src/shared     project model, video settings, scene template catalog
src/pipeline   MiniMax client, prompts + JSON repair, fallbacks, compile, produce, EverCut RPC client
src/templates  10 scene templates (motion graphics compiled by EverCut)
src/main       Electron main: workflow service, IPC, project file protocol
src/renderer   the five-step UI
```

IdeaCut never imports EverCut code: it starts a private `evercut engine start --no-advertise`
and talks JSON-RPC to it.

## License

Apache-2.0
