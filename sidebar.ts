// ─────────────────────────────────────────────────────────────────────────────
// Sidebar: a fixed-width right-column panel rendered by the terminal-split
// compositor. Shows three stacked sections from top to bottom:
//
//   1. Context-window usage (progress bar + percent)
//   2. Agent TODO list (parsed from any `*todo*` tool call carrying a
//      `todos: { content, status }[]` payload)
//   3. Subagent tracker (any tool whose name matches /task|subagent|agent/)
//
// The sidebar maintains its own scroll offset so long todo / subagent lists
// can be browsed without affecting chat scroll.
// ─────────────────────────────────────────────────────────────────────────────

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ansi } from "./colors.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface SidebarTodo {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

export type SubagentStatus = "running" | "done" | "error";

export interface SidebarSubagent {
  id: string;
  description: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt?: number;
  toolName: string;
  result?: string;
}

export interface SidebarConfig {
  enabled: boolean;
  width: number;
}

export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = {
  enabled: false,
  width: 32,
};

export const SIDEBAR_MIN_WIDTH = 20;
export const SIDEBAR_MAX_WIDTH = 60;

interface SidebarState {
  config: SidebarConfig;
  contextPercent: number;
  contextTokens: number;
  contextWindow: number;
  todos: SidebarTodo[];
  subagents: SidebarSubagent[];
  scrollOffset: number;
  changedAt: number;
}

const state: SidebarState = {
  config: { ...DEFAULT_SIDEBAR_CONFIG },
  contextPercent: 0,
  contextTokens: 0,
  contextWindow: 0,
  todos: [],
  subagents: [],
  scrollOffset: 0,
  changedAt: 0,
};

let changeListener: (() => void) | null = null;

function markDirty(): void {
  state.changedAt = Date.now();
  changeListener?.();
}

export function onSidebarChange(listener: () => void): void {
  changeListener = listener;
}

export function getSidebarConfig(): SidebarConfig {
  return state.config;
}

export function setSidebarConfig(next: Partial<SidebarConfig>): void {
  if (typeof next.enabled === "boolean") state.config.enabled = next.enabled;
  if (typeof next.width === "number" && Number.isFinite(next.width)) {
    state.config.width = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.floor(next.width)));
  }
  markDirty();
}

export function isSidebarEnabled(): boolean {
  return state.config.enabled;
}

export function getSidebarWidth(): number {
  return state.config.enabled ? state.config.width : 0;
}

export function setSidebarContextUsage(tokens: number, contextWindow: number, percent?: number): void {
  if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return;
  const pct = typeof percent === "number" && Number.isFinite(percent)
    ? percent
    : (tokens / contextWindow) * 100;
  if (
    state.contextTokens === tokens
    && state.contextWindow === contextWindow
    && Math.abs(state.contextPercent - pct) < 0.05
  ) {
    return;
  }
  state.contextTokens = tokens;
  state.contextWindow = contextWindow;
  state.contextPercent = pct;
  markDirty();
}

export function clearSidebarContextUsage(): void {
  if (state.contextTokens === 0 && state.contextWindow === 0) return;
  state.contextTokens = 0;
  state.contextWindow = 0;
  state.contextPercent = 0;
  markDirty();
}

// ─────────────────────────────────────────────────────────────────────────────
// Todo / subagent ingestion
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTodoStatus(value: unknown): TodoStatus {
  if (typeof value !== "string") return "pending";
  const lower = value.toLowerCase();
  if (lower === "in_progress" || lower === "in-progress" || lower === "active" || lower === "running") return "in_progress";
  if (lower === "completed" || lower === "done" || lower === "complete") return "completed";
  if (lower === "cancelled" || lower === "canceled" || lower === "skipped") return "cancelled";
  return "pending";
}

function parseTodos(input: unknown): SidebarTodo[] | null {
  if (!isRecord(input)) return null;
  const candidate = input.todos ?? input.items ?? input.list;
  if (!Array.isArray(candidate)) return null;

  const todos: SidebarTodo[] = [];
  for (const entry of candidate) {
    if (typeof entry === "string") {
      todos.push({ content: entry, status: "pending" });
      continue;
    }
    if (!isRecord(entry)) continue;
    const content = typeof entry.content === "string"
      ? entry.content
      : typeof entry.text === "string"
        ? entry.text
        : typeof entry.description === "string"
          ? entry.description
          : null;
    if (!content) continue;
    todos.push({
      content,
      status: normalizeTodoStatus(entry.status),
      activeForm: typeof entry.activeForm === "string" ? entry.activeForm : undefined,
    });
  }
  return todos;
}

