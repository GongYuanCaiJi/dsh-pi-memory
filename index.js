/**
 * Memory Plugin with QMD-Powered Search — dsh port of pi-memory 0.4.2.
 *
 * Plain-Markdown memory system with semantic search via qmd.
 * Core memory tools (write/read/scratchpad) work without qmd installed.
 * The memory_search tool requires qmd for keyword, semantic, and hybrid search.
 *
 * Layout (under $DSH_HOME/agent/memory/):
 *   MEMORY.md              — curated long-term memory (decisions, preferences, durable facts)
 *   SCRATCHPAD.md           — checklist of things to keep in mind / fix later
 *   daily/YYYY-MM-DD.md    — daily append-only log (today + yesterday loaded at session start)
 *   recovery/*.json        — durable records for restoring memory_forget deletions
 *
 * Tools:
 *   memory_write   — write to MEMORY.md or daily log
 *   memory_forget  — delete matching memory entries and create a recovery record
 *   memory_restore — restore entries from a memory_forget recovery record
 *   memory_read    — read any memory file or list daily logs
 *   scratchpad     — add/check/uncheck/clear items on the scratchpad checklist
 *   memory_search  — search across all memory files via qmd (keyword, semantic, or deep)
 *   memory_status  — health check: files, qmd, collection, embeddings, active configuration
 *
 * Context injection:
 *   - MEMORY.md + SCRATCHPAD.md + today's + yesterday's daily logs injected into every turn
 *
 * This is a port of https://github.com/jayzeng/pi-memory (MIT). The port
 * adapts the Pi extension entry to the dsh plugin contract (name/inject/
 * Config/apply) and rewires Pi lifecycle events to their dsh equivalents.
 * Every adaptation is listed in the delivery report of porting ticket #18.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Paths (mutable for testing via _setBaseDir / _resetBaseDir)
// ---------------------------------------------------------------------------

/**
 * @typedef {Record<string, string | undefined>} MemoryEnv
 * Partial env snapshot for path resolution and tests.
 */

/**
 * Memory root lives under the DeepSeek Harness home (like Pi's ~/.pi/agent),
 * not under Pi's directory. `PI_MEMORY_DIR` still overrides it (upstream env
 * contract is preserved); `DSH_HOME` defaults to `~/.dsh` (dsh convention).
 */
export function resolveMemoryDir(env = process.env) {
	if (env.PI_MEMORY_DIR) return env.PI_MEMORY_DIR;
	const dshHome =
		env.DSH_HOME ??
		(env.HOME && path.join(env.HOME, ".dsh")) ??
		(env.USERPROFILE && path.join(env.USERPROFILE, ".dsh")) ??
		(env.HOMEDRIVE && env.HOMEPATH ? path.join(`${env.HOMEDRIVE}${env.HOMEPATH}`, ".dsh") : undefined) ??
		path.join(os.homedir() || "~", ".dsh");
	return path.join(dshHome, "agent", "memory");
}

let MEMORY_DIR = resolveMemoryDir();
let MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
let SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
let DAILY_DIR = path.join(MEMORY_DIR, "daily");
let RECOVERY_DIR = path.join(MEMORY_DIR, "recovery");

/** Override base directory (for testing). */
export function _setBaseDir(baseDir) {
	MEMORY_DIR = baseDir;
	MEMORY_FILE = path.join(baseDir, "MEMORY.md");
	SCRATCHPAD_FILE = path.join(baseDir, "SCRATCHPAD.md");
	DAILY_DIR = path.join(baseDir, "daily");
	RECOVERY_DIR = path.join(baseDir, "recovery");
}

/** Reset to default paths (for testing). */
export function _resetBaseDir() {
	_setBaseDir(resolveMemoryDir());
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function ensureDirs() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	fs.mkdirSync(RECOVERY_DIR, { recursive: true });
}

// Daily logs are keyed by the user's LOCAL calendar day. toISOString() is UTC,
// which filed every evening write (after 5pm PDT) under tomorrow's date and
// made the injected "today's log" look at the wrong file.
function pad2(n) {
	return String(n).padStart(2, "0");
}

function localDateStr(d) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayStr() {
	return localDateStr(new Date());
}

export function yesterdayStr() {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return localDateStr(d);
}

