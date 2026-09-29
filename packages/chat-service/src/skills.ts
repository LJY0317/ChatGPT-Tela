import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";
import { safeRelativePath } from "./paths";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_SKILL_RESOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_LINES = 400;
const MAX_SKILLS = 256;

export interface ChatSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: "project" | "global";
}

interface ChatSkillRecord extends ChatSkillSummary {
  readonly baseDir: string;
  readonly skillFile: string;
}

export interface ChatSkillReadResult {
  readonly skill: string;
  readonly source: "project" | "global";
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly hasMore: boolean;
  readonly content: string;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function frontmatterScalar(text: string, key: string): string | undefined {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
  const lines = text.split(/\r?\n/);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "---") break;
    const match = line.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "i"));
    if (!match) continue;
    const raw = match[1]!.trim();
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1).trim();
    }
    return raw;
  }
  return undefined;
}

function validSkillName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function loadSkillRoot(root: string, source: "project" | "global"): readonly ChatSkillRecord[] {
  if (!existsSync(root)) return Object.freeze([]);
  const canonicalRoot = realpathSync(root);
  const rootStat = statSync(canonicalRoot);
  if (!rootStat.isDirectory()) throw new Error(`${source} skill root is not a directory`);
  const records: ChatSkillRecord[] = [];
  const entries = readdirSync(canonicalRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (records.length >= MAX_SKILLS) break;
    if (!entry.isDirectory()) continue;
    const baseCandidate = resolve(canonicalRoot, entry.name);
    const baseDir = realpathSync(baseCandidate);
    if (!inside(canonicalRoot, baseDir)) continue;
    const skillFileCandidate = resolve(baseDir, "SKILL.md");
    if (!existsSync(skillFileCandidate)) continue;
    const skillFile = realpathSync(skillFileCandidate);
    if (!inside(baseDir, skillFile)) continue;
    const stat = statSync(skillFile);
    if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) continue;
    const bytes = readFileSync(skillFile);
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    if (frontmatterScalar(content, "disable-model-invocation")?.toLowerCase() === "true") continue;
    const declaredName = frontmatterScalar(content, "name") ?? entry.name;
    if (!validSkillName(declaredName)) continue;
    const description = frontmatterScalar(content, "description") ?? `Workspace skill ${declaredName}`;
    records.push(Object.freeze({
      name: declaredName,
      description: description.slice(0, 2_048),
      source,
      baseDir,
      skillFile,
    }));
  }
  return Object.freeze(records);
}

export class ChatSkillCatalog {
  readonly #workspaces: ChatWorkspaceRegistry;
  readonly #globalRoots: readonly string[];

  constructor(input: {
    readonly workspaces: ChatWorkspaceRegistry;
    readonly globalRoots?: readonly string[];
  }) {
    this.#workspaces = input.workspaces;
    this.#globalRoots = Object.freeze((input.globalRoots ?? [resolve(homedir(), ".agents", "skills")])
      .map(root => resolve(root)));
  }

  #records(workspaceId: string): readonly ChatSkillRecord[] {
    const workspace = this.#workspaces.get(workspaceId);
    const projectRoot = resolve(workspace.root, ".agents", "skills");
    let project: readonly ChatSkillRecord[] = Object.freeze([]);
    if (existsSync(projectRoot)) {
      const canonical = realpathSync(projectRoot);
      if (!inside(workspace.root, canonical)) throw new Error("project skill root resolves outside the workspace");
      project = loadSkillRoot(canonical, "project");
    }
    const global = this.#globalRoots.flatMap(root => loadSkillRoot(root, "global"));
    const byName = new Map<string, ChatSkillRecord>();
    for (const skill of global) if (!byName.has(skill.name)) byName.set(skill.name, skill);
    for (const skill of project) byName.set(skill.name, skill);
    return Object.freeze([...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS));
  }

  list(workspaceId: string, query = ""): readonly ChatSkillSummary[] {
    const needle = query.trim().toLocaleLowerCase();
    return Object.freeze(this.#records(workspaceId)
      .filter(skill => !needle || skill.name.toLocaleLowerCase().includes(needle)
        || skill.description.toLocaleLowerCase().includes(needle))
      .map(skill => Object.freeze({ name: skill.name, description: skill.description, source: skill.source })));
  }

  read(input: {
    readonly workspaceId: string;
    readonly name: string;
    readonly path?: string;
    readonly offset?: number;
    readonly limit?: number;
  }): ChatSkillReadResult {
    const skill = this.#records(input.workspaceId).find(candidate => candidate.name === input.name);
    if (!skill) throw new Error(`unknown Tela Chat skill: ${input.name}`);
    const path = input.path === undefined ? "SKILL.md" : safeRelativePath(input.path);
    const candidate = resolve(skill.baseDir, path);
    if (!existsSync(candidate)) throw new Error(`skill resource does not exist: ${path}`);
    const absolute = realpathSync(candidate);
    if (!inside(skill.baseDir, absolute)) throw new Error("skill resource resolves outside the skill directory");
    const stat = statSync(absolute);
    if (!stat.isFile()) throw new Error("skill resource is not a regular file");
    if (stat.size > MAX_SKILL_RESOURCE_BYTES) throw new Error(`skill resource exceeds ${MAX_SKILL_RESOURCE_BYTES} bytes`);
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) throw new Error("skill resource appears to be binary");
    const lines = bytes.toString("utf8").split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 200;
    if (!Number.isSafeInteger(offset) || offset < 1 || offset > Math.max(1, lines.length + 1)) {
      throw new Error("skill read offset is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SKILL_LINES) {
      throw new Error(`skill read limit must be an integer from 1 to ${MAX_SKILL_LINES}`);
    }
    const startIndex = offset - 1;
    const selected = lines.slice(startIndex, startIndex + limit);
    return Object.freeze({
      skill: skill.name,
      source: skill.source,
      path,
      startLine: selected.length > 0 ? offset : Math.min(offset, lines.length + 1),
      endLine: selected.length > 0 ? offset + selected.length - 1 : Math.min(offset - 1, lines.length),
      totalLines: lines.length,
      hasMore: startIndex + selected.length < lines.length,
      content: selected.map((line, index) => `${offset + index}: ${line}`).join("\n"),
    });
  }
}
