/**
 * @module conversation
 * Conversation record as saved on disk (version 1), its validation on load, its title, and its id.
 * Records read from disk are untrusted: `parseConversation` checks every field and keeps only known ones.
 */
import type { MentionResult } from "./mentions";
import type { ChatEntry, ReplyStatus } from "./protocol";
import type { ProviderError } from "./providerError";

/** A user entry as saved: `modelText` is the text the model received, typed text plus mention blocks. */
export type StoredUserEntry = ChatEntry & { role: "user" } & { modelText: string };
export type StoredEntry = StoredUserEntry | (ChatEntry & { role: "assistant" });

/**
 * One conversation. `provider` and `model`: last used to send in it, for information; reopening does not switch to
 * them. Times are milliseconds since the epoch. Never holds an API key or anything else of `ProviderAccess`.
 */
export type ConversationRecord = {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  entries: StoredEntry[];
};

/** A row of the history list. */
export type ConversationSummary = { id: string; title: string; updatedAt: number };

export type ParsedConversation = { ok: true; record: ConversationRecord } | { ok: false; reason: string };

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TITLE_LENGTH = 60;

/** Lowercase UUID. Ids name files, so only this shape is ever accepted as one. */
export function newConversationId(): string {
  return crypto.randomUUID();
}

export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function serializeConversation(record: ConversationRecord): string {
  return JSON.stringify(record);
}

/**
 * Validate a saved record. A reply still `waiting` or `streaming` was cut by a reload or crash -> `stopped`, so the
 * composer is usable. A user entry without `modelText` falls back to its typed text.
 */
export function parseConversation(text: string): ParsedConversation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  if (!isObject(value)) return { ok: false, reason: "not an object" };
  if (value.version !== 1) return { ok: false, reason: `unknown version ${JSON.stringify(value.version)}` };
  if (!isConversationId(value.id)) return { ok: false, reason: "invalid id" };
  if (!isTime(value.createdAt) || !isTime(value.updatedAt)) return { ok: false, reason: "invalid time" };
  if (!isOptional(value.provider, isString) || !isOptional(value.model, isString))
    return { ok: false, reason: "invalid provider or model" };
  if (!Array.isArray(value.entries)) return { ok: false, reason: "entries is not a list" };

  const entries: StoredEntry[] = [];
  for (const [index, raw] of value.entries.entries()) {
    const entry = parseEntry(raw);
    if (!entry) return { ok: false, reason: `invalid entry ${index}` };
    entries.push(entry);
  }
  const record: ConversationRecord = {
    version: 1,
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.provider !== undefined ? { provider: value.provider as string } : {}),
    ...(value.model !== undefined ? { model: value.model as string } : {}),
    entries,
  };
  return { ok: true, record };
}

/** First user message, whitespace collapsed, cut to 60 characters (code points) plus "…". */
export function conversationTitle(entries: readonly ChatEntry[]): string {
  const first = entries.find((entry) => entry.role === "user");
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  const characters = [...text];
  if (characters.length <= TITLE_LENGTH) return text;
  return `${characters.slice(0, TITLE_LENGTH).join("").trimEnd()}…`;
}

export function summarize(record: ConversationRecord): ConversationSummary {
  return { id: record.id, title: conversationTitle(record.entries), updatedAt: record.updatedAt };
}

/** Conversations kept per workspace. */
export const MAX_CONVERSATIONS = 50;

/** Ids to delete so at most 50 remain: the oldest by `updatedAt`, newest of them first, never `current`. */
export function conversationsOverLimit(summaries: readonly ConversationSummary[], current: string): string[] {
  const others = summaries.filter((summary) => summary.id !== current).sort((a, b) => b.updatedAt - a.updatedAt);
  const room = MAX_CONVERSATIONS - (others.length < summaries.length ? 1 : 0);
  return others.slice(room).map((summary) => summary.id);
}

