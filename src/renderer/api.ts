import type { IdeaProject, Spec } from "../shared/project";

export interface AppStatus {
  evercut: { dir?: string; problems: string[] };
  key: { configured: boolean; masked?: string; source?: string; region?: string; model?: string };
  demo: boolean;
}
export interface ProjectSummary {
  id: string;
  title: string;
  updatedAt: string;
  hasVideo: boolean;
}
export interface Voice {
  id: string;
  name: string;
  description: string;
}

declare global {
  interface Window {
    ideacut: {
      call<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
      onProjectChanged(cb: (p: IdeaProject) => void): () => void;
    };
  }
}

const c = <T,>(ch: string, ...a: unknown[]) => window.ideacut.call<T>(ch, ...a);

export const api = {
  status: () => c<AppStatus>("app:status"),
  setKey: (key: string) => c<{ stored: string; masked: string; region: string }>("key:set", key),
  voices: () => c<Voice[]>("voices:list"),
  list: () => c<ProjectSummary[]>("project:list"),
  create: (text: string, spec: Partial<Spec>) => c<IdeaProject>("project:create", text, spec),
  load: (id: string) => c<IdeaProject>("project:load", id),
  update: (id: string, patch: object) => c<IdeaProject>("project:update", id, patch),
  remove: (id: string) => c<void>("project:delete", id),
  addMaterials: (id: string) => c<IdeaProject>("project:addMaterials", id),
  questions: (id: string) => c<{ project: IdeaProject; usedFallback: boolean }>("step:questions", id),
  plan: (id: string) => c<{ project: IdeaProject; usedFallback: boolean }>("step:plan", id),
  storyboard: (id: string) => c<{ project: IdeaProject; usedFallback: boolean }>("step:storyboard", id),
  produce: (id: string) => c<IdeaProject>("step:produce", id),
  running: (id: string) => c<boolean>("project:running", id),
  saveVideo: (id: string) => c<string | null>("video:saveAs", id),
  revealVideo: (id: string) => c<void>("video:reveal", id),
  openInEverCut: (id: string) => c<void>("evercut:open", id),
};

/** URL for a file inside a project folder. */
export const fileUrl = (projectId: string, rel: string, bust?: string) => `ideacut://file/${projectId}/${rel.split("/").map(encodeURIComponent).join("/")}${bust ? `?v=${encodeURIComponent(bust)}` : ""}`;

/** Project-relative path of an absolute path inside the project folder. */
export const relInProject = (projectId: string, abs: string) => {
  const i = abs.indexOf(`/${projectId}/`);
  return i >= 0 ? abs.slice(i + projectId.length + 2) : abs;
};