export function nowTimestamp() {
	const d = new Date();
	return `${localDateStr(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function shortSessionId(sessionId) {
	return sessionId.slice(0, 8);
}

export function readFileSafe(filePath) {
	try {
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDailyDate(date) {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [year, month, day] = date.split("-").map(Number);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

export function dailyPath(date) {
	if (!isValidDailyDate(date)) {
		throw new Error(`Invalid daily date: ${date}. Expected YYYY-MM-DD.`);
	}
	return path.join(DAILY_DIR, `${date}.md`);
}

// ---------------------------------------------------------------------------
// Limits + preview helpers
// ---------------------------------------------------------------------------

const RESPONSE_PREVIEW_MAX_CHARS = 4_000;
const RESPONSE_PREVIEW_MAX_LINES = 120;

const CONTEXT_LONG_TERM_MAX_CHARS = 4_000;
const CONTEXT_LONG_TERM_MAX_LINES = 150;
const CONTEXT_SCRATCHPAD_MAX_CHARS = 2_000;
const CONTEXT_SCRATCHPAD_MAX_LINES = 120;
const CONTEXT_DAILY_MAX_CHARS = 3_000;
const CONTEXT_DAILY_MAX_LINES = 120;
const CONTEXT_SEARCH_MAX_CHARS = 2_500;
const CONTEXT_SEARCH_MAX_LINES = 80;
const CONTEXT_MAX_CHARS = 16_000;

const EXIT_SUMMARY_MAX_CHARS = 80_000;
const EXIT_SUMMARY_MIN_MESSAGES = 4;
const EXIT_SUMMARY_SYSTEM_PROMPT = [
	"You are a session recap assistant.",
	"Read the conversation and extract key decisions, lessons learned, notes, and follow-ups.",
	"Return ONLY markdown in the specified format, without any extra commentary.",
].join("\n");

function normalizeContent(content) {
	return content.trim();
}

function truncateLines(lines, maxLines, mode) {
	if (maxLines <= 0 || lines.length <= maxLines) {
		return { lines, truncated: false };
	}

	if (mode === "end") {
		return { lines: lines.slice(-maxLines), truncated: true };
	}

	if (mode === "middle" && maxLines > 1) {
		const marker = "... (truncated) ...";
		const keep = maxLines - 1;
		const headCount = Math.ceil(keep / 2);
		const tailCount = Math.floor(keep / 2);
		const head = lines.slice(0, headCount);
		const tail = tailCount > 0 ? lines.slice(-tailCount) : [];
		return { lines: [...head, marker, ...tail], truncated: true };
	}

	return { lines: lines.slice(0, maxLines), truncated: true };
}

function truncateText(text, maxChars, mode) {
	if (maxChars <= 0 || text.length <= maxChars) {
		return { text, truncated: false };
	}

	if (mode === "end") {
		return { text: text.slice(-maxChars), truncated: true };
	}

	if (mode === "middle" && maxChars > 10) {
		const marker = "... (truncated) ...";
		const keep = maxChars - marker.length;
		if (keep > 0) {
			const headCount = Math.ceil(keep / 2);
			const tailCount = Math.floor(keep / 2);
			return {
				text: text.slice(0, headCount) + marker + text.slice(text.length - tailCount),
				truncated: true,
			};
		}
	}

	return { text: text.slice(0, maxChars), truncated: true };
}

function buildPreview(content, options) {
	const normalized = normalizeContent(content);
	if (!normalized) {
		return {
			preview: "",
			truncated: false,
			totalLines: 0,
			totalChars: 0,
			previewLines: 0,
			previewChars: 0,
		};
	}

	const lines = normalized.split("\n");
	const totalLines = lines.length;
	const totalChars = normalized.length;

	const lineResult = truncateLines(lines, options.maxLines, options.mode);
	const text = lineResult.lines.join("\n");
	const charResult = truncateText(text, options.maxChars, options.mode);
	const preview = charResult.text;

	const previewLines = preview ? preview.split("\n").length : 0;
	const previewChars = preview.length;

	return {
		preview,
		truncated: lineResult.truncated || charResult.truncated,
		totalLines,
		totalChars,
		previewLines,
		previewChars,
	};
}

function formatPreviewBlock(label, content, mode) {
	const result = buildPreview(content, {
		maxLines: RESPONSE_PREVIEW_MAX_LINES,
		maxChars: RESPONSE_PREVIEW_MAX_CHARS,
		mode,
	});

	if (!result.preview) {
		return `${label}: empty.`;
	}

	const meta = `${label} (${result.totalLines} lines, ${result.totalChars} chars)`;
	const note = result.truncated
		? `\n[preview truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${meta}\n\n${result.preview}${note}`;
}

function formatContextSection(label, content, mode, maxLines, maxChars) {
	const result = buildPreview(content, { maxLines, maxChars, mode });
	if (!result.preview) {
		return "";
	}
	const note = result.truncated
		? `\n\n[truncated: showing ${result.previewLines}/${result.totalLines} lines, ${result.previewChars}/${result.totalChars} chars]`
		: "";
	return `${label}\n\n${result.preview}${note}`;
}

function formatExitSummaryReason(reason) {
	if (reason === "ctrl+d") return "ctrl+d";
	if (reason === "slash-quit") return "/quit";
	return "session-end";
}

function truncateConversationForSummary(conversationText) {
	const trimmed = conversationText.trim();
	if (!trimmed) {
		return { text: "", truncated: false, totalChars: 0 };
	}
	const truncated = truncateText(trimmed, EXIT_SUMMARY_MAX_CHARS, "end");
	return {
		text: truncated.text,
		truncated: truncated.truncated,
		totalChars: trimmed.length,
	};
}

function buildExitSummaryPrompt(conversationText, truncated, totalChars) {
	const lines = [
		"Review the conversation and extract important decisions, lessons learned, notes, and follow-ups for a daily log.",
		"Return markdown only with these exact headings:",
		"### Decisions",
		"### Lessons Learned",
		"### Notes",
		"### Follow-ups",
		'Use bullet points under each heading. If there is nothing, write "None.".',
	];

	if (truncated) {
		lines.push(
			`Note: Conversation transcript was truncated to the most recent ${conversationText.length} of ${totalChars} characters.`,
		);
	}

	lines.push("", "<conversation>", conversationText, "</conversation>");
	return lines.join("\n");
}

function formatExitSummaryEntry(summary, reason, sessionId, timestamp) {
	const header = `## Session Summary (auto, exit: ${formatExitSummaryReason(reason)})`;
	return [`<!-- ${timestamp} [${sessionId}] -->`, header, "", summary.trim()].join("\n");
}

/**
 * Model used for exit summaries. The dsh session's active model comes from
 * `agent.options` (resolved by the harness before the agent starts);
 * PI_MEMORY_EXIT_SUMMARY_MODEL="provider/model-id" overrides it (e.g. to a
 * cheaper/faster model). dsh has no `modelRegistry.find` — the spec is used
 * verbatim; an unresolvable provider/model fails the stream call and the
 * summary is not persisted (upstream fell back to the session model with a
 * UI warning; dsh has no UI channel for that warning).
 */
function resolveExitSummaryModel(agent) {
	const spec = (process.env.PI_MEMORY_EXIT_SUMMARY_MODEL ?? "").trim();
	if (spec) {
		const slash = spec.indexOf("/");
		if (slash > 0) return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
	}
	const provider = agent?.options?.provider;
	const model = agent?.options?.model;
	if (provider && model) return { provider, model };
	return null;
}

/**
 * Render the durable session log into plain conversation text for the summary
 * prompt. Upstream used Pi's `sessionManager.getBranch()` + `convertToLlm` +
 * `serializeConversation`; dsh's equivalent is `agent.session.events`
 * (user/message, assistant/message, tool/call, tool/result records).
 */
export function renderConversationFromSession(session) {
	const lines = [];
	let userMessages = 0;
	let assistantMessages = 0;
	for (const ev of session?.events ?? []) {
		if (ev.type === "user/message") {
			const text = textFromContent(ev.data?.content);
			if (text) {
				lines.push(`user: ${text}`);
				userMessages++;
			}
		} else if (ev.type === "assistant/message") {
			const text = textFromContent(ev.data?.message?.content);
			if (text) {
				lines.push(`assistant: ${text}`);
				assistantMessages++;
			}
		} else if (ev.type === "tool/call") {
			lines.push(`tool: ${ev.data?.name}(${ev.data?.arguments ?? ""})`);
		} else if (ev.type === "tool/result") {
			const text = textFromContent(ev.data?.message?.content);
			if (text) lines.push(`tool result: ${text}`);
		}
	}
	return { text: lines.join("\n"), messageCount: userMessages + assistantMessages };
}

function textFromContent(content) {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

/**
 * One-shot text completion through the dsh LLM runtime. Upstream used
 * `complete()` from `@earendil-works/pi-ai/compat`; the dsh equivalent is
 * `ctx.llm.stream(...)` (the llm service is host-provided, so the message is
 * constructed inline to avoid a dependency on the host's internal packages).
 */
export async function streamTextCompletion(ctx, selection, system, prompt) {
	const llm = ctx.get("llm");
	if (!llm) throw new Error("LLM service unavailable");

	const stream = llm.stream({
		provider: selection.provider,
		model: selection.model,
		system,
		messages: [
			{
				id: randomUUID(),
				role: "user",
				content: [{ type: "text", text: prompt }],
				source: { kind: "plugin", plugin: name },
			},
		],
	});

	let text = "";
	for await (const chunk of stream) {
		if (chunk.type === "text-delta") {
			text += chunk.text;
		} else if (chunk.type === "finish") {
			const reason = chunk.reason;
			if (reason?.kind === "error" || reason?.kind === "aborted") {
				throw new Error(reason.failure?.message ?? `stream finished with ${reason.kind}`);
			}
		}
	}
	return text;
}

export async function generateExitSummary(ctx, agent) {
	const { text: conversationText, messageCount } = renderConversationFromSession(agent?.session);
	if (messageCount < EXIT_SUMMARY_MIN_MESSAGES) {
		return { summary: null, hasMessages: false };
	}

	const selection = resolveExitSummaryModel(agent);
	if (!selection) {
		return { summary: null, error: "No active model", hasMessages: true };
	}

	const { text: truncatedText, truncated, totalChars } = truncateConversationForSummary(conversationText);
	if (!truncatedText.trim()) {
		return { summary: null, error: "No conversation text to summarize", hasMessages: true };
	}

	try {
		const responseText = await streamTextCompletion(
			ctx,
			selection,
			EXIT_SUMMARY_SYSTEM_PROMPT,
			buildExitSummaryPrompt(truncatedText, truncated, totalChars),
		);

		const summaryText = responseText.trim();
		if (!summaryText) {
			return { summary: null, error: "Summary was empty", hasMessages: true };
		}

		return { summary: summaryText, hasMessages: true };
	} catch (err) {
		return { summary: null, error: err instanceof Error ? err.message : String(err), hasMessages: true };
	}
}

function getQmdUpdateMode() {
	const mode = (process.env.PI_MEMORY_QMD_UPDATE ?? "background").toLowerCase();
	if (mode === "manual" || mode === "off" || mode === "background") {
		return mode;
	}
	return "background";
}

export function shouldSummarizeLifecycleTransitions() {
	const value = (process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes" || value === "on";
}

/**
 * Exit summaries on session end can be disabled with
 * PI_MEMORY_EXIT_SUMMARY=0 (aliases: off/false/no). Default: enabled.
 */
export function isExitSummaryEnabled() {
	const value = (process.env.PI_MEMORY_EXIT_SUMMARY ?? "").trim().toLowerCase();
	return !(value === "0" || value === "off" || value === "false" || value === "no");
}

/**
 * True when a generated exit summary carries no actual content — every section
 * is empty or "None.". The summary prompt instructs the model to write "None."
 * under each heading when nothing is worth recording; persisting those blocks
 * would pollute the daily log (re-injected every session start) and the qmd
 * index with boilerplate.
 */
export function isExitSummaryEmpty(summary) {
	const contentLines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	if (contentLines.length === 0) return true;
	return contentLines.every((line) => /^none\.?$/i.test(line.replace(/^[-*+]\s*/, "")));
}

const DEFAULT_EXIT_SUMMARY_TIMEOUT_MS = 10_000;

/**
 * Self-imposed timeout for the exit-summary work on session end. dsh's
 * process-exit controller also bounds tree disposal (default 5s), so a slow
 * provider is cut off by the harness itself; this keeps the same upstream
 * knob (PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS).
 */
export function getExitSummaryTimeoutMs() {
	const configured = Number(process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_EXIT_SUMMARY_TIMEOUT_MS;
}

export function shouldSkipExitSummaryForReason(reason) {
	if (!reason) return false;
	if (shouldSummarizeLifecycleTransitions()) return false;
	return ["reload", "new", "resume", "fork"].includes(reason);
}

async function ensureQmdAvailableForUpdate() {
	if (qmdAvailable) return true;
	if (getQmdUpdateMode() !== "background") return false;
	qmdAvailable = await detectQmd();
	return qmdAvailable;
}

// ---------------------------------------------------------------------------
// Scratchpad helpers
// ---------------------------------------------------------------------------

export function parseScratchpad(content) {
	const items = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^- \[([ xX])\] (.+)$/);
		if (match) {
			let meta = "";
			if (i > 0 && lines[i - 1].match(/^<!--.*-->$/)) {
				meta = lines[i - 1];
			}
			items.push({
				done: match[1].toLowerCase() === "x",
				text: match[2],
				meta,
			});
		}
	}
	return items;
}

export function serializeScratchpad(items) {
	const lines = ["# Scratchpad", ""];
	for (const item of items) {
		if (item.meta) {
			lines.push(item.meta);
		}
		const checkbox = item.done ? "[x]" : "[ ]";
		lines.push(`- ${checkbox} ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

// Line-preserving mutations. The old parse→mutate→serialize round-trip kept
// only checklist lines, silently deleting anything else in SCRATCHPAD.md
// (hand-written notes, section headers, sub-bullets) on the first write.
// These operate on the raw lines so unknown content survives.

const SCRATCHPAD_ITEM_REGEX = /^- \[([ xX])\] (.+)$/;
const SCRATCHPAD_META_COMMENT_REGEX = /^<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[^\]\r\n]+\] -->$/;
const MEMORY_ENTRY_META_COMMENT_REGEX =
	/^<!-- (?:(?:last updated: )?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|HANDOFF \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[^\]\r\n]+\] -->$/;
const RECOVERY_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function scratchpadAdd(content, text, meta) {
	if (!content.trim()) {
		return serializeScratchpad([{ done: false, text, meta }]);
	}
	const base = content.replace(/\n+$/, "");
	return `${base}\n${meta}\n- [ ] ${text}\n`;
}

export function scratchpadToggle(content, needle, done) {
	const lines = content.split("\n");
	const lower = needle.toLowerCase();
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(SCRATCHPAD_ITEM_REGEX);
		if (!m) continue;
		if ((m[1].toLowerCase() === "x") === done) continue;
		if (!m[2].toLowerCase().includes(lower)) continue;
		lines[i] = `- [${done ? "x" : " "}] ${m[2]}`;
		return { content: lines.join("\n"), matched: true };
	}
	return { content, matched: false };
}

export function scratchpadClearDone(content) {
	const lines = content.split("\n");
	const out = [];
	let removed = 0;
	for (const line of lines) {
		const m = line.match(SCRATCHPAD_ITEM_REGEX);
		if (m && m[1].toLowerCase() === "x") {
			removed++;
			// Drop the item's timestamp comment directly above it, if any.
			if (out.length > 0 && SCRATCHPAD_META_COMMENT_REGEX.test(out[out.length - 1])) {
				out.pop();
			}
			continue;
		}
		out.push(line);
	}
	return { content: out.join("\n"), removed };
}

// ---------------------------------------------------------------------------
// Forget helper — deletion as a first-class operation
// ---------------------------------------------------------------------------

/**
 * Remove every generated entry containing `match` (case-insensitive) from
 * `content`. Generated entries start at a pi-memory timestamp comment and end
 * at the next one, so multi-paragraph writes are removed as a unit. Content
 * before the first generated entry falls back to blank-line paragraph blocks.
 * Returns the surviving content and complete removed entries.
 */
export function forgetBlocks(content, match) {
	const needle = match.trim().toLowerCase();
	if (!needle) return { content, removed: [] };
	const newline = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedContent = content.replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");

	const blocks = [];
	let currentLines = [];
	let currentIsStamped = false;
	const flushCurrent = () => {
		const current = currentLines.join("\n").trim();
		if (!current) return;
		if (currentIsStamped) {
			blocks.push(current);
		} else {
			blocks.push(
				...current
					.split(/\n{2,}/)
					.map((block) => block.trim())
					.filter(Boolean),
			);
		}
	};

	for (const line of normalizedContent.split("\n")) {
		if (MEMORY_ENTRY_META_COMMENT_REGEX.test(line)) {
			flushCurrent();
			currentLines = [line];
			currentIsStamped = true;
		} else {
			currentLines.push(line);
		}
	}
	flushCurrent();

	const kept = [];
	const removed = [];
	for (const block of blocks) {
		if (block.toLowerCase().includes(needle)) {
			removed.push(block);
		} else {
			kept.push(block);
		}
	}
	if (removed.length === 0) return { content, removed };
	const joined = kept.join("\n\n").trim();
	return {
		content: joined ? `${joined}\n`.replace(/\n/g, newline) : "",
		removed: removed.map((block) => block.replace(/\n/g, newline)),
	};
}

function recoveryPath(recoveryId) {
	if (!RECOVERY_ID_REGEX.test(recoveryId)) return null;
	return path.join(RECOVERY_DIR, `${recoveryId}.json`);
}

function isRecoveryRecord(value) {
	if (!value || typeof value !== "object") return false;
	const record = value;
	return (
		record.version === 1 &&
		typeof record.id === "string" &&
		RECOVERY_ID_REGEX.test(record.id) &&
		(record.target === "long_term" || record.target === "daily") &&
		(record.target !== "daily" || (typeof record.date === "string" && isValidDailyDate(record.date))) &&
		Array.isArray(record.removedContent) &&
		record.removedContent.length > 0 &&
		record.removedContent.every((entry) => typeof entry === "string")
	);
}

function writeRecoveryRecord(target, date, removedContent) {
	const record = {
		version: 1,
		id: randomUUID(),
		createdAt: new Date().toISOString(),
		target,
		...(date ? { date } : {}),
		removedContent,
	};
	const filePath = recoveryPath(record.id);
	if (!filePath) throw new Error("Failed to create a valid recovery ID.");
	fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
	return record;
}

function readRecoveryRecord(recoveryId) {
	const filePath = recoveryPath(recoveryId);
	if (!filePath) return null;
	const content = readFileSafe(filePath);
	if (!content) return null;
	try {
		const record = JSON.parse(content);
		if (!isRecoveryRecord(record) || record.id !== recoveryId) return null;
		return { record, filePath };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export function buildMemoryContext(searchResults) {
	ensureDirs();
	// Priority order: scratchpad > today's daily > search results > MEMORY.md > yesterday's daily
	const sections = [];

	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			const serialized = serializeScratchpad(openItems);
			const section = formatContextSection(
				"## SCRATCHPAD.md (working context)",
				serialized,
				"start",
				CONTEXT_SCRATCHPAD_MAX_LINES,
				CONTEXT_SCRATCHPAD_MAX_CHARS,
			);
			if (section) sections.push(section);
		}
	}

	const today = todayStr();
	const yesterday = yesterdayStr();

	const todayContent = readFileSafe(dailyPath(today));
	if (todayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${today} (today)`,
			todayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (searchResults?.trim()) {
		const section = formatContextSection(
			"## Relevant memories (auto-retrieved)",
			searchResults,
			"start",
			CONTEXT_SEARCH_MAX_LINES,
			CONTEXT_SEARCH_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const longTerm = readFileSafe(MEMORY_FILE);
	if (longTerm?.trim()) {
		const section = formatContextSection(
			"## MEMORY.md (long-term)",
			longTerm,
			"middle",
			CONTEXT_LONG_TERM_MAX_LINES,
			CONTEXT_LONG_TERM_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	const yesterdayContent = readFileSafe(dailyPath(yesterday));
	if (yesterdayContent?.trim()) {
		const section = formatContextSection(
			`## Daily log: ${yesterday} (yesterday)`,
			yesterdayContent,
			"end",
			CONTEXT_DAILY_MAX_LINES,
			CONTEXT_DAILY_MAX_CHARS,
		);
		if (section) sections.push(section);
	}

	if (sections.length === 0) {
		return "";
	}

	const context = `# Memory\n\n${sections.join("\n\n---\n\n")}`;
	if (context.length > CONTEXT_MAX_CHARS) {
		const result = buildPreview(context, {
			maxLines: Number.POSITIVE_INFINITY,
			maxChars: CONTEXT_MAX_CHARS,
			mode: "start",
		});
		const note = result.truncated
			? `\n\n[truncated overall context: showing ${result.previewChars}/${result.totalChars} chars]`
			: "";
		return `${result.preview}${note}`;
	}

	return context;
}

// ---------------------------------------------------------------------------
// QMD integration
// ---------------------------------------------------------------------------

function isQmdCommand(file) {
	if (typeof file !== "string") return false;
	const basename = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return basename === "qmd" || basename === "qmd.cmd" || basename === "qmd.exe";
}

const QMD_JS_REL = path.join("node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");

let cachedQmdJsPath;

// On Windows, cmd-shim writes the literal `/bin/sh` (the package's shebang
// interpreter) into both qmd.cmd and qmd.ps1, so both shims fail with
// "system cannot find the path specified" / "'/bin/sh.exe' is not recognized"
// outside cygwin/git-bash trees. Bypass the shims by locating qmd's JS entry
// in a sibling node_modules directory of a PATH entry and invoking it with
// node directly — the same thing the sh script in bin/qmd does when launched
// via npm.
export function resolveQmdJsPath(env = process.env) {
	if (cachedQmdJsPath !== undefined) return cachedQmdJsPath;
	const pathStr = env.PATH ?? env.Path ?? "";
	const entries = pathStr.split(path.delimiter).filter(Boolean);
	for (const dir of entries) {
		try {
			const candidate = path.join(dir, QMD_JS_REL);
			if (fs.statSync(candidate).isFile()) {
				cachedQmdJsPath = candidate;
				return candidate;
			}
		} catch {
			// keep scanning
		}
	}
	cachedQmdJsPath = null;
	return null;
}

/** Clear the resolved qmd.js cache (for testing). */
export function _resetQmdJsResolutionForTest() {
	cachedQmdJsPath = undefined;
}

export function buildQmdSpawn(file, args, platform = process.platform, qmdJsPath = null) {
	if (platform !== "win32" || !isQmdCommand(file) || !qmdJsPath) {
		return { file, args: [...args] };
	}
	return { file: "node", args: [qmdJsPath, ...args] };
}

export function buildQmdEnv(env = process.env) {
	const qmdEnv = { ...env, NO_COLOR: "1" };
	delete qmdEnv.FORCE_COLOR;
	return qmdEnv;
}

const execFileWithQmdOptions = (file, args, options, callback) => {
	const qmdJs = process.platform === "win32" && isQmdCommand(file) ? resolveQmdJsPath() : null;
	const spawn = buildQmdSpawn(file, args ?? [], process.platform, qmdJs);
	const execOptions = isQmdCommand(file) ? { ...options, env: buildQmdEnv(options.env ?? process.env) } : options;
	return execFile(spawn.file, spawn.args, execOptions, callback);
};

let execFileFn = execFileWithQmdOptions;

let qmdAvailable = false;
let qmdAvailabilityCheckedAt = 0;
// Positive results are stable for the session; negative results should refresh
// quickly so users who install qmd (or run setupQmdCollection) mid-session
// don't have to wait through a long TTL before retries succeed.
const QMD_STATUS_CACHE_TTL_MS = 5 * 60 * 1000;
const QMD_STATUS_NEGATIVE_CACHE_TTL_MS = 5 * 1000;
const DEFAULT_QMD_SEARCH_TIMEOUT_MS = 60_000;
const qmdCollectionStatusCache = new Map();

function qmdStatusTtl(positive) {
	return positive ? QMD_STATUS_CACHE_TTL_MS : QMD_STATUS_NEGATIVE_CACHE_TTL_MS;
}

export function getQmdSearchTimeoutMs(env = process.env) {
	const configured = Number(env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS);
	return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_QMD_SEARCH_TIMEOUT_MS;
}
let updateTimer = null;

/** Override execFile implementation (for testing). */
export function _setExecFileForTest(fn) {
	execFileFn = fn;
}

/** Reset execFile implementation (for testing). */
export function _resetExecFileForTest() {
	execFileFn = execFileWithQmdOptions;
}

/** Set qmd availability flag (for testing). */
export function _setQmdAvailable(value) {
	qmdAvailable = value;
	qmdAvailabilityCheckedAt = Date.now();
}

/** Get current qmd availability flag (for testing). */
export function _getQmdAvailable() {
	return qmdAvailable;
}

/** Get current update timer (for testing). */
export function _getUpdateTimer() {
	return updateTimer;
}

/** Clear the update timer (for testing). */
export function _clearUpdateTimer() {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}
}

/** Clear qmd status caches (for testing). */
export function _clearQmdStatusCaches() {
	qmdAvailabilityCheckedAt = 0;
	qmdCollectionStatusCache.clear();
}

const QMD_REPO_URL = "https://github.com/tobi/qmd";

export function qmdInstallInstructions() {
	return [
		"memory_search requires qmd.",
		"",
		"Install qmd (either works):",
		"  npm install -g @tobilu/qmd        # no Bun needed",
		`  bun install -g ${QMD_REPO_URL}   # ensure ~/.bun/bin is on PATH`,
		"",
		"The extension auto-creates the collection on next session start.",
		"To set it up manually instead:",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

export function qmdCollectionInstructions() {
	return [
		"qmd collection pi-memory is not configured.",
		"",
		"Set up the collection (one-time):",
		`  qmd collection add ${MEMORY_DIR} --name pi-memory`,
		"  qmd embed",
	].join("\n");
}

/** Auto-create the pi-memory collection and path contexts in qmd. */
export async function setupQmdCollection() {
	try {
		await new Promise((resolve, reject) => {
			execFileFn("qmd", ["collection", "add", MEMORY_DIR, "--name", "pi-memory"], { timeout: 10_000 }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	} catch {
		// Collection may already exist under a different name — not critical
		return false;
	}

	// Add path contexts (best-effort, ignore errors)
	const contexts = [
		["/daily", "Daily append-only work logs organized by date"],
		["/", "Curated long-term memory: decisions, preferences, facts, lessons"],
	];
	for (const [ctxPath, desc] of contexts) {
		try {
			await new Promise((resolve, reject) => {
				execFileFn("qmd", ["context", "add", ctxPath, desc, "-c", "pi-memory"], { timeout: 10_000 }, (err) =>
					err ? reject(err) : resolve(),
				);
			});
		} catch {
			// Ignore — context may already exist
		}
	}
	// Seed the cache so checkCollection("pi-memory") doesn't redundantly re-run
	// setupQmdCollection during the short negative-cache window.
	qmdCollectionStatusCache.set("pi-memory", { checkedAt: Date.now(), exists: true });
	return true;
}

export function detectQmd() {
	const now = Date.now();
	if (qmdAvailabilityCheckedAt && now - qmdAvailabilityCheckedAt < qmdStatusTtl(qmdAvailable)) {
		return Promise.resolve(qmdAvailable);
	}

	return new Promise((resolve) => {
		// `qmd status` can trigger slow model/device probing on some systems (e.g. Vulkan fallback),
		// which may exceed short startup timeouts and produce false negatives.
		// `qmd collection list` is much lighter and still validates the binary is callable.
		execFileFn("qmd", ["collection", "list"], { timeout: 15_000 }, (err) => {
			qmdAvailable = !err;
			qmdAvailabilityCheckedAt = Date.now();
			resolve(qmdAvailable);
		});
	});
}

export function checkCollection(name) {
	const cached = qmdCollectionStatusCache.get(name);
	const now = Date.now();
	if (cached && now - cached.checkedAt < qmdStatusTtl(cached.exists)) {
		return Promise.resolve(cached.exists);
	}

	return new Promise((resolve) => {
		execFileFn("qmd", ["collection", "list", "--json"], { timeout: 10_000 }, (err, stdout) => {
			let exists = false;
			if (!err) {
				try {
					const collections = JSON.parse(stdout);
					if (Array.isArray(collections)) {
						exists = collections.some((entry) => {
							if (typeof entry === "string") return entry === name;
							if (entry && typeof entry === "object" && "name" in entry) {
								return entry.name === name;
							}
							return false;
						});
					} else {
						// qmd may output an object with a collections array or similar
						exists = stdout.includes(name);
					}
				} catch {
					// Fallback: just check if the name appears in the output
					exists = stdout.includes(name);
				}
			}
			qmdCollectionStatusCache.set(name, { checkedAt: Date.now(), exists });
			resolve(exists);
		});
	});
}

// `qmd embed` is incremental: it only embeds new/changed chunks and no-ops in
// well under a second when everything is current. The first run ever may
// download the embedding model, hence the generous timeout.
const QMD_EMBED_TIMEOUT_MS = 10 * 60 * 1000;
let embedInFlight = false;
let embedPending = false;

/**
 * Ensure a background `qmd embed` is running so semantic/deep search stays
 * usable without the user ever running it manually. Returns true if an embed
 * is now running (started here or already in flight), false if embedding is
 * unavailable (qmd missing or background updates disabled).
 *
 * If an embed is already running, the request is queued: another embed runs
 * immediately after the current one finishes, so chunks written while the
 * first embed was already underway don't have to wait for the next session.
 */
export function ensureQmdEmbed() {
	if (getQmdUpdateMode() !== "background") return false;
	if (!qmdAvailable) return false;
	if (embedInFlight) {
		embedPending = true;
		return true;
	}
	embedInFlight = true;
	execFileFn("qmd", ["embed"], { timeout: QMD_EMBED_TIMEOUT_MS }, () => {
		embedInFlight = false;
		if (embedPending) {
			embedPending = false;
			ensureQmdEmbed();
		}
	});
	return true;
}

/** Get/clear the embed-in-flight flag (for testing). */
export function _getEmbedInFlight() {
	return embedInFlight;
}
export function _clearEmbedInFlight() {
	embedInFlight = false;
	embedPending = false;
}

export function scheduleQmdUpdate() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	clearTimeout(updateTimer);
	updateTimer = setTimeout(() => {
		updateTimer = null;
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => ensureQmdEmbed());
	}, 500);
}

async function runQmdUpdateNow() {
	if (getQmdUpdateMode() !== "background") return;
	if (!qmdAvailable) return;
	await new Promise((resolve) => {
		execFileFn("qmd", ["update"], { timeout: 30_000 }, () => resolve());
	});
	// Embeds for the final writes are picked up by the session_start catch-up
	// embed; not chained here so shutdown stays fast.
}

/** Search for memories relevant to the user's prompt. Returns formatted markdown or empty string on error. */
export async function searchRelevantMemories(prompt) {
	if (!qmdAvailable || !prompt.trim()) return "";

	// Sanitize: strip control chars, limit to 200 chars for the search query
	const sanitized = prompt
		// biome-ignore lint/suspicious/noControlCharactersInRegex: we intentionally strip control chars.
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.trim()
		.slice(0, 200);
	if (!sanitized) return "";

	let timer;
	try {
		const hasCollection = await checkCollection("pi-memory");
		if (!hasCollection) return "";

		const results = await Promise.race([
			runQmdSearch("keyword", sanitized, 3),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 3_000);
			}),
		]);

		if (!results || results.results.length === 0) return "";

		const snippets = results.results
			.map((r) => {
				const text = getQmdResultText(r);
				if (!text.trim()) return null;
				const filePath = getQmdResultPath(r);
				const filePart = filePath ? `_${filePath}_` : "";
				return filePart ? `${filePart}\n${text.trim()}` : text.trim();
			})
			.filter(Boolean);

		if (snippets.length === 0) return "";
		return snippets.join("\n\n---\n\n");
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}

// The limit reaches `qmd -n` as a CLI argument; NaN/0/negative/huge values
// from a confused model would produce broken qmd invocations.
export function clampSearchLimit(value, fallback = 5, max = 25) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(1, Math.floor(value)));
}

function getQmdResultPath(r) {
	return r.path ?? r.file;
}

function getQmdResultText(r) {
	return r.content ?? r.chunk ?? r.snippet ?? "";
}

function stripAnsi(text) {
	// qmd may emit spinners/progress bars even with --json, especially on first model download.
	// Strip ANSI CSI/OSC sequences so we can reliably find and parse JSON payloads.
	// CSI parameter bytes include private-mode sequences such as ESC[?25l / ESC[?25h.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
	return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseQmdJson(stdout) {
	const trimmed = stdout.trim();
	if (!trimmed) return [];
	if (trimmed === "No results found." || trimmed === "No results found") return [];

	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const startLine = lines.findIndex((l) => {
		const s = l.trimStart();
		return s.startsWith("[") || s.startsWith("{");
	});
	if (startLine === -1) {
		throw new Error(`Failed to parse qmd output: ${trimmed.slice(0, 200)}`);
	}

	const jsonText = lines.slice(startLine).join("\n").trim();
	if (!jsonText) return [];
	return JSON.parse(jsonText);
}

export function runQmdSearch(mode, query, limit) {
	const subcommand = mode === "keyword" ? "search" : mode === "semantic" ? "vsearch" : "query";
	const args = [subcommand, "--json", "-c", "pi-memory", "-n", String(limit), query];
	const timeoutMs = getQmdSearchTimeoutMs();

	return new Promise((resolve, reject) => {
		execFileFn("qmd", args, { timeout: timeoutMs }, (err, stdout, stderr) => {
			if (err) {
				const cleaned = stripAnsi(stderr ?? "").trim();
				const cleanedMessage = stripAnsi(err.message).trim();
				const timedOut = err.killed === true;
				const hint = timedOut
					? ` (qmd timed out after ${timeoutMs / 1000}s — first semantic/deep search may download or load models; retry shortly)`
					: "";
				reject(new Error(`${cleaned || cleanedMessage}${hint}`));
				return;
			}
			try {
				const parsed = parseQmdJson(stdout);
				const results = Array.isArray(parsed) ? parsed : (parsed?.results ?? parsed?.hits ?? []);
				resolve({ results, stderr: stderr ?? "" });
			} catch (parseErr) {
				if (parseErr instanceof Error) {
					reject(parseErr);
					return;
				}
				reject(new Error(`Failed to parse qmd output: ${stdout.slice(0, 200)}`));
			}
		});
	});
}

/**
 * Best-effort check of whether vector embeddings are ready for semantic/deep
 * search. Bounded by a short timeout because the first semantic query can
 * trigger a model download. Returns "unknown" rather than blocking on it.
 * "ready" means a probe query ran without qmd's "need embeddings" warning —
 * it does not prove the index has content.
 */
export async function probeEmbeddings() {
	let timer;
	try {
		const { stderr } = await Promise.race([
			runQmdSearch("semantic", "memory", 1),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), 4_000);
			}),
		]);
		return /need embeddings/i.test(stderr ?? "") ? "missing" : "ready";
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/need embeddings/i.test(msg)) return "missing";
		return "unknown";
	} finally {
		clearTimeout(timer);
	}
}

/** Collect a fast on-disk inventory of the memory files (no qmd needed). */
export function getMemoryInventory() {
	const longTerm = readFileSafe(MEMORY_FILE) ?? "";
	const scratchpad = readFileSafe(SCRATCHPAD_FILE) ?? "";
	const items = parseScratchpad(scratchpad);
	let dailyFiles = [];
	try {
		dailyFiles = fs
			.readdirSync(DAILY_DIR)
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		dailyFiles = [];
	}
	return {
		dir: MEMORY_DIR,
		longTermChars: longTerm.trim().length,
		scratchpadOpen: items.filter((i) => !i.done).length,
		scratchpadTotal: items.length,
		dailyCount: dailyFiles.length,
		latestDaily: dailyFiles.length ? dailyFiles[dailyFiles.length - 1].replace(/\.md$/, "") : null,
	};
}

// ---------------------------------------------------------------------------
// Memory snapshot (Option P: KV cache-stable context injection)
//
// The system prompt must be byte-stable across turns so local prefix caches
// (llama.cpp, vLLM, MLX) don't invalidate the entire conversation tail on each
// turn. We snapshot the memory context at deliberate checkpoints
// (session_start, session_before_compact, long_term writes, day rollover) and
// emit the same bytes for every turn in between.
// ---------------------------------------------------------------------------

let memorySnapshot = null;
let snapshotTakenAt = null;
let snapshotTakenOnDate = null;
let snapshotReason = null;
let snapshotDirty = false;

function refreshMemorySnapshot(reason) {
	memorySnapshot = buildMemoryContext("");
	snapshotTakenAt = nowTimestamp();
	snapshotTakenOnDate = todayStr();
	snapshotReason = reason;
	snapshotDirty = false;
}

function getSnapshotMode() {
	const mode = (process.env.PI_MEMORY_SNAPSHOT ?? "stable").toLowerCase();
	return mode === "per-turn" ? "per-turn" : "stable";
}

/** Reset snapshot state (for testing). */
export function _resetMemorySnapshot() {
	memorySnapshot = null;
	snapshotTakenAt = null;
	snapshotTakenOnDate = null;
	snapshotReason = null;
	snapshotDirty = false;
}

// ---------------------------------------------------------------------------
// dsh adapter — entry point
// ---------------------------------------------------------------------------

import z from "@deepseek-ai/schemastery";

export const name = "dsh-pi-memory";
export const inject = ["tools"];

// The upstream extension is configured exclusively through PI_MEMORY_*
// environment variables; the dsh row config stays empty (no schema-driven
// options to declare). Config is still exported because the dsh loader
// contract names it.
export const Config = z.object({});

function latestUserText(messages) {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = textFromContent(messages[i]?.content);
		if (text) return text;
	}
	return "";
}

/**
 * The injected system-prompt section text (the dsh equivalent of Pi's
 * `before_agent_start` return value). Synchronous by design: dsh assembles
 * system prompts synchronously, so per-turn qmd search results are prefetched
 * by the `agent/pre-step` listener and read from the cache here.
 */
export function buildInjectedSectionText(searchResults = "") {
	const mode = getSnapshotMode();

	let memoryContext;
	let snapshotCaveat = "";

	if (mode === "per-turn") {
		const skipSearch = process.env.PI_MEMORY_NO_SEARCH === "1";
		memoryContext = buildMemoryContext(skipSearch ? "" : (searchResults ?? ""));
	} else {
		const today = todayStr();
		const needsRefresh = memorySnapshot === null || snapshotDirty || snapshotTakenOnDate !== today;
		if (needsRefresh) {
			const reason =
				memorySnapshot === null ? "before_agent_start" : snapshotDirty ? "long_term_write" : "day_rollover";
			refreshMemorySnapshot(reason);
		}
		memoryContext = memorySnapshot ?? "";
		snapshotCaveat =
			`Snapshot ${snapshotReason} at ${snapshotTakenAt}. ` +
			"Use memory_read / memory_search for the authoritative latest state; " +
			"recent writes may also be visible in tool-call history.";
	}

	if (!memoryContext) return "";

	const headerLines = ["\n\n## Memory"];
	if (snapshotCaveat) headerLines.push(`(${snapshotCaveat})`);
	headerLines.push(
		"The following memory files have been loaded. Use the memory_write tool to persist important information.",
		"- Decisions, preferences, and durable facts \u2192 MEMORY.md",
		"- Day-to-day notes and running context \u2192 daily/<YYYY-MM-DD>.md",
		"- Things to fix later or keep in mind \u2192 scratchpad tool",
		"- Use memory_search to find past context across all memory files (keyword, semantic, or deep search).",
		"- Use #tags (e.g. #decision, #preference) and [[links]] (e.g. [[auth-strategy]]) in memory content to improve future search recall.",
		'- If someone says "remember this," write it immediately.',
		"",
		memoryContext,
	);

	return headerLines.join("\n");
}

/**
 * Session start: detect qmd, auto-setup the collection, and refresh the
 * snapshot. Maps Pi's `session_start` hook to dsh's `agent/session-start`.
 */
export async function handleSessionStart() {
	// Pi's ctrl+d / /quit detection (ctx.ui.onTerminalInput, input hook) has no
	// dsh equivalent, so the exit-summary reason is always "session-end"
	// (see ticket #18); the upstream reason machinery is not ported.

	qmdAvailable = await detectQmd();
	if (!qmdAvailable) {
		// Pi notified the user via ctx.ui.notify; dsh has no plugin UI channel,
		// so the qmd install instructions surface through memory_search /
		// memory_status instead (their return text carries them).
		refreshMemorySnapshot("session_start");
		return;
	}

	const hasCollection = await checkCollection("pi-memory");
	if (!hasCollection) {
		await setupQmdCollection();
	}
	// Catch-up embed: covers writes from previous sessions (shutdown skips
	// embedding) and fresh installs where the collection exists but was
	// never embedded. Incremental, so a no-op when already current.
	ensureQmdEmbed();
	refreshMemorySnapshot("session_start");
}

/**
 * Pre-compaction: auto-capture a session handoff into today's daily log and
 * refresh the snapshot. Maps Pi's `session_before_compact` hook to dsh's
 * `compaction/start` durable session event (dsh has no pre-compaction veto
 * hook; the handoff is written when compaction starts).
 */
export async function handlePreCompact(sessionId) {
	ensureDirs();
	const sid = shortSessionId(sessionId);
	const ts = nowTimestamp();
	const parts = [];

	// Capture open scratchpad items
	const scratchpad = readFileSafe(SCRATCHPAD_FILE);
	if (scratchpad?.trim()) {
		const openItems = parseScratchpad(scratchpad).filter((i) => !i.done);
		if (openItems.length > 0) {
			parts.push("**Open scratchpad items:**");
			for (const item of openItems) {
				parts.push(`- [ ] ${item.text}`);
			}
		}
	}

	// Capture last few lines from today's daily log
	const todayContent = readFileSafe(dailyPath(todayStr()));
	if (todayContent?.trim()) {
		const lines = todayContent.trim().split("\n");
		const tail = lines.slice(-15).join("\n");
		parts.push(`**Recent daily log context:**\n${tail}`);
	}

	// Intentional cache boundary: compaction drops tool history, so the
	// snapshot must catch up to disk on every compaction — even when no
	// handoff is written. Otherwise stale pre-compaction state (e.g. a
	// completed scratchpad item that no longer appears in the snapshot
	// source files) would keep being injected.
	try {
		if (parts.length === 0) return;

		const handoff = [`<!-- HANDOFF ${ts} [${sid}] -->`, "## Session Handoff", ...parts].join("\n");

		const filePath = dailyPath(todayStr());
		const existing = readFileSafe(filePath) ?? "";
		const separator = existing.trim() ? "\n\n" : "";
		fs.writeFileSync(filePath, existing + separator + handoff, "utf-8");
		await ensureQmdAvailableForUpdate();
		scheduleQmdUpdate();
	} finally {
		refreshMemorySnapshot("session_before_compact");
	}
}

/**
 * Session end: clear the qmd update timer and, when enabled, attempt a
 * best-effort exit summary. Maps Pi's `session_shutdown` hook to dsh's
 * `agent/disposed` event.
 *
 * dsh has no session-end event that keeps services alive: in the headless
 * one-shot flow the agent is never disposed before tree teardown, and by the
 * time plugin disposers run the `llm` service is already gone. So this runs
 * only when dsh actually emits `agent/disposed` with a live `llm` service
 * (interactive flows that dispose an agent while the app keeps running);
 * otherwise it degrades to a no-op (summary not persisted, no crash).
 */
export async function handleSessionShutdown(ctx, agent) {
	if (updateTimer) {
		clearTimeout(updateTimer);
		updateTimer = null;
	}

	if (!isExitSummaryEnabled()) {
		return;
	}

	const reason = "session-end";

	let summaryTimer;
	try {
		if (reason) {
			ensureDirs();
			// Race the summary against a self-imposed timeout: a hanging
			// provider must not block shutdown indefinitely. On expiry nothing
			// is persisted (the late result, if any, is simply dropped).
			const summaryWork = generateExitSummary(ctx, agent);
			const expired = new Promise((resolve) => {
				summaryTimer = setTimeout(() => resolve(null), getExitSummaryTimeoutMs());
			});
			const result = await Promise.race([summaryWork, expired]);
			// Only persist real summaries. The old fallback appended an
			// all-"None." boilerplate block on every failed summarization
			// (no API key, empty response, …), polluting the daily log —
			// which is then re-injected into context every session start.
			// Successful-but-empty summaries (every section "None.") are
			// filtered out for the same reason.
			if (result?.hasMessages && result.summary && !isExitSummaryEmpty(result.summary)) {
				const summary = result.summary;
				const sid = shortSessionId(agent?.session?.id ?? "unknown");
				const ts = nowTimestamp();
				const entry = formatExitSummaryEntry(summary, reason, sid, ts);
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(filePath, existing + separator + entry, "utf-8");
				await ensureQmdAvailableForUpdate();
				await runQmdUpdateNow();
			}
		}
	} finally {
		clearTimeout(summaryTimer);
		if (updateTimer) {
			clearTimeout(updateTimer);
			updateTimer = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Tool registration (dsh adapter)
//
// Upstream registered tools via pi.registerTool({...}) with TypeBox
// parameters and a Pi AgentToolResult ({content, details, isError}). dsh's
// ctx.tools.register contract differs in three mechanical ways, each mapped
// below with a reason:
//   1. parameters must be compiled JSON Schema rooted at {type:'object'}
//      (TypeBox compiles to the same shape; the API rejects raw DSL).
//   2. execute(args, exec) returns one canonical JSON value declared by
//      output.schema; render(args, value) turns it into model content.
//      The upstream {content:[{type:'text',text}], details} pair becomes
//      {text, details} — the model-facing text is identical.
//   3. Upstream isError results (a text payload) become thrown Errors; dsh
//      marks a thrown execute as isError and feeds the message to the model.
// ---------------------------------------------------------------------------

const toolOutput = {
	schema: {
		type: "object",
		properties: {
			text: { type: "string" },
			details: { type: "object", additionalProperties: true },
		},
		required: ["text", "details"],
		additionalProperties: false,
	},
	render: (_args, value) => [{ type: "text", text: value.text }],
};

function getSessionId(exec) {
	return exec?.agent?.session?.id ?? "unknown";
}

function registerMemoryTools(ctx) {
	// --- memory_write tool ---
	ctx.tools.register({
		name: "memory_write",
		description: [
			"Write to memory files. Two targets:",
			"- 'long_term': Write to MEMORY.md (curated durable facts, decisions, preferences). Mode: 'append' or 'overwrite'.",
			"- 'daily': Append to today's daily log (daily/<YYYY-MM-DD>.md). Always appends.",
			"Use this when the user asks you to remember something, or when you learn important preferences/decisions.",
			"Use #tags (e.g. #decision, #preference, #lesson, #bug) and [[links]] (e.g. [[auth-strategy]]) in content to improve searchability.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["long_term", "daily"],
					description: "Where to write: 'long_term' for MEMORY.md, 'daily' for today's daily log",
				},
				content: { type: "string", description: "Content to write (Markdown)" },
				mode: {
					type: "string",
					enum: ["append", "overwrite"],
					description: "Write mode for long_term target. Default: 'append'. Daily always appends.",
				},
			},
			required: ["target", "content"],
		},
		output: toolOutput,
		async execute(args, exec) {
			ensureDirs();
			const { target, content, mode } = args;
			const sid = shortSessionId(getSessionId(exec));
			const ts = nowTimestamp();

			if (target === "daily") {
				const filePath = dailyPath(todayStr());
				const existing = readFileSafe(filePath) ?? "";
				const existingPreview = buildPreview(existing, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "end",
				});
				const existingSnippet = existingPreview.preview
					? `\n\n${formatPreviewBlock("Existing daily log preview", existing, "end")}`
					: "\n\nDaily log was empty.";

				const separator = existing.trim() ? "\n\n" : "";
				const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(filePath, existing + separator + stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					text: `Appended to daily log: ${filePath}${existingSnippet}`,
					details: {
						path: filePath,
						target,
						mode: "append",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// long_term
			const existing = readFileSafe(MEMORY_FILE) ?? "";
			const existingPreview = buildPreview(existing, {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "middle",
			});
			const existingSnippet = existingPreview.preview
				? `\n\n${formatPreviewBlock("Existing MEMORY.md preview", existing, "middle")}`
				: "\n\nMEMORY.md was empty.";

			// Long-term writes change the ambient "background context" the model
			// should always see. Mark snapshot dirty so the next turn refreshes.
			// Daily writes are high-frequency and already echoed via tool-call
			// args — they are intentionally NOT marked dirty.
			snapshotDirty = true;

			if (mode === "overwrite") {
				const stamped = `<!-- last updated: ${ts} [${sid}] -->\n${content}`;
				fs.writeFileSync(MEMORY_FILE, stamped, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					text: `Overwrote MEMORY.md${existingSnippet}`,
					details: {
						path: MEMORY_FILE,
						target,
						mode: "overwrite",
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						existingPreview,
					},
				};
			}

			// append (default)
			const separator = existing.trim() ? "\n\n" : "";
			const stamped = `<!-- ${ts} [${sid}] -->\n${content}`;
			fs.writeFileSync(MEMORY_FILE, existing + separator + stamped, "utf-8");
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();
			return {
				text: `Appended to MEMORY.md${existingSnippet}`,
				details: {
					path: MEMORY_FILE,
					target,
					mode: "append",
					sessionId: sid,
					timestamp: ts,
					qmdUpdateMode: getQmdUpdateMode(),
					existingPreview,
				},
			};
		},
	});

	// --- scratchpad tool ---
	ctx.tools.register({
		name: "scratchpad",
		description: [
			"Manage a checklist of things to fix later or keep in mind. Actions:",
			"- 'add': Add a new unchecked item (- [ ] text)",
			"- 'done': Mark an item as done (- [x] text). Match by substring.",
			"- 'undo': Uncheck a done item back to open. Match by substring.",
			"- 'clear_done': Remove all checked items from the list.",
			"- 'list': Show all items.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["add", "done", "undo", "clear_done", "list"],
					description: "What to do",
				},
				text: {
					type: "string",
					description: "Item text for add, or substring to match for done/undo",
				},
			},
			required: ["action"],
		},
		output: toolOutput,
		async execute(args, exec) {
			ensureDirs();
			const { action, text } = args;
			const sid = shortSessionId(getSessionId(exec));
			const ts = nowTimestamp();

			const existing = readFileSafe(SCRATCHPAD_FILE) ?? "";
			const items = parseScratchpad(existing);

			if (action === "list") {
				if (items.length === 0) {
					return { text: "Scratchpad is empty.", details: {} };
				}
				const serialized = serializeScratchpad(items);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				return {
					text: formatPreviewBlock("Scratchpad preview", serialized, "start"),
					details: {
						count: items.length,
						open: items.filter((i) => !i.done).length,
						preview,
					},
				};
			}

			if (action === "add") {
				if (!text) {
					throw new Error("Error: 'text' is required for add.");
				}
				const serialized = scratchpadAdd(existing, text, `<!-- ${ts} [${sid}] -->`);
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					text: `Added: - [ ] ${text}\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "done" || action === "undo") {
				if (!text) {
					throw new Error(`Error: 'text' is required for ${action}.`);
				}
				const targetDone = action === "done";
				const toggled = scratchpadToggle(existing, text, targetDone);
				if (!toggled.matched) {
					throw new Error(`No matching ${targetDone ? "open" : "done"} item found for: "${text}"`);
				}
				const serialized = toggled.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					text: `Updated.\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
					details: {
						action,
						sessionId: sid,
						timestamp: ts,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			if (action === "clear_done") {
				const cleared = scratchpadClearDone(existing);
				const removed = cleared.removed;
				const serialized = cleared.content;
				const preview = buildPreview(serialized, {
					maxLines: RESPONSE_PREVIEW_MAX_LINES,
					maxChars: RESPONSE_PREVIEW_MAX_CHARS,
					mode: "start",
				});
				fs.writeFileSync(SCRATCHPAD_FILE, serialized, "utf-8");
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
				return {
					text: `Cleared ${removed} done item(s).\n\n${formatPreviewBlock("Scratchpad preview", serialized, "start")}`,
					details: {
						action,
						removed,
						qmdUpdateMode: getQmdUpdateMode(),
						preview,
					},
				};
			}

			throw new Error(`Unknown action: ${action}`);
		},
	});

	// --- memory_read tool ---
	ctx.tools.register({
		name: "memory_read",
		description: [
			"Read a memory file. Targets:",
			"- 'long_term': Read MEMORY.md",
			"- 'scratchpad': Read SCRATCHPAD.md",
			"- 'daily': Read a specific day's log (default: today). Pass date as YYYY-MM-DD.",
			"- 'list': List all daily log files.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					enum: ["long_term", "scratchpad", "daily", "list"],
					description: "What to read",
				},
				date: {
					type: "string",
					description: "Date for daily log (YYYY-MM-DD). Default: today.",
				},
			},
			required: ["target"],
		},
		output: toolOutput,
		async execute(args) {
			ensureDirs();
			const { target, date } = args;

			if (target === "list") {
				try {
					const files = fs
						.readdirSync(DAILY_DIR)
						.filter((f) => f.endsWith(".md"))
						.sort()
						.reverse();
					if (files.length === 0) {
						return { text: "No daily logs found.", details: {} };
					}
					return {
						text: `Daily logs:\n${files.map((f) => `- ${f}`).join("\n")}`,
						details: { files },
					};
				} catch {
					return { text: "No daily logs directory.", details: {} };
				}
			}

			if (target === "daily") {
				const d = date ?? todayStr();
				if (!isValidDailyDate(d)) {
					throw new Error(`Invalid date format: ${d}. Use YYYY-MM-DD.`);
				}
				const filePath = dailyPath(d);
				const content = readFileSafe(filePath);
				if (!content) {
					return { text: `No daily log for ${d}.`, details: {} };
				}
				return { text: content, details: { path: filePath, date: d } };
			}

			if (target === "scratchpad") {
				const content = readFileSafe(SCRATCHPAD_FILE);
				if (!content?.trim()) {
					return { text: "SCRATCHPAD.md is empty or does not exist.", details: {} };
				}
				return { text: content, details: { path: SCRATCHPAD_FILE } };
			}

			// long_term
			const content = readFileSafe(MEMORY_FILE);
			if (!content) {
				return { text: "MEMORY.md is empty or does not exist.", details: {} };
			}
			return { text: content, details: { path: MEMORY_FILE } };
		},
	});

	// --- memory_forget tool ---
	ctx.tools.register({
		name: "memory_forget",
		description: [
			"Delete outdated or incorrect facts from memory. Removes every entry/paragraph",
			"containing the match string (case-insensitive substring) from MEMORY.md, or from",
			"a daily log when target='daily'. Every deletion creates a durable recovery record",
			"whose visible recovery ID can be passed to memory_restore if the deletion was wrong.",
			"Use this when the user corrects a stored fact or a memory is no longer true —",
			"stale entries keep resurfacing in retrieval and cause confidently wrong answers.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				match: {
					type: "string",
					description: "Case-insensitive substring identifying the fact(s) to remove",
				},
				target: {
					type: "string",
					enum: ["long_term", "daily"],
					description: "Where to delete from: 'long_term' (MEMORY.md, default) or 'daily'",
				},
				date: {
					type: "string",
					description: "Daily log date (YYYY-MM-DD) when target='daily'. Default: today.",
				},
			},
			required: ["match"],
		},
		output: toolOutput,
		async execute(args) {
			ensureDirs();
			const target = args.target ?? "long_term";
			if (!args.match.trim()) {
				throw new Error("Error: 'match' must not be empty.");
			}
			let filePath;
			let recoveryDate;
			if (target === "daily") {
				const d = args.date ?? todayStr();
				if (!isValidDailyDate(d)) {
					throw new Error(`Invalid date format: ${d}. Use YYYY-MM-DD.`);
				}
				filePath = dailyPath(d);
				recoveryDate = d;
			} else {
				filePath = MEMORY_FILE;
			}

			const existing = readFileSafe(filePath);
			if (!existing?.trim()) {
				return {
					text: `Nothing stored in ${filePath} — nothing to forget.`,
					details: { path: filePath, removed: 0 },
				};
			}

			const result = forgetBlocks(existing, args.match);
			if (result.removed.length === 0) {
				return {
					text: `No entries matching "${args.match}" in ${filePath}.`,
					details: { path: filePath, removed: 0 },
				};
			}

			// Persist the complete recovery payload before mutating the source file.
			// If either write fails, we never report a successful unrecoverable deletion.
			const recovery = writeRecoveryRecord(target, recoveryDate, result.removed);
			fs.writeFileSync(filePath, result.content, "utf-8");
			// Deleted facts must leave the injected snapshot too, whichever file
			// they lived in — a forgotten-but-still-injected memory defeats the
			// point of forgetting.
			snapshotDirty = true;
			await ensureQmdAvailableForUpdate();
			scheduleQmdUpdate();

			const removedPreview = buildPreview(result.removed.join("\n\n"), {
				maxLines: RESPONSE_PREVIEW_MAX_LINES,
				maxChars: RESPONSE_PREVIEW_MAX_CHARS,
				mode: "start",
			});
			return {
				text:
					`Removed ${result.removed.length} entr${result.removed.length === 1 ? "y" : "ies"} from ${filePath}. ` +
					`Recovery ID: ${recovery.id}. To undo this deletion, call memory_restore with that ID.\n\n` +
					"Removed content preview:\n\n" +
					removedPreview.preview,
				details: {
					path: filePath,
					target,
					removed: result.removed.length,
					recoveryId: recovery.id,
					recoveryPath: recoveryPath(recovery.id),
					removedPreview,
				},
			};
		},
	});

	// --- memory_restore tool ---
	ctx.tools.register({
		name: "memory_restore",
		description: [
			"Restore entries removed by memory_forget using the recovery ID returned by that tool.",
			"Restoration is idempotent and appends only missing entries, so later memory writes survive.",
		].join("\n"),
		parameters: {
			type: "object",
			properties: {
				recoveryId: { type: "string", description: "Recovery ID returned by memory_forget" },
			},
			required: ["recoveryId"],
		},
		output: toolOutput,
		async execute(args) {
			ensureDirs();
			const loaded = readRecoveryRecord(args.recoveryId);
			if (!loaded) {
				throw new Error(`No valid recovery record found for ID ${args.recoveryId}.`);
			}

			const { record, filePath: recordPath } = loaded;
			if (record.restoredAt) {
				return {
					text: `Recovery ${record.id} was already restored at ${record.restoredAt}.`,
					details: { recoveryId: record.id, restoredAt: record.restoredAt },
				};
			}

			const targetPath = record.target === "daily" ? dailyPath(record.date) : MEMORY_FILE;
			const existing = readFileSafe(targetPath) ?? "";
			const missingEntries = record.removedContent.filter((entry) => !existing.includes(entry));
			if (missingEntries.length > 0) {
				const separator = existing.trim() ? "\n\n" : "";
				fs.writeFileSync(targetPath, `${existing}${separator}${missingEntries.join("\n\n")}\n`, "utf-8");
				snapshotDirty = true;
				await ensureQmdAvailableForUpdate();
				scheduleQmdUpdate();
			}

			record.restoredAt = new Date().toISOString();
			fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
			return {
				text:
					missingEntries.length > 0
						? `Restored ${missingEntries.length} entr${missingEntries.length === 1 ? "y" : "ies"} to ${targetPath}.`
						: `Recovery ${record.id} was already present in ${targetPath}; marked as restored.`,
				details: {
					recoveryId: record.id,
					target: record.target,
					path: targetPath,
					restored: missingEntries.length,
				},
			};
		},
	});

	// --- memory_search tool ---
	ctx.tools.register({
		name: "memory_search",
		description:
			"Search across all memory files (MEMORY.md, SCRATCHPAD.md, daily logs).\n" +
			"Modes:\n" +
			"- 'keyword' (default, ~30ms): Fast BM25 search. Best for specific terms, dates, names, #tags, [[links]].\n" +
			"- 'semantic' (~2s): Meaning-based search. Finds related concepts even with different wording.\n" +
			"- 'deep' (~10s): Hybrid search with reranking. Use when other modes don't find what you need.\n" +
			"If semantic/deep warns about missing embeddings, embedding starts automatically in the background — retry shortly.\n" +
			"If the first search doesn't find what you need, try rephrasing or switching modes. " +
			"Keyword mode is best for specific terms; semantic mode finds related concepts even with different wording.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				mode: {
					type: "string",
					enum: ["keyword", "semantic", "deep"],
					description: "Search mode. Default: 'keyword'.",
				},
				limit: { type: "number", description: "Max results (default: 5)" },
			},
			required: ["query"],
		},
		output: toolOutput,
		async execute(args) {
			if (!qmdAvailable) {
				// Re-check on demand in case qmd was installed after session start.
				qmdAvailable = await detectQmd();
			}

			if (!qmdAvailable) {
				throw new Error(qmdInstallInstructions());
			}

			let hasCollection = await checkCollection("pi-memory");
			if (!hasCollection) {
				const created = await setupQmdCollection();
				if (created) {
					hasCollection = true;
				}
			}
			if (!hasCollection) {
				throw new Error(
					"Could not set up qmd pi-memory collection. Check that qmd is working and the memory directory exists.",
				);
			}

			const mode = args.mode ?? "keyword";
			const limit = clampSearchLimit(args.limit);

			try {
				const { results, stderr } = await runQmdSearch(mode, args.query, limit);
				const needsEmbed = /need embeddings/i.test(stderr ?? "");
				// Self-heal: any "need embeddings" warning (even with partial
				// results) kicks off an incremental background embed.
				const embedStarted = needsEmbed ? ensureQmdEmbed() : false;

				if (results.length === 0) {
					if (needsEmbed && (mode === "semantic" || mode === "deep")) {
						return {
							text: [
								`No results found for "${args.query}" (mode: ${mode}).`,
								"",
								"qmd reports missing vector embeddings for one or more documents.",
								...(embedStarted
									? [
											"Embedding has been started in the background — retry the search shortly.",
											"(The very first embed may take longer while the embedding model downloads.)",
										]
									: ["Run this once, then retry:", "  qmd embed"]),
							].join("\n"),
							details: { mode, query: args.query, count: 0, needsEmbed: true, embedStarted },
						};
					}
					return {
						text: `No results found for "${args.query}" (mode: ${mode}).`,
						details: { mode, query: args.query, count: 0, needsEmbed },
					};
				}

				const formatted = results
					.map((r, i) => {
						const parts = [`### Result ${i + 1}`];
						const filePath = getQmdResultPath(r);
						if (filePath) parts.push(`**File:** ${filePath}`);
						if (r.score != null) parts.push(`**Score:** ${r.score}`);
						const text = getQmdResultText(r);
						if (text) parts.push(`\n${text}`);
						return parts.join("\n");
					})
					.join("\n\n---\n\n");

				return {
					text: formatted,
					details: { mode, query: args.query, count: results.length, needsEmbed },
				};
			} catch (err) {
				throw new Error(`memory_search error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});

	// --- memory_status tool (doctor) ---
	ctx.tools.register({
		name: "memory_status",
		description:
			"Report the health of the memory system: where files live, what's stored, " +
			"whether qmd search is available, whether the pi-memory collection exists, " +
			"whether embeddings are ready, and the active configuration. " +
			"Use this when search behaves unexpectedly or to confirm setup.",
		parameters: {
			type: "object",
			properties: {},
		},
		output: toolOutput,
		async execute() {
			ensureDirs();
			const inv = getMemoryInventory();

			const qmdOk = qmdAvailable || (await detectQmd());
			let collectionOk = false;
			let embeddings = "n/a";
			if (qmdOk) {
				collectionOk = await checkCollection("pi-memory");
				embeddings = collectionOk ? await probeEmbeddings() : "n/a";
			}

			const mark = (ok) => (ok ? "✓" : "✗");
			const lines = [
				"# Memory status",
				"",
				`- Memory dir: ${inv.dir}`,
				`- MEMORY.md: ${inv.longTermChars} chars`,
				`- Scratchpad: ${inv.scratchpadOpen} open / ${inv.scratchpadTotal} total`,
				`- Daily logs: ${inv.dailyCount}${inv.latestDaily ? ` (latest ${inv.latestDaily})` : ""}`,
				"",
				"## Search (qmd)",
				`- qmd available: ${mark(qmdOk)}`,
			];

			if (qmdOk) {
				lines.push(`- Collection \`pi-memory\`: ${mark(collectionOk)}`);
				if (collectionOk) {
					const embMark = embeddings === "ready" ? "✓" : embeddings === "missing" ? "⚠" : "?";
					lines.push(`- Embeddings (semantic/deep): ${embMark} ${embeddings}`);
					if (embeddings === "missing") {
						if (ensureQmdEmbed()) {
							lines.push("  - Embedding started in the background — re-run memory_status to confirm.");
						} else {
							lines.push("  - Run `qmd embed` once to enable semantic/deep search.");
						}
					} else if (embeddings === "unknown") {
						lines.push("  - Could not verify within the probe timeout; run a semantic search to confirm.");
					}
				} else {
					lines.push("  - Run a `memory_search` (auto-creates it) or `qmd collection add` manually.");
				}
			} else {
				lines.push("", qmdInstallInstructions());
			}

			lines.push(
				"",
				"## Configuration",
				`- PI_MEMORY_SNAPSHOT: ${getSnapshotMode()}`,
				`- PI_MEMORY_QMD_UPDATE: ${getQmdUpdateMode()}`,
				`- PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: ${getQmdSearchTimeoutMs()}`,
				`- PI_MEMORY_DIR: ${process.env.PI_MEMORY_DIR ? "set" : "default"}`,
				`- PI_MEMORY_EXIT_SUMMARY: ${isExitSummaryEnabled() ? "enabled" : "disabled"}`,
				`- PI_MEMORY_EXIT_SUMMARY_MODEL: ${process.env.PI_MEMORY_EXIT_SUMMARY_MODEL?.trim() || "session model"}`,
				`- PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS: ${getExitSummaryTimeoutMs()}`,
			);

			return {
				text: lines.join("\n"),
				details: {
					...inv,
					qmd: qmdOk,
					collection: collectionOk,
					embeddings,
					snapshotMode: getSnapshotMode(),
					qmdUpdateMode: getQmdUpdateMode(),
				},
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Plugin entry (dsh contract: name / inject / Config / apply)
// ---------------------------------------------------------------------------

/**
 * Mount the dsh-pi-memory plugin.
 *
 * Pi lifecycle mapping (each with its reason in the ticket #18 delivery
 * report):
 *   session_start            → agent/session-start (verified at runtime)
 *   session_shutdown         → agent/disposed (fires only when dsh disposes an
 *                              agent with services still live; headless tree
 *                              teardown never reaches it — documented)
 *   input (/quit, ctrl+d)    → dropped (dsh has no plugin input seam; the
 *                              exit-summary reason stays "session-end")
 *   before_agent_start       → systemPrompt.section (synchronous provider;
 *                              per-turn qmd search prefetched at pre-step)
 *   session_before_compact   → session/event "compaction/start" (no
 *                              pre-compaction veto hook in dsh)
 */
export function apply(ctx, _config = {}) {
	let perTurnSearchCache = "";

	// --- session_start: detect qmd, auto-setup collection, refresh snapshot ---
	ctx.on("agent/session-start", async () => {
		try {
			await handleSessionStart();
		} catch (err) {
			ctx.logger?.warn?.(`[${name}] session-start failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// --- session_shutdown (best-effort): exit summary while services are live ---
	ctx.on("agent/disposed", async ({ agent }) => {
		try {
			await handleSessionShutdown(ctx, agent);
		} catch (err) {
			ctx.logger?.warn?.(`[${name}] session-shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	// --- session_before_compact: handoff + snapshot refresh at compaction ---
	ctx.on("session/event", (session, event) => {
		if (event?.type !== "compaction/start") return;
		handlePreCompact(session.id).catch((err) => {
			ctx.logger?.warn?.(`[${name}] compaction handoff failed: ${err instanceof Error ? err.message : String(err)}`);
		});
	});

	// --- per-turn selective injection: prefetch qmd search at each turn's
	// first step (matches Pi's per-turn before_agent_start cadence). The
	// search is awaited before next() — like upstream's before_agent_start —
	// so the current turn's section provider reads fresh results (bounded by
	// searchRelevantMemories' internal 3s timeout; it never rejects). ---
	ctx.on(
		"agent/pre-step",
		async (payload, next) => {
			if (
				getSnapshotMode() === "per-turn" &&
				process.env.PI_MEMORY_NO_SEARCH !== "1" &&
				qmdAvailable &&
				payload?.step === 1
			) {
				const text = latestUserText(payload?.messages);
				if (text) {
					perTurnSearchCache = await searchRelevantMemories(text);
				}
			}
			return next();
		},
		{ prepend: true },
	);

	// --- memory context injection (system prompt section, appended after tool
	// guidance; stable mode emits the byte-stable snapshot) ---
	ctx.inject(["systemPrompt"], (scope) => {
		scope.systemPrompt.section({
			name: "pi-memory:memory-context",
			order: 900,
			text: () => buildInjectedSectionText(perTurnSearchCache),
		});
	});

	registerMemoryTools(ctx);
}
