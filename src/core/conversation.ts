/**
 * @module conversation
 * Conversation record as saved on disk (version 2), its validation on load, its title, its id, and its summary: the
 * history row saved beside the record, so a valid summary spares the list parsing the record. Files read from disk are
 * untrusted: `parseConversation` and `parseSummary` check every field and keep only known ones.
 */
import type { LineRange, MentionResult, MentionStatus } from "./mentions";
import type {
  ChatEntry,
  HaltReason,
  ReplyCall,
  ReplyStatus,
  StepApproval,
  ToolStepStatus,
  UserSkill,
} from "./protocol";
import type { ProviderError } from "./providerError";
import { type MentionKind, NOTHING_TO_ATTACH, RESERVED_FAILURES, RESERVED_MENTIONS } from "./reservedMentions";

/**
 * A user entry as saved: `modelText` is the text the model received, typed text (or the text of the skill it loads)
 * plus mention blocks.
 */
export type StoredUserEntry = ChatEntry & { role: "user" } & { modelText: string };
export type StoredEntry = StoredUserEntry | Exclude<ChatEntry, { role: "user" }>;

/**
 * The record version this build writes and reads. Version 2 added tool steps, a reply's `call`, and halted replies.
 * Version 1 files are skipped like any other version: no release ever wrote them, so none is migrated. An optional
 * field added to an entry, such as a user entry's `skill`, keeps the version: an older build drops the unknown key and
 * reads the rest. A new value of an existing field, such as the `problems` mention kind, keeps it too, at a cost: an
 * older build skips such a record as invalid and keeps it on disk.
 */
export const CONVERSATION_VERSION = 2;

/**
 * One conversation. `provider` and `model`: last used to send in it, for information; reopening does not switch to
 * them. Times are milliseconds since the epoch. Never holds an API key or anything else of `ProviderAccess`.
 */