const REPLY_STATUSES: readonly ReplyStatus[] = ["waiting", "streaming", "done", "stopped", "failed"];
const MENTION_KINDS: readonly string[] = ["file", "folder"];
const MENTION_STATUSES: readonly string[] = [
  "attached",
  "truncated",
  "missing",
  "outsideWorkspace",
  "binary",
  "tooLarge",
  "unreadable",
];

function parseEntry(raw: unknown): StoredEntry | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.role === "user") {
    if (!isString(raw.content) || !Array.isArray(raw.mentions) || !isOptional(raw.modelText, isString))
      return undefined;
    const mentions = raw.mentions.map(parseMention);
    if (mentions.some((mention) => mention === undefined)) return undefined;
    const modelText = (raw.modelText as string | undefined) ?? raw.content;
    return { role: "user", content: raw.content, mentions: mentions as MentionResult[], modelText };
  }
  if (raw.role === "assistant") {
    if (!isString(raw.reasoning) || !isString(raw.content)) return undefined;
    if (!REPLY_STATUSES.includes(raw.status as ReplyStatus)) return undefined;
    const error = raw.error === undefined ? undefined : parseProviderError(raw.error);
    if (raw.error !== undefined && !error) return undefined;
    const inFlight = raw.status === "waiting" || raw.status === "streaming";
    const status: ReplyStatus = inFlight ? "stopped" : (raw.status as ReplyStatus);
    return { role: "assistant", reasoning: raw.reasoning, content: raw.content, status, ...(error ? { error } : {}) };
  }
  return undefined;
}

function parseMention(raw: unknown): MentionResult | undefined {
  if (!isObject(raw) || !isString(raw.path)) return undefined;
  if (!MENTION_KINDS.includes(raw.kind as string) || !MENTION_STATUSES.includes(raw.status as string)) return undefined;
  if (!isOptional(raw.lines, (lines) => Number.isSafeInteger(lines) && (lines as number) >= 0)) return undefined;
  const { path, kind, status, lines } = raw as MentionResult;
  return { path, kind, status, ...(lines !== undefined ? { lines } : {}) };
}

/** Field types of each provider error kind; `?` marks an optional field, an array lists the allowed values. */
const ERROR_FIELDS: Record<ProviderError["kind"], Record<string, FieldType>> = {
  unreachable: { provider: "string", baseUrl: "string", cause: "string" },
  certificate: { provider: "string", baseUrl: "string", code: "string" },
  caFileInvalid: { provider: "string", path: "string", reason: ["relative", "unreadable", "notPem"], cause: "string?" },
  redirected: { provider: "string", status: "number", location: "string" },
  invalidKey: { provider: "string", status: "number" },
  rejected: { provider: "string", status: "number", detail: "string", bodyReadError: "string?" },
  cutOff: {
    provider: "string",
    reason: ["ended", "malformed", "dropped", "listDropped", "tooLarge", "listTooLarge", "providerError"],
    cause: "string?",
  },
  invalidResponse: { provider: "string", detail: "string", encoding: "string?" },
};

type FieldType = "string" | "string?" | "number" | readonly string[];

function parseProviderError(raw: unknown): ProviderError | undefined {
  if (!isObject(raw) || typeof raw.kind !== "string" || !Object.hasOwn(ERROR_FIELDS, raw.kind)) return undefined;
  const fields = ERROR_FIELDS[raw.kind as ProviderError["kind"]];
  const error: Record<string, unknown> = { kind: raw.kind };
  for (const [name, type] of Object.entries(fields)) {
    const value = raw[name];
    if (type === "string?" && value === undefined) continue;
    const valid =
      type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof type === "string"
          ? isString(value)
          : type.includes(value as string);
    if (!valid) return undefined;
    error[name] = value;
  }
  return error as ProviderError;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Largest time `Date` accepts, in milliseconds from the epoch. */
const MAX_TIME = 8.64e15;

/** Whole milliseconds from the epoch (not before) up to the last date `Date` can show. */
function isTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TIME;
}

function isOptional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}
