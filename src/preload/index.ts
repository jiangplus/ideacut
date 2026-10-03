import { contextBridge, ipcRenderer } from "electron";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("ideacut", {
  call,
  onProjectChanged: (cb: (p: unknown) => void) => {
    const listener = (_e: unknown, p: unknown) => cb(p);
    ipcRenderer.on("project:changed", listener);
    return () => ipcRenderer.off("project:changed", listener);
  },
});
