// Project folders under ~/IdeaCut (or IDEACUT_HOME):
//   <id>/ideacut.json   workflow state
//   <id>/materials/     uploaded screenshots
//   <id>/audio/         voice-over + music (cached by content hash)
//   <id>/video.evercut/ the generated EverCut project (open it in EverCut to fine-tune)
//   <id>/video.mp4      the result

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { IdeaProject, Spec, type StepKey } from "../shared/project";

export const ideacutHome = () => process.env.IDEACUT_HOME ?? join(homedir(), "IdeaCut");

export class ProjectStore {
  constructor(readonly root = ideacutHome()) {
    mkdirSync(root, { recursive: true });
  }

  dir(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error(`bad project id ${id}`);
    return join(this.root, id);
  }

  list(): { id: string; title: string; updatedAt: string; hasVideo: boolean }[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, "ideacut.json")))
      .flatMap((d) => {
        try {
          const p = this.load(d.name);
          return [{ id: p.id, title: p.title, updatedAt: p.updatedAt, hasVideo: !!p.run?.output && existsSync(p.run.output) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(init: { text: string; title?: string; spec?: Partial<Spec> }): IdeaProject {
    const now = new Date().toISOString();
    const id = `${now.slice(0, 10)}-${randomBytes(3).toString("hex")}`;
    const project = IdeaProject.parse({
      version: 1,
      id,
      createdAt: now,
      updatedAt: now,
      title: init.title?.trim() || init.text.trim().split(/[:：,，。.\n]/)[0]!.slice(0, 24) || "Untitled",
      spec: Spec.parse(init.spec ?? {}),
      idea: { text: init.text, details: "", materials: [] },
    });
    mkdirSync(join(this.dir(id), "materials"), { recursive: true });
    this.save(project);
    return project;
  }

  load(id: string): IdeaProject {
    return IdeaProject.parse(JSON.parse(readFileSync(join(this.dir(id), "ideacut.json"), "utf8")));
  }

  save(project: IdeaProject): IdeaProject {
    const next = { ...project, updatedAt: new Date().toISOString() };
    const file = join(this.dir(project.id), "ideacut.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${file}.tmp`, file);
    return next;
  }

  remove(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** Copies an uploaded file into materials/ and returns its project-relative path. */
  addMaterial(id: string, src: string): { path: string; name: string } {
    const dir = join(this.dir(id), "materials");
    mkdirSync(dir, { recursive: true });
    const base = basename(src, extname(src)).replace(/[^\w.-]+/g, "_").slice(0, 40) || "image";
    let name = `${base}${extname(src).toLowerCase()}`;
    for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}${extname(src).toLowerCase()}`;
    copyFileSync(src, join(dir, name));
    return { path: `materials/${name}`, name: basename(src) };
  }
}

/** Steps that become out of date when `changed` is edited. */
export function downstream(changed: StepKey): StepKey[] {
  const order: StepKey[] = ["idea", "questions", "plan", "storyboard", "video"];
  return order.slice(order.indexOf(changed) + 1);
}
