import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ChatWorkspaceRegistry } from "./workspaces";

const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_SESSION_ID_BYTES = 4 * 1024;
const MAX_DRIVER_ID_BYTES = 256;
const MAX_AGENTS = 128;
const MAX_TURNS = 512;
const MAX_WAIT_MS = 12_000;
const STOP_WAIT_MS = 2_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ChatAgentWriteMode = "read_only" | "workspace_write";
export type ChatAgentStatus = "running" | "idle" | "failed" | "stopped" | "unknown";
export type ChatAgentTurnStatus = "running" | "completed" | "failed" | "stopped" | "unknown";

export interface ChatAgentRunInput {
  readonly prompt: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly providerSessionId?: string;
  readonly writeMode: ChatAgentWriteMode;
}

export interface ChatAgentRunCallbacks {
  readonly onSessionId: (providerSessionId: string) => void | Promise<void>;
}

export interface ChatAgentRunResult {
  readonly response: string;
  readonly providerSessionId?: string;
}

export interface ChatAgentDriver {
  readonly id: string;
  readonly description?: string;
  run(input: ChatAgentRunInput, callbacks: ChatAgentRunCallbacks, signal: AbortSignal): Promise<ChatAgentRunResult>;
}

interface DurableAgent {
  readonly id: string;
  readonly workspaceId: string;
  readonly driverId: string;
  readonly status: ChatAgentStatus;
  readonly providerSessionId?: string | undefined;
  readonly latestResponse?: string | undefined;
  readonly latestErrorCode?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DurableAgentTurn {
  readonly id: string;
  readonly agentId: string;
  readonly status: ChatAgentTurnStatus;
  readonly response?: string;
  readonly errorCode?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string;
}

interface AgentStore {
  readonly version: 1;
  readonly agents: readonly DurableAgent[];
  readonly turns: readonly DurableAgentTurn[];
}

interface ActiveTurn {
  readonly turnId: string;
  readonly controller: AbortController;
  completion: Promise<void>;
  retired: boolean;
}

export interface ChatAgentTargetSummary {
  readonly id: string;
  readonly description?: string;
}

export interface ChatAgentSummary {
  readonly id: string;
  readonly target: string;
  readonly status: ChatAgentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ChatAgentObservation =
  | (ChatAgentSummary & { readonly status: "running"; readonly wait?: "timeout" })
  | (ChatAgentSummary & { readonly status: "idle"; readonly response?: string })
  | (ChatAgentSummary & { readonly status: "failed"; readonly error: { readonly code: string } })
  | (ChatAgentSummary & { readonly status: "stopped" })
  | (ChatAgentSummary & { readonly status: "unknown" });

function singleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || /[\u0000\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function boundedSingleLine(value: unknown, field: string, maximumBytes: number): string {
  const parsed = singleLine(value, field);
  if (Buffer.byteLength(parsed, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  return parsed;
}

function boundedMultiline(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string" || !value || value.includes("\u0000")) throw new Error(`${field} is invalid`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} bytes`);
  return value;
}

function writeMode(value: unknown): ChatAgentWriteMode {
  if (value === undefined || value === "read_only") return "read_only";
  if (value === "workspace_write") return "workspace_write";
  throw new Error("agent write mode must be read_only or workspace_write");
}

function status(value: unknown, field: string): ChatAgentStatus {
  if (!(value === "running" || value === "idle" || value === "failed" || value === "stopped" || value === "unknown")) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function turnStatus(value: unknown, field: string): ChatAgentTurnStatus {
  if (!(value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "unknown")) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : singleLine(value, field);
}

function timestamp(value: unknown, field: string): string {
  const parsed = singleLine(value, field);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${field} is invalid`);
  return parsed;
}

function parseStore(value: unknown): AgentStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tela Chat agent store must be an object");
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.agents) || !Array.isArray(root.turns)) {
    throw new Error("Tela Chat agent store version is invalid");
  }
  const agents = root.agents.map((entry, index): DurableAgent => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`agent[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    return Object.freeze({
      id: singleLine(item.id, `agent[${index}].id`),
      workspaceId: singleLine(item.workspaceId, `agent[${index}].workspaceId`),
      driverId: boundedSingleLine(item.driverId, `agent[${index}].driverId`, MAX_DRIVER_ID_BYTES),
      status: status(item.status, `agent[${index}].status`),
      ...(item.providerSessionId === undefined ? {} : { providerSessionId: boundedSingleLine(item.providerSessionId, `agent[${index}].providerSessionId`, MAX_SESSION_ID_BYTES) }),
      ...(item.latestResponse === undefined ? {} : { latestResponse: boundedMultiline(item.latestResponse, `agent[${index}].latestResponse`, MAX_RESPONSE_BYTES) }),
      ...(item.latestErrorCode === undefined ? {} : { latestErrorCode: singleLine(item.latestErrorCode, `agent[${index}].latestErrorCode`) }),
      createdAt: timestamp(item.createdAt, `agent[${index}].createdAt`),
      updatedAt: timestamp(item.updatedAt, `agent[${index}].updatedAt`),
    });
  });
  const turns = root.turns.map((entry, index): DurableAgentTurn => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`agent turn[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    return Object.freeze({
      id: singleLine(item.id, `agent turn[${index}].id`),
      agentId: singleLine(item.agentId, `agent turn[${index}].agentId`),
      status: turnStatus(item.status, `agent turn[${index}].status`),
      ...(item.response === undefined ? {} : { response: boundedMultiline(item.response, `agent turn[${index}].response`, MAX_RESPONSE_BYTES) }),
      ...(item.errorCode === undefined ? {} : { errorCode: singleLine(item.errorCode, `agent turn[${index}].errorCode`) }),
      startedAt: timestamp(item.startedAt, `agent turn[${index}].startedAt`),
      updatedAt: timestamp(item.updatedAt, `agent turn[${index}].updatedAt`),
      ...(item.endedAt === undefined ? {} : { endedAt: timestamp(item.endedAt, `agent turn[${index}].endedAt`) }),
    });
  });
  const agentIds = new Set<string>();
  for (const agent of agents) {
    if (agentIds.has(agent.id)) throw new Error(`duplicate Tela Chat agent id: ${agent.id}`);
    agentIds.add(agent.id);
  }
  const turnIds = new Set<string>();
  for (const turn of turns) {
    if (!agentIds.has(turn.agentId)) throw new Error(`agent turn references unknown agent: ${turn.id}`);
    if (turnIds.has(turn.id)) throw new Error(`duplicate Tela Chat agent turn id: ${turn.id}`);
    turnIds.add(turn.id);
  }
  return Object.freeze({ version: 1, agents: Object.freeze(agents), turns: Object.freeze(turns) });
}

function summary(agent: DurableAgent): ChatAgentSummary {
  return Object.freeze({
    id: agent.id,
    target: agent.driverId,
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  });
}

function observation(agent: DurableAgent, timedOut = false): ChatAgentObservation {
  const base = summary(agent);
  switch (agent.status) {
    case "running": return Object.freeze({ ...base, status: "running" as const, ...(timedOut ? { wait: "timeout" as const } : {}) });
    case "idle": return Object.freeze({ ...base, status: "idle" as const,
      ...(agent.latestResponse === undefined ? {} : { response: agent.latestResponse }) });
    case "failed": return Object.freeze({ ...base, status: "failed" as const,
      error: Object.freeze({ code: agent.latestErrorCode ?? "agent_driver_failed" }) });
    case "stopped": return Object.freeze({ ...base, status: "stopped" as const });
    case "unknown": return Object.freeze({ ...base, status: "unknown" as const });
  }
}

function waitTimeout(value: number | undefined): number {
  const parsed = value ?? MAX_WAIT_MS;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_WAIT_MS) {
    throw new Error(`agent wait timeout must be an integer from 0 to ${MAX_WAIT_MS}`);
  }
  return parsed;
}

async function boundedWait(promises: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return false;
  if (timeoutMs === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">(resolvePromise => { timer = setTimeout(() => resolvePromise("timeout"), timeoutMs); });
  const completed = Promise.allSettled(promises).then(() => "completed" as const);
  const result = await Promise.race([timeout, completed]);
  if (timer) clearTimeout(timer);
  return result === "timeout";
}

export class ChatAgentManager {
  readonly #workspaces: ChatWorkspaceRegistry;
  readonly #storePath: string;
  readonly #drivers = new Map<string, ChatAgentDriver>();
  readonly #agents = new Map<string, DurableAgent>();
  readonly #turns = new Map<string, DurableAgentTurn>();
  readonly #active = new Map<string, ActiveTurn>();
  #closed = false;

  constructor(input: {
    readonly workspaces: ChatWorkspaceRegistry;
    readonly storePath: string;
    readonly drivers: readonly ChatAgentDriver[];
  }) {
    this.#workspaces = input.workspaces;
    this.#storePath = resolve(input.storePath);
    for (const driver of input.drivers) {
      const id = boundedSingleLine(driver.id, "agent driver id", MAX_DRIVER_ID_BYTES);
      if (this.#drivers.has(id)) throw new Error(`duplicate Tela Chat agent driver: ${id}`);
      this.#drivers.set(id, driver);
    }
    if (existsSync(this.#storePath)) {
      const store = parseStore(JSON.parse(readFileSync(this.#storePath, "utf8")) as unknown);
      const now = new Date().toISOString();
      for (const stored of store.agents) {
        this.#agents.set(stored.id, stored.status === "running"
          ? Object.freeze({ ...stored, status: "unknown" as const, updatedAt: now })
          : stored);
      }
      for (const stored of store.turns) {
        this.#turns.set(stored.id, stored.status === "running"
          ? Object.freeze({ ...stored, status: "unknown" as const, updatedAt: now, endedAt: now })
          : stored);
      }
      this.#prune();
      this.#save();
    }
  }

  get targetCount(): number { return this.#drivers.size; }

  targets(): readonly ChatAgentTargetSummary[] {
    return Object.freeze([...this.#drivers.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(driver => Object.freeze({ id: driver.id, ...(driver.description ? { description: driver.description } : {}) })));
  }

  #save(): void {
    mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#storePath}.tmp-${process.pid}`;
    const store: AgentStore = { version: 1,
      agents: Object.freeze([...this.#agents.values()]), turns: Object.freeze([...this.#turns.values()]) };
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Windows ACLs own permissions there. */ }
    renameSync(temporary, this.#storePath);
  }

  #prune(): void {
    const threshold = Date.now() - TERMINAL_RETENTION_MS;
    const terminalAgents = [...this.#agents.values()]
      .filter(agent => agent.status !== "running")
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const agent of terminalAgents) {
      if (this.#agents.size <= MAX_AGENTS && Date.parse(agent.updatedAt) > threshold) break;
      this.#agents.delete(agent.id);
      for (const [turnId, turn] of this.#turns) if (turn.agentId === agent.id) this.#turns.delete(turnId);
    }
    const turns = [...this.#turns.values()].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const turn of turns) {
      if (this.#turns.size <= MAX_TURNS && Date.parse(turn.updatedAt) > threshold) break;
      if (turn.status === "running") continue;
      this.#turns.delete(turn.id);
    }
  }

  #reserveAgentCapacity(): void {
    this.#prune();
    if (this.#agents.size < MAX_AGENTS) return;
    const removable = [...this.#agents.values()]
      .filter(agent => agent.status !== "running")
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (this.#agents.size >= MAX_AGENTS && removable.length > 0) {
      const agent = removable.shift()!;
      this.#agents.delete(agent.id);
      for (const [turnId, turn] of this.#turns) if (turn.agentId === agent.id) this.#turns.delete(turnId);
    }
  }

  #reserveTurnCapacity(): void {
    this.#prune();
    if (this.#turns.size < MAX_TURNS) return;
    const removable = [...this.#turns.values()]
      .filter(turn => turn.status !== "running")
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (this.#turns.size >= MAX_TURNS && removable.length > 0) this.#turns.delete(removable.shift()!.id);
  }

  #agent(workspaceId: string, agentId: string): DurableAgent {
    this.#workspaces.get(workspaceId);
    const agent = this.#agents.get(singleLine(agentId, "agent id"));
    if (!agent || agent.workspaceId !== workspaceId) throw new Error(`unknown Tela Chat agent for workspace ${workspaceId}: ${agentId}`);
    return agent;
  }

  #updateAgent(agentId: string, update: Partial<DurableAgent>): DurableAgent {
    const previous = this.#agents.get(agentId);
    if (!previous) throw new Error(`unknown Tela Chat agent: ${agentId}`);
    const next = Object.freeze({ ...previous, ...update, id: previous.id, workspaceId: previous.workspaceId,
      driverId: previous.driverId, createdAt: previous.createdAt, updatedAt: update.updatedAt ?? new Date().toISOString() });
    this.#agents.set(agentId, next);
    this.#save();
    return next;
  }

  #updateTurn(turnId: string, update: Partial<DurableAgentTurn>): DurableAgentTurn {
    const previous = this.#turns.get(turnId);
    if (!previous) throw new Error(`unknown Tela Chat agent turn: ${turnId}`);
    const next = Object.freeze({ ...previous, ...update, id: previous.id, agentId: previous.agentId,
      startedAt: previous.startedAt, updatedAt: update.updatedAt ?? new Date().toISOString() });
    this.#turns.set(turnId, next);
    this.#save();
    return next;
  }

  async start(input: {
    readonly workspaceId: string;
    readonly target: string;
    readonly prompt: string;
    readonly writeMode?: ChatAgentWriteMode;
  }): Promise<ChatAgentSummary> {
    if (this.#closed) throw new Error("Tela Chat agent manager is closed");
    const workspace = this.#workspaces.get(input.workspaceId);
    const target = singleLine(input.target, "agent target");
    const driver = this.#drivers.get(target);
    if (!driver) throw new Error(`unknown or unavailable Tela Chat agent target: ${target}`);
    const prompt = boundedMultiline(input.prompt, "agent prompt", MAX_PROMPT_BYTES);
    this.#reserveAgentCapacity();
    if (this.#agents.size >= MAX_AGENTS) throw new Error("Tela Chat agent registry is at capacity");
    const now = new Date().toISOString();
    const agent: DurableAgent = Object.freeze({
      id: `chatagent_${randomUUID()}`,
      workspaceId: workspace.id,
      driverId: driver.id,
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    this.#agents.set(agent.id, agent);
    try {
      this.#begin(agent, prompt, writeMode(input.writeMode), workspace.root);
      return summary(this.#agents.get(agent.id)!);
    } catch (error) {
      this.#agents.delete(agent.id);
      throw error;
    }
  }

  async continue(input: {
    readonly workspaceId: string;
    readonly agentId: string;
    readonly prompt: string;
    readonly writeMode?: ChatAgentWriteMode;
  }): Promise<ChatAgentSummary> {
    if (this.#closed) throw new Error("Tela Chat agent manager is closed");
    const workspace = this.#workspaces.get(input.workspaceId);
    const agent = this.#agent(workspace.id, input.agentId);
    if (agent.status === "running") throw new Error("Tela Chat agent already has a running turn");
    if (agent.status === "stopped") throw new Error("stopped Tela Chat agent cannot be continued");
    if (agent.status === "unknown") throw new Error("Tela Chat agent continuation is unavailable after an unproven interrupted turn");
    if (agent.status === "failed" && !agent.providerSessionId) {
      throw new Error("failed Tela Chat agent has no proven provider continuation identity");
    }
    if (!this.#drivers.has(agent.driverId)) throw new Error(`Tela Chat agent target is unavailable: ${agent.driverId}`);
    const prompt = boundedMultiline(input.prompt, "agent prompt", MAX_PROMPT_BYTES);
    const running = Object.freeze({ ...agent, status: "running" as const,
      latestResponse: undefined, latestErrorCode: undefined, updatedAt: new Date().toISOString() });
    this.#agents.set(agent.id, running);
    try {
      this.#begin(running, prompt, writeMode(input.writeMode), workspace.root);
      return summary(this.#agents.get(agent.id)!);
    } catch (error) {
      this.#agents.set(agent.id, agent);
      throw error;
    }
  }

  #begin(agent: DurableAgent, prompt: string, mode: ChatAgentWriteMode, workspaceRoot: string): void {
    const driver = this.#drivers.get(agent.driverId);
    if (!driver) throw new Error(`Tela Chat agent target is unavailable: ${agent.driverId}`);
    if (this.#active.has(agent.id)) throw new Error("Tela Chat agent already has an active turn");
    this.#reserveTurnCapacity();
    if (this.#turns.size >= MAX_TURNS) throw new Error("Tela Chat agent turn registry is at capacity");
    const now = new Date().toISOString();
    const turn: DurableAgentTurn = Object.freeze({
      id: `chatturn_${randomUUID()}`,
      agentId: agent.id,
      status: "running",
      startedAt: now,
      updatedAt: now,
    });
    this.#turns.set(turn.id, turn);
    try {
      this.#save();
    } catch (error) {
      this.#turns.delete(turn.id);
      throw error;
    }
    const controller = new AbortController();
    const active: ActiveTurn = { turnId: turn.id, controller, completion: Promise.resolve(), retired: false };
    const completion = (async () => {
      try {
        const result = await driver.run({
          prompt,
          workspaceId: agent.workspaceId,
          workspaceRoot,
          ...(agent.providerSessionId ? { providerSessionId: agent.providerSessionId } : {}),
          writeMode: mode,
        }, {
          onSessionId: async providerSessionId => {
            if (active.retired || controller.signal.aborted) return;
            const sessionId = boundedSingleLine(providerSessionId, "agent provider session id", MAX_SESSION_ID_BYTES);
            const current = this.#agents.get(agent.id);
            if (!current || current.status !== "running") return;
            if (current.providerSessionId && current.providerSessionId !== sessionId) {
              throw new Error("agent provider continuation identity changed during one turn");
            }
            this.#updateAgent(agent.id, { providerSessionId: sessionId });
          },
        }, controller.signal);
        if (active.retired) return;
        if (controller.signal.aborted) throw new DOMException("agent turn was stopped", "AbortError");
        const response = boundedMultiline(result.response, "agent response", MAX_RESPONSE_BYTES);
        let providerSessionId = result.providerSessionId;
        if (providerSessionId !== undefined) {
          providerSessionId = boundedSingleLine(providerSessionId, "agent provider session id", MAX_SESSION_ID_BYTES);
        }
        const current = this.#agents.get(agent.id);
        if (!current || current.status !== "running") return;
        if (providerSessionId && current.providerSessionId && providerSessionId !== current.providerSessionId) {
          throw new Error("agent provider returned a different continuation identity than it announced");
        }
        const endedAt = new Date().toISOString();
        this.#updateTurn(turn.id, { status: "completed", response, endedAt });
        this.#updateAgent(agent.id, { status: "idle", latestResponse: response, latestErrorCode: undefined,
          ...(providerSessionId ? { providerSessionId } : {}) });
      } catch (error) {
        if (active.retired) return;
        const endedAt = new Date().toISOString();
        const aborted = controller.signal.aborted;
        this.#updateTurn(turn.id, aborted
          ? { status: "stopped", errorCode: "agent_stop_requested", endedAt }
          : { status: "failed", errorCode: "agent_driver_failed", endedAt });
        this.#updateAgent(agent.id, aborted
          ? { status: "stopped", latestResponse: undefined, latestErrorCode: undefined }
          : { status: "failed", latestResponse: undefined, latestErrorCode: "agent_driver_failed" });
      } finally {
        if (this.#active.get(agent.id) === active) this.#active.delete(agent.id);
      }
    })();
    active.completion = completion;
    this.#active.set(agent.id, active);
  }

  get(workspaceId: string, agentId: string): ChatAgentObservation {
    return observation(this.#agent(workspaceId, agentId));
  }

  list(workspaceId: string): readonly ChatAgentSummary[] {
    this.#workspaces.get(workspaceId);
    return Object.freeze([...this.#agents.values()]
      .filter(agent => agent.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(summary));
  }

  async wait(input: {
    readonly workspaceId: string;
    readonly agentIds: readonly string[];
    readonly timeoutMs?: number;
  }): Promise<readonly ChatAgentObservation[]> {
    this.#workspaces.get(input.workspaceId);
    if (!Array.isArray(input.agentIds) || input.agentIds.length < 1 || input.agentIds.length > 32) {
      throw new Error("agent wait requires 1 to 32 agent ids");
    }
    const ids = [...new Set(input.agentIds.map(id => singleLine(id, "agent id")))];
    const agents = ids.map(id => this.#agent(input.workspaceId, id));
    const pending = agents.map(agent => this.#active.get(agent.id)?.completion).filter((value): value is Promise<void> => value !== undefined);
    const timedOut = await boundedWait(pending, waitTimeout(input.timeoutMs));
    return Object.freeze(ids.map(id => observation(this.#agent(input.workspaceId, id), timedOut)));
  }

  async stop(workspaceId: string, agentId: string): Promise<ChatAgentObservation> {
    const agent = this.#agent(workspaceId, agentId);
    const active = this.#active.get(agent.id);
    if (!active) return observation(agent);
    active.controller.abort();
    await boundedWait([active.completion], STOP_WAIT_MS);
    return observation(this.#agent(workspaceId, agentId));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = [...this.#active.entries()];
    for (const [, turn] of active) turn.controller.abort();
    const timedOut = await boundedWait(active.map(([, turn]) => turn.completion), STOP_WAIT_MS);
    if (timedOut) {
      const now = new Date().toISOString();
      for (const [agentId, turn] of active) {
        if (this.#active.get(agentId) !== turn) continue;
        turn.retired = true;
        this.#active.delete(agentId);
        this.#updateTurn(turn.turnId, { status: "unknown", errorCode: "agent_shutdown_interrupted", endedAt: now });
        this.#updateAgent(agentId, { status: "unknown", latestResponse: undefined, latestErrorCode: "agent_shutdown_interrupted" });
      }
    }
  }
}