export type ConversationRecord = {
  version: typeof CONVERSATION_VERSION;
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
 * composer is usable. A user entry without `modelText` makes the record invalid.
 */
export function parseConversation(text: string): ParsedConversation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${String(error)}` };
  }
  if (!isObject(value)) return { ok: false, reason: "not an object" };
  if (value.version !== CONVERSATION_VERSION) {
    return { ok: false, reason: `unknown version ${JSON.stringify(value.version)}` };
  }
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
    version: CONVERSATION_VERSION,
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

/**
 * The History filter: rows whose title contains `query`, trimmed, ignoring case, in the order given; every row for a
 * blank query. Compared as the `@` and `/` menus do: lowercase on both sides, no accent folding. Only the title is
 * searched, so a title cut to 60 characters matches on that part only.
 */
export function filterConversations(conversations: ConversationSummary[], query: string): ConversationSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return conversations;
  return conversations.filter((conversation) => conversation.title.toLowerCase().includes(needle));
}

/** Summary file of `record`: its row under `version`, the version of the record it describes. */
export function serializeSummary(record: ConversationRecord): string {
  return JSON.stringify({ version: record.version, ...summarize(record) });
}

/**
 * The row a summary file holds; `undefined` when invalid or when it describes a record of another version than this
 * build reads, so the caller parses the record, which then reports its own problem.
 */
export function parseSummary(text: string): ConversationSummary | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value.version !== CONVERSATION_VERSION || !isConversationId(value.id)) return undefined;
  if (!isString(value.title) || !isTime(value.updatedAt)) return undefined;
  return { id: value.id, title: value.title, updatedAt: value.updatedAt };
}

/** Conversations kept per workspace. */
export const MAX_CONVERSATIONS = 50;

/** Ids to delete so at most 50 remain: the oldest by `updatedAt`, oldest first, never one of `keep`. */
export function conversationsOverLimit(summaries: readonly ConversationSummary[], keep: readonly string[]): string[] {
  const others = summaries.filter((summary) => !keep.includes(summary.id)).sort((a, b) => a.updatedAt - b.updatedAt);
  const excess = summaries.length - MAX_CONVERSATIONS;
  return others.slice(0, Math.max(excess, 0)).map((summary) => summary.id);
}

const REPLY_STATUSES: readonly ReplyStatus[] = ["waiting", "streaming", "done", "stopped", "failed", "halted"];
const HALT_REASONS: readonly HaltReason[] = ["malformedCalls", "stepLimit", "contextFull"];
const TOOL_STEP_STATUSES: readonly ToolStepStatus[] = ["ok", "error", "malformed"];
const STEP_APPROVALS: readonly StepApproval[] = ["accepted", "rejected", "auto"];
const MENTION_KINDS: readonly MentionKind[] = ["file", "folder", ...RESERVED_MENTIONS];
const USER_SKILL_STATUSES: readonly string[] = ["loaded", "failed"];
const MENTION_STATUSES: readonly MentionStatus[] = [
  "attached",
  "truncated",
  "missing",
  "outsideWorkspace",
  "binary",
  "tooLarge",
  "unreadable",
  ...NOTHING_TO_ATTACH,
  ...RESERVED_FAILURES,
];

function parseEntry(raw: unknown): StoredEntry | undefined {
  if (!isObject(raw)) return undefined;
  if (raw.role === "user") {
    if (!isString(raw.content) || !Array.isArray(raw.mentions) || !isString(raw.modelText)) return undefined;
    const mentions = raw.mentions.map(parseMention);
    if (mentions.some((mention) => mention === undefined)) return undefined;
    const skill = raw.skill === undefined ? undefined : parseUserSkill(raw.skill);
    if (raw.skill !== undefined && !skill) return undefined;
    return {
      role: "user",
      content: raw.content,
      mentions: mentions as MentionResult[],
      ...(skill ? { skill } : {}),
      modelText: raw.modelText,
    };
  }
  if (raw.role === "assistant") {
    if (!isString(raw.reasoning) || !isString(raw.content)) return undefined;
    if (!REPLY_STATUSES.includes(raw.status as ReplyStatus)) return undefined;
    const error = raw.error === undefined ? undefined : parseProviderError(raw.error);
    if (raw.error !== undefined && !error) return undefined;
    const call = raw.call === undefined ? undefined : parseCall(raw.call, raw.content.length);
    if (raw.call !== undefined && !call) return undefined;
    const halted = raw.status === "halted";
    if (halted !== HALT_REASONS.includes(raw.haltReason as HaltReason)) return undefined;
    if (!halted && raw.haltReason !== undefined) return undefined;
    // [>]: Cut by a reload or crash, a call that was running included: its step never came, so the turn stopped there.
    const inFlight = raw.status === "waiting" || raw.status === "streaming";
    const status: ReplyStatus = inFlight ? "stopped" : (raw.status as ReplyStatus);
    return {
      role: "assistant",
      reasoning: raw.reasoning,
      content: raw.content,
      status,
      ...(error ? { error } : {}),
      ...(call ? { call } : {}),
      ...(halted ? { haltReason: raw.haltReason as HaltReason } : {}),
    };
  }
  if (raw.role === "tool") {
    if (!isString(raw.name) || !isString(raw.text) || !isStringRecord(raw.args)) return undefined;
    if (!TOOL_STEP_STATUSES.includes(raw.status as ToolStepStatus)) return undefined;
    if (raw.approval !== undefined && !STEP_APPROVALS.includes(raw.approval as StepApproval)) return undefined;
    const status = raw.status as ToolStepStatus;
    const approval = raw.approval as StepApproval | undefined;
    return {
      role: "tool",
      name: raw.name,
      args: { ...raw.args },
      status,
      text: raw.text,
      ...(approval !== undefined ? { approval } : {}),
    };
  }
  return undefined;
}

/** A reply's call, its range inside an answer of `length` code units. */
function parseCall(raw: unknown, length: number): ReplyCall | undefined {
  if (!isObject(raw) || !isString(raw.name) || !isStringRecord(raw.args)) return undefined;
  const { start, end } = raw;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
  if ((start as number) < 0 || (start as number) > (end as number) || (end as number) > length) return undefined;
  return { name: raw.name, args: { ...raw.args }, start: start as number, end: end as number };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(isString);
}

function parseUserSkill(raw: unknown): UserSkill | undefined {
  if (!isObject(raw) || !isString(raw.name) || !USER_SKILL_STATUSES.includes(raw.status as string)) return undefined;
  return { name: raw.name, status: raw.status as UserSkill["status"] };
}

function parseMention(raw: unknown): MentionResult | undefined {
  if (!isObject(raw) || !isString(raw.path)) return undefined;
  if (!MENTION_KINDS.includes(raw.kind as MentionKind) || !MENTION_STATUSES.includes(raw.status as MentionStatus))
    return undefined;
  if (!isOptional(raw.lines, (lines) => Number.isSafeInteger(lines) && (lines as number) >= 0)) return undefined;
  if (!isOptional(raw.range, isLineRange)) return undefined;
  if (!isOptional(raw.failedFolders, (count) => Number.isSafeInteger(count) && (count as number) >= 1))
    return undefined;
  const { path, kind, status, lines, range, failedFolders } = raw as MentionResult;
  return {
    path,
    kind,
    status,
    ...(lines !== undefined ? { lines } : {}),
    ...(range !== undefined ? { range: { path: range.path, start: range.start, end: range.end } } : {}),
    ...(failedFolders !== undefined ? { failedFolders } : {}),
  };
}

/** A path and 1-based lines, the first not after the last. */
function isLineRange(raw: unknown): raw is LineRange {
  if (!isObject(raw) || !isString(raw.path)) return false;
  const { start, end } = raw;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    (start as number) >= 1 &&
    (start as number) <= (end as number)
  );
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
  internal: { message: "string" },
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