/**
 * Returns `true` if the tool call carried a recognizable todo payload that we
 * applied to the sidebar.
 */
export function ingestSidebarToolCall(toolName: string, input: unknown): boolean {
  // Heuristic: any tool whose name contains "todo" with a todo-shaped payload.
  if (/todo/i.test(toolName)) {
    const todos = parseTodos(input);
    if (todos) {
      state.todos = todos;
      markDirty();
      return true;
    }
  }

  // Subagent / Task launches.
  if (/^(task|subagent|launch_agent|agent|spawn_agent)$/i.test(toolName)) {
    const desc = isRecord(input)
      ? (typeof input.description === "string" ? input.description
        : typeof input.prompt === "string" ? input.prompt
        : typeof input.task === "string" ? input.task
        : typeof input.subagent_type === "string" ? input.subagent_type
        : "")
      : "";
    const id = isRecord(input) && typeof input.id === "string"
      ? input.id
      : `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    state.subagents.unshift({
      id,
      description: desc || "subagent",
      status: "running",
      startedAt: Date.now(),
      toolName,
    });
    if (state.subagents.length > 20) state.subagents.length = 20;
    markDirty();
    return true;
  }

  return false;
}

export function ingestSidebarToolResult(toolName: string, _result: unknown, isError: boolean): boolean {
  if (!/^(task|subagent|launch_agent|agent|spawn_agent)$/i.test(toolName)) return false;
  // Mark the most recent matching running subagent finished.
  for (const sa of state.subagents) {
    if (sa.toolName === toolName && sa.status === "running") {
      sa.status = isError ? "error" : "done";
      sa.endedAt = Date.now();
      markDirty();
      return true;
    }
  }
  return false;
}

export function clearSidebarSubagents(): void {
  if (state.subagents.length === 0) return;
  state.subagents = [];
  markDirty();
}

export function clearSidebarTodos(): void {
  if (state.todos.length === 0) return;
  state.todos = [];
  markDirty();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrolling
// ─────────────────────────────────────────────────────────────────────────────

export function scrollSidebar(delta: number, viewportRows: number, totalLines: number): void {
  const maxOffset = Math.max(0, totalLines - viewportRows);
  const next = Math.max(0, Math.min(maxOffset, state.scrollOffset + delta));
  if (next === state.scrollOffset) return;
  state.scrollOffset = next;
  markDirty();
}

export function resetSidebarScroll(): void {
  if (state.scrollOffset === 0) return;
  state.scrollOffset = 0;
  markDirty();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const RESET = ansi.reset;
const BOLD = "\x1b[1m";

// Local palette so we don't depend on the narrower ColorName union in colors.ts.
const SIDEBAR_COLORS = {
  fg:      "\x1b[38;5;252m",
  muted:   "\x1b[38;5;245m",
  dim:     "\x1b[38;5;240m",
  accent:  ansi.getFgAnsi(0xfe, 0xbc, 0x38),
  success: ansi.getFgAnsi256(72),
  warning: ansi.getFgAnsi256(214),
  error:   ansi.getFgAnsi256(203),
} as const;
type SidebarColor = keyof typeof SIDEBAR_COLORS;

function fg(role: SidebarColor, text: string): string {
  return `${SIDEBAR_COLORS[role]}${text}${RESET}`;
}

function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  let role: "success" | "warning" | "error" = "success";
  if (clamped >= 90) role = "error";
  else if (clamped >= 70) role = "warning";
  return fg(role, "█".repeat(filled)) + fg("dim", "░".repeat(empty));
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function todoMarker(status: TodoStatus): string {
  switch (status) {
    case "completed": return fg("success", "✓");
    case "in_progress": return fg("accent", "▶");
    case "cancelled": return fg("dim", "✗");
    default: return fg("muted", "○");
  }
}

function subagentMarker(status: SubagentStatus): string {
  switch (status) {
    case "running": return fg("accent", "▶");
    case "error": return fg("error", "✗");
    default: return fg("success", "✓");
  }
}

function sectionHeader(title: string, innerWidth: number): string {
  const text = ` ${title} `;
  const remaining = Math.max(0, innerWidth - visibleWidth(text));
  return fg("accent", bold(text)) + fg("dim", "─".repeat(remaining));
}

function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (visibleWidth(word) > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      // Hard-truncate over-long single words.
      let remaining = word;
      while (visibleWidth(remaining) > width) {
        lines.push(truncateToWidth(remaining, width, "", true));
        remaining = remaining.slice(width);
      }
      current = remaining;
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function padRight(line: string, width: number): string {
  const w = visibleWidth(line);
  if (w >= width) return truncateToWidth(line, width, "…", true);
  return line + " ".repeat(width - w);
}

interface RenderOptions {
  /** Total rows the sidebar may occupy. */
  rows: number;
  /** Total width including border column (sidebar width). */
  width: number;
}

/**
 * Render the sidebar to an array of `rows` lines, each exactly `width`
 * cells wide (visible width). The first column is a vertical separator so
 * the sidebar reads as a proper panel.
 */
export function renderSidebarLines({ rows, width }: RenderOptions): string[] {
  if (rows <= 0 || width <= 0) return [];
  const innerWidth = Math.max(1, width - 2); // 1 cell border + 1 cell padding
  const border = fg("dim", "│");

  const allLines: string[] = [];

  // ── Section: context usage ────────────────────────────────────────────────
  allLines.push(sectionHeader("CONTEXT", innerWidth));
  const pct = state.contextPercent;
  const pctText = `${pct.toFixed(1)}%`;
  const tokenText = state.contextWindow > 0
    ? `${formatTokens(state.contextTokens)}/${formatTokens(state.contextWindow)}`
    : "—";
  // First line: bar + percent
  const barWidth = Math.max(4, innerWidth - pctText.length - 1);
  allLines.push(`${progressBar(pct, barWidth)} ${fg("fg", pctText)}`);
  allLines.push(fg("muted", tokenText));
  allLines.push("");

  // ── Section: todos ────────────────────────────────────────────────────────
  allLines.push(sectionHeader(`TODOS (${state.todos.length})`, innerWidth));
  if (state.todos.length === 0) {
    allLines.push(fg("dim", "no todos"));
  } else {
    for (const todo of state.todos) {
      const text = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
      const wrapped = wrapText(text, innerWidth - 2);
      const decorate = todo.status === "completed"
        ? (s: string) => fg("dim", s)
        : todo.status === "in_progress"
          ? (s: string) => bold(fg("fg", s))
          : (s: string) => fg("fg", s);
      wrapped.forEach((segment, idx) => {
        if (idx === 0) {
          allLines.push(`${todoMarker(todo.status)} ${decorate(segment)}`);
        } else {
          allLines.push(`  ${decorate(segment)}`);
        }
      });
    }
  }
  allLines.push("");

  // ── Section: subagents ────────────────────────────────────────────────────
  allLines.push(sectionHeader(`SUBAGENTS (${state.subagents.length})`, innerWidth));
  if (state.subagents.length === 0) {
    allLines.push(fg("dim", "none"));
  } else {
    for (const sa of state.subagents) {
      const elapsed = sa.endedAt
        ? Math.max(0, Math.round((sa.endedAt - sa.startedAt) / 1000))
        : Math.max(0, Math.round((Date.now() - sa.startedAt) / 1000));
      const tag = `${subagentMarker(sa.status)} ${fg("muted", `${elapsed}s`)}`;
      const wrapped = wrapText(sa.description, innerWidth - 2);
      wrapped.forEach((segment, idx) => {
        if (idx === 0) {
          allLines.push(`${tag} ${fg("fg", segment)}`);
        } else {
          allLines.push(`  ${fg("fg", segment)}`);
        }
      });
    }
  }

  // ── Apply scroll offset and pad to row count ──────────────────────────────
  const total = allLines.length;
  const maxOffset = Math.max(0, total - rows);
  if (state.scrollOffset > maxOffset) state.scrollOffset = maxOffset;
  const start = state.scrollOffset;
  const visible = allLines.slice(start, start + rows);
  while (visible.length < rows) visible.push("");

  return visible.map((line) => `${border} ${padRight(line, innerWidth)}`);
}

/** Returns total renderable line count (used for scroll clamping). */
export function getSidebarTotalLines(): number {
  // Cheap recompute: we always include 4 (context) + (1 header + max(1, todos))
  // + 1 spacer + (1 header + max(1, subagents)) lines, but todos/subagents may
  // wrap. We approximate with raw counts; the real renderer clamps scroll.
  return 4
    + 1 + Math.max(1, state.todos.length * 2)
    + 1
    + 1 + Math.max(1, state.subagents.length * 2);
}
