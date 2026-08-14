// Ported from upstream pi-memory 0.4.2 test/unit.test.ts (bun:test) to
// node:test + node:assert. The seams are unchanged: pure helpers are tested
// directly, and the seven tools are tested through a mock cordis ctx that
// captures registrations (the dsh equivalent of upstream's mock ExtensionAPI).
//
// Adaptations (all from ticket #18):
//   - mock pi (registerTool/on)       → mock dsh ctx (tools.register/on/inject)
//   - tool execute(toolCallId, params, signal, onUpdate, ctx)
//                                     → execute(args, exec)
//   - result.content[0].text/details  → result.text/details
//   - isError results                 → thrown Errors
//   - before_agent_start hook         → buildInjectedSectionText() (section provider)
//   - session_shutdown hook           → handleSessionShutdown(ctx, agent)
//   - session_before_compact hook     → handlePreCompact(sessionId)
//   - session_start hook              → handleSessionStart()
//   - ~/.pi/agent/memory              → $DSH_HOME/agent/memory

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	_clearEmbedInFlight,
	_clearUpdateTimer,
	_getEmbedInFlight,
	_getUpdateTimer,
	_resetBaseDir,
	_resetExecFileForTest,
	_resetMemorySnapshot,
	_resetQmdJsResolutionForTest,
	_setBaseDir,
	_setExecFileForTest,
	_setQmdAvailable,
	apply,
	buildInjectedSectionText,
	buildMemoryContext,
	buildQmdEnv,
	buildQmdSpawn,
	clampSearchLimit,
	dailyPath,
	ensureDirs,
	ensureQmdEmbed,
	forgetBlocks,
	generateExitSummary,
	getExitSummaryTimeoutMs,
	getQmdSearchTimeoutMs,
	handlePreCompact,
	handleSessionShutdown,
	handleSessionStart,
	isExitSummaryEmpty,
	isExitSummaryEnabled,
	nowTimestamp,
	parseScratchpad,
	qmdCollectionInstructions,
	qmdInstallInstructions,
	readFileSafe,
	renderConversationFromSession,
	resolveMemoryDir,
	resolveQmdJsPath,
	runQmdSearch,
	scheduleQmdUpdate,
	scratchpadAdd,
	scratchpadClearDone,
	scratchpadToggle,
	serializeScratchpad,
	shortSessionId,
	streamTextCompletion,
	todayStr,
	yesterdayStr,
} from "../index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir;

function setupTmpDir() {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-test-"));
	_setBaseDir(tmpDir);
}

function cleanupTmpDir() {
	_resetBaseDir();
	_setQmdAvailable(false);
	_clearUpdateTimer();
	fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Create a mock dsh ctx and capture registered tools/hooks/system-prompt section. */
function createMockCtx() {
	const tools = {};
	const hooks = {};
	const effects = [];
	let section = null;
	const ctx = {
		tools: {
			register(def) {
				tools[def.name] = def;
				return () => {};
			},
		},
		on(event, handler) {
			hooks[event] = handler;
			return () => {};
		},
		inject(_services, fn) {
			fn({ systemPrompt: { section: (s) => (section = s) } });
		},
		effect(fn) {
			effects.push(fn);
			return () => {};
		},
		get() {
			return null;
		},
		logger: { warn: () => {}, debug: () => {}, info: () => {} },
	};
	return { ctx, tools, hooks, effects, getSection: () => section };
}

/** Register the plugin against a mock ctx and return the captures. */
function registerPlugin() {
	const mock = createMockCtx();
	apply(mock.ctx, {});
	return mock;
}

/** Create a mock tool execution context (dsh exec contract). */
function createExec(sessionId = "abcdef1234567890") {
	return {
		agent: { session: { id: sessionId }, options: { provider: "openai", id: "gpt-4o-mini" } },
		signal: new AbortController().signal,
	};
}

/** Create a mock agent for exit-summary tests, with optional session events. */
function createMockAgent(sessionId = "abcdef1234567890", events = []) {
	return {
		session: { id: sessionId, events },
		options: { provider: "openai", model: "gpt-4o-mini" },
	};
}

function textMessage(role, text) {
	return {
		type: role === "user" ? "user/message" : "assistant/message",
		data:
			role === "user" ? { content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } },
	};
}

function fourMessageSession() {
	return [
		textMessage("user", "Please remember we chose SQLite."),
		textMessage("assistant", "Noted, using it for the storage layer."),
		textMessage("user", "Also migrate the config to match."),
		textMessage("assistant", "Done — config migrated and tests pass."),
	];
}

// ---------------------------------------------------------------------------
// Package-level port invariants (adapted from upstream "runtime package scope")
// ---------------------------------------------------------------------------

describe("port package invariants", () => {
	it("no longer imports the Pi runtime packages", () => {
		const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf-8");
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

		assert.ok(!source.match(/from\s+["']@earendil-works\/pi-ai["']/));
		assert.ok(!source.match(/from\s+["']@earendil-works\/pi-coding-agent["']/));
		assert.ok(!source.match(/from\s+["']@mariozechner\/pi-ai["']/));

		assert.equal(packageJson.peerDependencies, undefined);
		assert.equal(packageJson.dependencies["@earendil-works/pi-ai"], undefined);
		assert.equal(packageJson.engines.node, ">=22.19.0");
	});

	it("declares the dsh bundle patch and dsh-plugin topics keywords", () => {
		const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
		assert.equal(packageJson.dsh.bundle.patch, "./cordis.patch.yml");
		assert.ok(packageJson.keywords.includes("dsh-plugin"));
		assert.ok(packageJson.keywords.includes("deepseek-harness"));
	});
});

// ---------------------------------------------------------------------------
// 1. Utility functions
// ---------------------------------------------------------------------------

describe("todayStr", () => {
	it("returns YYYY-MM-DD format", () => {
		assert.match(todayStr(), /^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("yesterdayStr", () => {
	it("returns the day before today", () => {
		const today = new Date(todayStr());
		const yesterday = new Date(yesterdayStr());
		assert.equal(yesterday.getTime(), today.getTime() - 24 * 60 * 60 * 1000);
	});
});

describe("nowTimestamp", () => {
	it("returns timestamp in YYYY-MM-DD HH:MM:SS format", () => {
		assert.match(nowTimestamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
	});

	it("does not contain T or Z", () => {
		assert.ok(!nowTimestamp().includes("T"));
		assert.ok(!nowTimestamp().includes("Z"));
	});
});

describe("resolveMemoryDir", () => {
	it("prefers PI_MEMORY_DIR", () => {
		const env = {
			PI_MEMORY_DIR: path.join("custom", "memory"),
			HOME: path.join("home", "ignored"),
			USERPROFILE: path.join("profile", "ignored"),
		};
		assert.equal(resolveMemoryDir(env), env.PI_MEMORY_DIR);
	});

	it("falls back to DSH_HOME under the dsh agent dir", () => {
		const env = { DSH_HOME: path.join("Users", "runner", ".dsh") };
		assert.equal(resolveMemoryDir(env), path.join(env.DSH_HOME, "agent", "memory"));
	});

	it("falls back to ~/.dsh when HOME is set and DSH_HOME is unset", () => {
		const env = { HOME: path.join("Users", "runner") };
		assert.equal(resolveMemoryDir(env), path.join(env.HOME, ".dsh", "agent", "memory"));
	});

	it("falls back to USERPROFILE when HOME is unset", () => {
		const env = { USERPROFILE: path.join("Users", "runneradmin") };
		assert.equal(resolveMemoryDir(env), path.join(env.USERPROFILE, ".dsh", "agent", "memory"));
	});
});

describe("buildQmdSpawn", () => {
	const QMD_JS = "C:\\npm\\prefix\\node_modules\\@tobilu\\qmd\\dist\\cli\\qmd.js";

	it("invokes qmd's JS entry via node on Windows when resolution succeeds", () => {
		const out = buildQmdSpawn("qmd", ["collection", "list"], "win32", QMD_JS);
		assert.equal(out.file, "node");
		assert.deepEqual(out.args, [QMD_JS, "collection", "list"]);
	});

	it("no-arg qmd invocation still uses node + resolved JS path on Windows", () => {
		const out = buildQmdSpawn("qmd", [], "win32", QMD_JS);
		assert.equal(out.file, "node");
		assert.deepEqual(out.args, [QMD_JS]);
	});

	it("paths with spaces and `$` in user args pass through as literal argv", () => {
		const arg = "C:\\Users\\Foo Bar\\$mem";
		const out = buildQmdSpawn("qmd", ["collection", "add", arg], "win32", QMD_JS);
		assert.deepEqual(out.args, [QMD_JS, "collection", "add", arg]);
	});

	it("recognizes qmd.cmd and qmd.exe as qmd commands on Windows", () => {
		assert.equal(buildQmdSpawn("qmd.cmd", ["update"], "win32", QMD_JS).file, "node");
		assert.equal(buildQmdSpawn("qmd.exe", ["update"], "win32", QMD_JS).file, "node");
	});

	it("falls through to bare qmd when resolution returns null", () => {
		const out = buildQmdSpawn("qmd", ["update"], "win32", null);
		assert.equal(out.file, "qmd");
		assert.deepEqual(out.args, ["update"]);
	});

	it("passes through unchanged on non-Windows even with a resolved path", () => {
		const out = buildQmdSpawn("qmd", ["update"], "linux", QMD_JS);
		assert.equal(out.file, "qmd");
		assert.deepEqual(out.args, ["update"]);
	});

	it("passes through unchanged for non-qmd commands on Windows", () => {
		const out = buildQmdSpawn("node", ["-v"], "win32", QMD_JS);
		assert.equal(out.file, "node");
		assert.deepEqual(out.args, ["-v"]);
	});
});

describe("resolveQmdJsPath", () => {
	let scratchDir;
	beforeEach(() => {
		scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-qmd-resolve-"));
		_resetQmdJsResolutionForTest();
	});
	afterEach(() => {
		fs.rmSync(scratchDir, { recursive: true, force: true });
		_resetQmdJsResolutionForTest();
	});

	it("returns the sibling node_modules path for a PATH entry that contains the install", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const found = resolveQmdJsPath({ PATH: prefix });
		assert.equal(found, qmdJs);
	});

	it("returns null when no PATH entry has a sibling install", () => {
		const empty = path.join(scratchDir, "empty");
		fs.mkdirSync(empty, { recursive: true });
		const found = resolveQmdJsPath({ PATH: empty });
		assert.equal(found, null);
	});

	it("caches the resolved path across calls", () => {
		const prefix = path.join(scratchDir, "prefix");
		const qmdJs = path.join(prefix, "node_modules", "@tobilu", "qmd", "dist", "cli", "qmd.js");
		fs.mkdirSync(path.dirname(qmdJs), { recursive: true });
		fs.writeFileSync(qmdJs, "// stub", "utf-8");

		const first = resolveQmdJsPath({ PATH: prefix });
		// Second call with an empty PATH still returns the cached value
		const second = resolveQmdJsPath({ PATH: "" });
		assert.equal(first, qmdJs);
		assert.equal(second, qmdJs);
	});
});

describe("shortSessionId", () => {
	it("returns first 8 characters", () => {
		assert.equal(shortSessionId("abcdef1234567890"), "abcdef12");
	});

	it("handles exactly 8 characters", () => {
		assert.equal(shortSessionId("12345678"), "12345678");
	});

	it("handles shorter string", () => {
		assert.equal(shortSessionId("abc"), "abc");
	});

	it("handles empty string", () => {
		assert.equal(shortSessionId(""), "");
	});
});

describe("readFileSafe", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	it("reads existing file", () => {
		const filePath = path.join(tmpDir, "test.txt");
		fs.writeFileSync(filePath, "hello world", "utf-8");
		assert.equal(readFileSafe(filePath), "hello world");
	});

	it("returns null for non-existent file", () => {
		assert.equal(readFileSafe(path.join(tmpDir, "nope.txt")), null);
	});

	it("reads empty file", () => {
		const filePath = path.join(tmpDir, "empty.txt");
		fs.writeFileSync(filePath, "", "utf-8");
		assert.equal(readFileSafe(filePath), "");
	});

	it("reads unicode content", () => {
		const filePath = path.join(tmpDir, "unicode.txt");
		fs.writeFileSync(filePath, "Hello 🌍 world", "utf-8");
		assert.equal(readFileSafe(filePath), "Hello 🌍 world");
	});
});

describe("dailyPath", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	it("returns path with .md extension", () => {
		const result = dailyPath("2026-02-15");
		assert.ok(result.endsWith("2026-02-15.md"));
	});

	it("uses daily subdirectory", () => {
		const result = dailyPath("2026-02-15");
		assert.ok(result.includes(path.join("daily", "2026-02-15.md")));
	});

	it("rejects invalid date input", () => {
		assert.throws(() => dailyPath("../../outside"), /Invalid daily date/);
	});
});

describe("ensureDirs", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	it("creates memory and daily directories", () => {
		ensureDirs();
		assert.equal(fs.existsSync(tmpDir), true);
		assert.equal(fs.existsSync(path.join(tmpDir, "daily")), true);
	});

	it("is idempotent", () => {
		ensureDirs();
		ensureDirs(); // should not throw
		assert.equal(fs.existsSync(tmpDir), true);
	});
});

// ---------------------------------------------------------------------------
// 2. Scratchpad parsing and serialization
// ---------------------------------------------------------------------------

describe("parseScratchpad", () => {
	it("parses unchecked items", () => {
		const items = parseScratchpad("- [ ] Fix bug\n- [ ] Add feature\n");
		assert.equal(items.length, 2);
		assert.deepEqual(items[0], { done: false, text: "Fix bug", meta: "" });
		assert.deepEqual(items[1], { done: false, text: "Add feature", meta: "" });
	});

	it("parses checked items", () => {
		const items = parseScratchpad("- [x] Done task\n- [X] Also done\n");
		assert.equal(items.length, 2);
		assert.equal(items[0].done, true);
		assert.equal(items[1].done, true);
	});

	it("parses mixed items", () => {
		const items = parseScratchpad("- [ ] Open\n- [x] Done\n- [ ] Also open\n");
		assert.equal(items.length, 3);
		assert.equal(items[0].done, false);
		assert.equal(items[1].done, true);
		assert.equal(items[2].done, false);
	});

	it("captures metadata comment from preceding line", () => {
		const content = "<!-- 2026-02-15 10:00:00 [abc12345] -->\n- [ ] Task with meta\n";
		const items = parseScratchpad(content);
		assert.equal(items.length, 1);
		assert.equal(items[0].meta, "<!-- 2026-02-15 10:00:00 [abc12345] -->");
		assert.equal(items[0].text, "Task with meta");
	});

	it("ignores non-checklist lines", () => {
		const content = "# Scratchpad\n\nSome text\n- [ ] Real item\n- Not a checkbox\n";
		const items = parseScratchpad(content);
		assert.equal(items.length, 1);
		assert.equal(items[0].text, "Real item");
	});

	it("handles empty content", () => {
		assert.equal(parseScratchpad("").length, 0);
	});

	it("handles content with only headers", () => {
		assert.equal(parseScratchpad("# Scratchpad\n\n").length, 0);
	});

	it("handles items without metadata", () => {
		const items = parseScratchpad("- [ ] No meta item\n");
		assert.equal(items[0].meta, "");
	});

	it("does not pick up non-comment lines as metadata", () => {
		const content = "some random line\n- [ ] Task\n";
		const items = parseScratchpad(content);
		assert.equal(items[0].meta, "");
	});

	it("handles item at first line (no preceding line for meta)", () => {
		const items = parseScratchpad("- [ ] First line item\n");
		assert.equal(items.length, 1);
		assert.equal(items[0].meta, "");
	});
});

describe("serializeScratchpad", () => {
	it("serializes unchecked items", () => {
		const result = serializeScratchpad([{ done: false, text: "Fix bug", meta: "" }]);
		assert.equal(result, "# Scratchpad\n\n- [ ] Fix bug\n");
	});

	it("serializes checked items", () => {
		const result = serializeScratchpad([{ done: true, text: "Done task", meta: "" }]);
		assert.equal(result, "# Scratchpad\n\n- [x] Done task\n");
	});

	it("includes metadata comments", () => {
		const result = serializeScratchpad([{ done: false, text: "Task", meta: "<!-- 2026-02-15 [abc] -->" }]);
		assert.ok(result.includes("<!-- 2026-02-15 [abc] -->"));
		assert.ok(result.includes("- [ ] Task"));
	});

	it("serializes empty list", () => {
		assert.equal(serializeScratchpad([]), "# Scratchpad\n\n");
	});

	it("round-trips correctly", () => {
		const original = [
			{ done: false, text: "Open task", meta: "<!-- ts [sid] -->" },
			{ done: true, text: "Done task", meta: "<!-- ts2 [sid2] -->" },
			{ done: false, text: "Another open", meta: "" },
		];
		const serialized = serializeScratchpad(original);
		const parsed = parseScratchpad(serialized);
		assert.equal(parsed.length, 3);
		assert.deepEqual(parsed[0], original[0]);
		assert.deepEqual(parsed[1], original[1]);
		assert.deepEqual(parsed[2], original[2]);
	});
});

// ---------------------------------------------------------------------------
// 3. buildMemoryContext
// ---------------------------------------------------------------------------

describe("buildMemoryContext", () => {
	beforeEach(setupTmpDir);
	afterEach(cleanupTmpDir);

	it("returns empty string when no memory files exist", () => {
		ensureDirs();
		assert.equal(buildMemoryContext(), "");
	});

	it("includes MEMORY.md content", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Important fact", "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(ctx.includes("## MEMORY.md (long-term)"));
		assert.ok(ctx.includes("Important fact"));
	});

	it("includes open scratchpad items only", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [ ] Open item\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(ctx.includes("Open item"));
		assert.ok(!ctx.includes("Done item"));
	});

	it("excludes scratchpad section when all items are done", () => {
		ensureDirs();
		const content = "# Scratchpad\n\n- [x] Done item\n";
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), content, "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(!ctx.includes("SCRATCHPAD"));
	});

	it("includes today's daily log", () => {
		ensureDirs();
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's work", "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(ctx.includes(`## Daily log: ${today} (today)`));
		assert.ok(ctx.includes("Today's work"));
	});

	it("includes yesterday's daily log", () => {
		ensureDirs();
		const yesterday = yesterdayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${yesterday}.md`), "Yesterday's work", "utf-8");
		const ctx = buildMemoryContext();
		assert.ok(ctx.includes(`## Daily log: ${yesterday} (yesterday)`));
		assert.ok(ctx.includes("Yesterday's work"));
	});

	it("combines all sections with separators", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Memory content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Daily content", "utf-8");

		const ctx = buildMemoryContext();
		assert.ok(ctx.startsWith("# Memory"));
		assert.ok(ctx.includes("---"));
		assert.ok(ctx.includes("Memory content"));
		assert.ok(ctx.includes("Task"));
		assert.ok(ctx.includes("Daily content"));
	});

	it("ignores empty/whitespace-only files", () => {
		ensureDirs();
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "   \n\n  ", "utf-8");
		assert.equal(buildMemoryContext(), "");
	});
});

// ---------------------------------------------------------------------------
// 4. QMD helper functions
// ---------------------------------------------------------------------------

describe("qmdInstallInstructions", () => {
	it("includes qmd repo URL", () => {
		assert.ok(qmdInstallInstructions().includes("github.com/tobi/qmd"));
	});

	it("includes setup commands", () => {
		const instructions = qmdInstallInstructions();
		assert.ok(instructions.includes("qmd collection add"));
		assert.ok(instructions.includes("qmd embed"));
	});
});

describe("qmdCollectionInstructions", () => {
	it("mentions collection not configured", () => {
		assert.ok(qmdCollectionInstructions().includes("pi-memory"));
	});

	it("includes setup commands", () => {
		const instructions = qmdCollectionInstructions();
		assert.ok(instructions.includes("qmd collection add"));
		assert.ok(instructions.includes("qmd embed"));
	});
});

describe("scheduleQmdUpdate", () => {
	beforeEach(() => {
		_clearUpdateTimer();
	});
	afterEach(() => {
		_clearUpdateTimer();
		_setQmdAvailable(false);
	});

	it("does nothing when qmd is not available", () => {
		_setQmdAvailable(false);
		scheduleQmdUpdate();
		assert.equal(_getUpdateTimer(), null);
	});

	it("sets a timer when qmd is available", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		assert.notEqual(_getUpdateTimer(), null);
		_clearUpdateTimer();
	});

	it("debounces multiple calls", () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		const firstTimer = _getUpdateTimer();
		scheduleQmdUpdate();
		const secondTimer = _getUpdateTimer();
		// Timer should be replaced (different reference)
		assert.notEqual(secondTimer, null);
		assert.notEqual(firstTimer, secondTimer);
		_clearUpdateTimer();
	});

	it("chains qmd embed after the debounced update", async () => {
		_setQmdAvailable(true);
		const calls = [];
		_setExecFileForTest((_file, args, _opts, cb) => {
			calls.push(args);
			cb(null, "", "");
		});
		try {
			scheduleQmdUpdate();
			await new Promise((r) => setTimeout(r, 700));
			assert.deepEqual(calls, [["update"], ["embed"]]);
		} finally {
			_resetExecFileForTest();
			_clearEmbedInFlight();
		}
	});
});

describe("ensureQmdEmbed", () => {
	afterEach(() => {
		_resetExecFileForTest();
		_clearEmbedInFlight();
		_setQmdAvailable(false);
		delete process.env.PI_MEMORY_QMD_UPDATE;
	});

	it("returns false when qmd is not available", () => {
		_setQmdAvailable(false);
		assert.equal(ensureQmdEmbed(), false);
	});

	it("returns false when background updates are disabled", () => {
		_setQmdAvailable(true);
		process.env.PI_MEMORY_QMD_UPDATE = "off";
		assert.equal(ensureQmdEmbed(), false);
	});

	it("spawns qmd embed and clears the in-flight flag when it finishes", () => {
		_setQmdAvailable(true);
		const calls = [];
		let finish = null;
		_setExecFileForTest((_file, args, _opts, cb) => {
			calls.push(args);
			finish = () => cb(null, "", "");
		});

		assert.equal(ensureQmdEmbed(), true);
		assert.deepEqual(calls, [["embed"]]);
		assert.equal(_getEmbedInFlight(), true);

		finish();
		assert.equal(_getEmbedInFlight(), false);
	});

	it("queues another embed if requested while one is already running", () => {
		_setQmdAvailable(true);
		const calls = [];
		const finishers = [];
		_setExecFileForTest((_file, args, _opts, cb) => {
			calls.push(args);
			finishers.push(() => cb(null, "", ""));
		});

		assert.equal(ensureQmdEmbed(), true);
		assert.deepEqual(calls, [["embed"]]);

		// A second request arrives while the first embed is still running.
		assert.equal(ensureQmdEmbed(), true);
		assert.deepEqual(calls, [["embed"]]);

		// Finishing the first embed immediately starts the queued one.
		finishers[0]();
		assert.deepEqual(calls, [["embed"], ["embed"]]);
		assert.equal(_getEmbedInFlight(), true);

		finishers[1]();
		assert.equal(_getEmbedInFlight(), false);
	});
});

// ---------------------------------------------------------------------------
// 5. Tool: memory_write
// ---------------------------------------------------------------------------

describe("memory_write tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = registerPlugin().tools;
	});

	afterEach(cleanupTmpDir);

	it("registers with correct name", () => {
		assert.ok(tools.memory_write);
		assert.equal(tools.memory_write.name, "memory_write");
	});

	it("appends to empty MEMORY.md", async () => {
		const exec = createExec();
		const result = await tools.memory_write.execute({ target: "long_term", content: "User likes cats" }, exec);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(content.includes("User likes cats"));
		assert.ok(content.includes("<!-- "));
		assert.ok(result.text.includes("Appended to MEMORY.md"));
		assert.ok(result.text.includes("MEMORY.md was empty"));
		assert.equal(result.details.target, "long_term");
		assert.equal(result.details.mode, "append");
	});

	it("appends to existing MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Existing content", "utf-8");
		const result = await tools.memory_write.execute({ target: "long_term", content: "New fact" }, createExec());
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(content.includes("Existing content"));
		assert.ok(content.includes("New fact"));
		assert.ok(result.text.includes("Existing MEMORY.md preview"));
		assert.ok(result.text.includes("Existing content"));
	});

	it("overwrites MEMORY.md", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old content", "utf-8");
		const result = await tools.memory_write.execute(
			{ target: "long_term", content: "Brand new", mode: "overwrite" },
			createExec(),
		);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(content.includes("Brand new"));
		assert.ok(!content.includes("Old content"));
		assert.ok(content.includes("<!-- last updated:"));
		assert.equal(result.details.mode, "overwrite");
	});

	it("appends to daily log", async () => {
		const result = await tools.memory_write.execute({ target: "daily", content: "Did some work" }, createExec());
		const today = todayStr();
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		assert.ok(content.includes("Did some work"));
		assert.ok(result.text.includes("Appended to daily log"));
		assert.equal(result.details.target, "daily");
	});

	it("appends to existing daily log", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Morning entry", "utf-8");
		await tools.memory_write.execute({ target: "daily", content: "Afternoon entry" }, createExec());
		const content = fs.readFileSync(path.join(tmpDir, "daily", `${today}.md`), "utf-8");
		assert.ok(content.includes("Morning entry"));
		assert.ok(content.includes("Afternoon entry"));
	});

	it("includes session ID in metadata comment", async () => {
		const exec = createExec("mysession12345678");
		await tools.memory_write.execute({ target: "long_term", content: "Test" }, exec);
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(content.includes("[mysessio]")); // first 8 chars
	});

	it("includes timestamp in metadata comment", async () => {
		await tools.memory_write.execute({ target: "long_term", content: "Test" }, createExec());
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		// Should have a timestamp like "2026-02-15 10:30:00"
		assert.match(content, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
	});

	it("default mode is append", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Old", "utf-8");
		const result = await tools.memory_write.execute({ target: "long_term", content: "New" }, createExec());
		const content = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(content.includes("Old"));
		assert.ok(content.includes("New"));
		assert.equal(result.details.mode, "append");
	});
});

// ---------------------------------------------------------------------------
// 6. Tool: scratchpad
// ---------------------------------------------------------------------------

describe("scratchpad tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = registerPlugin().tools;
	});

	afterEach(cleanupTmpDir);

	it("registers with correct name", () => {
		assert.ok(tools.scratchpad);
		assert.equal(tools.scratchpad.name, "scratchpad");
	});

	it("list on empty scratchpad", async () => {
		const result = await tools.scratchpad.execute({ action: "list" }, createExec());
		assert.equal(result.text, "Scratchpad is empty.");
	});

	it("add item", async () => {
		const result = await tools.scratchpad.execute({ action: "add", text: "Fix login bug" }, createExec());
		assert.ok(result.text.includes("- [ ] Fix login bug"));
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		assert.ok(content.includes("Fix login bug"));
		assert.ok(content.includes("[ ]"));
	});

	it("add without text throws", async () => {
		await assert.rejects(tools.scratchpad.execute({ action: "add" }, createExec()), /'text' is required/);
	});

	it("done marks item as checked", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Fix login bug" }, exec);
		const result = await tools.scratchpad.execute({ action: "done", text: "login" }, exec);
		assert.ok(result.text.includes("Updated"));
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		assert.ok(content.includes("[x]"));
	});

	it("done matches by case-insensitive substring", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Fix Login Bug" }, exec);
		const result = await tools.scratchpad.execute({ action: "done", text: "LOGIN" }, exec);
		assert.ok(result.text.includes("Updated"));
	});

	it("done without text throws", async () => {
		await assert.rejects(tools.scratchpad.execute({ action: "done" }, createExec()), /'text' is required/);
	});

	it("done with no matching item", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Fix bug" }, exec);
		await assert.rejects(tools.scratchpad.execute({ action: "done", text: "nonexistent" }, exec), /No matching/);
	});

	it("done on already-done item finds no match", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Task" }, exec);
		await tools.scratchpad.execute({ action: "done", text: "Task" }, exec);
		await assert.rejects(tools.scratchpad.execute({ action: "done", text: "Task" }, exec), /No matching open item/);
	});

	it("undo unchecks a done item", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Task to undo" }, exec);
		await tools.scratchpad.execute({ action: "done", text: "undo" }, exec);
		const result = await tools.scratchpad.execute({ action: "undo", text: "undo" }, exec);
		assert.ok(result.text.includes("Updated"));
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		assert.ok(content.includes("[ ]"));
		assert.ok(!content.includes("[x]"));
	});

	it("undo without text throws", async () => {
		await assert.rejects(tools.scratchpad.execute({ action: "undo" }, createExec()), /'text' is required/);
	});

	it("undo on open item finds no match", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Open task" }, exec);
		await assert.rejects(
			tools.scratchpad.execute({ action: "undo", text: "Open task" }, exec),
			/No matching done item/,
		);
	});

	it("clear_done removes checked items", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Keep this" }, exec);
		await tools.scratchpad.execute({ action: "add", text: "Remove this" }, exec);
		await tools.scratchpad.execute({ action: "done", text: "Remove" }, exec);
		const result = await tools.scratchpad.execute({ action: "clear_done" }, exec);
		assert.ok(result.text.includes("Cleared 1 done item(s)"));
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		assert.ok(content.includes("Keep this"));
		assert.ok(!content.includes("Remove this"));
	});

	it("clear_done with no done items", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Open" }, exec);
		const result = await tools.scratchpad.execute({ action: "clear_done" }, exec);
		assert.ok(result.text.includes("Cleared 0 done item(s)"));
	});

	it("list shows all items with counts", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Open 1" }, exec);
		await tools.scratchpad.execute({ action: "add", text: "Open 2" }, exec);
		await tools.scratchpad.execute({ action: "add", text: "Will be done" }, exec);
		await tools.scratchpad.execute({ action: "done", text: "Will be done" }, exec);
		const result = await tools.scratchpad.execute({ action: "list" }, exec);
		assert.equal(result.details.count, 3);
		assert.equal(result.details.open, 2);
	});

	it("done only matches first matching item", async () => {
		const exec = createExec();
		await tools.scratchpad.execute({ action: "add", text: "Fix bug A" }, exec);
		await tools.scratchpad.execute({ action: "add", text: "Fix bug B" }, exec);
		await tools.scratchpad.execute({ action: "done", text: "Fix bug" }, exec);
		const content = fs.readFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "utf-8");
		// Only first match should be done
		const items = parseScratchpad(content);
		assert.equal(items[0].done, true);
		assert.equal(items[1].done, false);
	});
});

// ---------------------------------------------------------------------------
// 7. Tool: memory_read
// ---------------------------------------------------------------------------

describe("memory_read tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		tools = registerPlugin().tools;
	});

	afterEach(cleanupTmpDir);

	it("registers with correct name", () => {
		assert.ok(tools.memory_read);
		assert.equal(tools.memory_read.name, "memory_read");
	});

	// -- long_term --

	it("read long_term when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "My memories", "utf-8");
		const result = await tools.memory_read.execute({ target: "long_term" }, createExec());
		assert.equal(result.text, "My memories");
	});

	it("read long_term when file does not exist", async () => {
		const result = await tools.memory_read.execute({ target: "long_term" }, createExec());
		assert.ok(result.text.includes("empty or does not exist"));
	});

	it("read long_term when file is empty", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "", "utf-8");
		const result = await tools.memory_read.execute({ target: "long_term" }, createExec());
		// readFileSafe returns "" which is falsy, so treated as missing
		assert.ok(result.text.includes("empty or does not exist"));
	});

	// -- scratchpad --

	it("read scratchpad when file exists", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Task\n", "utf-8");
		const result = await tools.memory_read.execute({ target: "scratchpad" }, createExec());
		assert.ok(result.text.includes("Task"));
	});

	it("read scratchpad when empty", async () => {
		const result = await tools.memory_read.execute({ target: "scratchpad" }, createExec());
		assert.ok(result.text.includes("empty or does not exist"));
	});

	it("read scratchpad when whitespace only", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "   \n  ", "utf-8");
		const result = await tools.memory_read.execute({ target: "scratchpad" }, createExec());
		assert.ok(result.text.includes("empty or does not exist"));
	});

	// -- daily --

	it("read daily defaults to today", async () => {
		const today = todayStr();
		fs.writeFileSync(path.join(tmpDir, "daily", `${today}.md`), "Today's log", "utf-8");
		const result = await tools.memory_read.execute({ target: "daily" }, createExec());
		assert.equal(result.text, "Today's log");
		assert.equal(result.details.date, today);
	});

	it("read daily with specific date", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-01-01.md"), "New year log", "utf-8");
		const result = await tools.memory_read.execute({ target: "daily", date: "2026-01-01" }, createExec());
		assert.equal(result.text, "New year log");
	});

	it("read daily when file does not exist", async () => {
		const result = await tools.memory_read.execute({ target: "daily", date: "1999-01-01" }, createExec());
		assert.ok(result.text.includes("No daily log for 1999-01-01"));
	});

	it("read daily rejects path traversal in date", async () => {
		const outsideBase = path.join(
			os.tmpdir(),
			`pi-memory-outside-${Date.now()}-${Math.random().toString(16).slice(2)}`,
		);
		const outsideFile = `${outsideBase}.md`;
		fs.writeFileSync(outsideFile, "TOP SECRET", "utf-8");

		try {
			await assert.rejects(
				tools.memory_read.execute({ target: "daily", date: `../../${path.basename(outsideBase)}` }, createExec()),
				/Invalid date format/,
			);
		} finally {
			fs.rmSync(outsideFile, { force: true });
		}
	});

	// -- list --

	it("list daily logs when multiple exist", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-14.md"), "b", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-13.md"), "c", "utf-8");
		const result = await tools.memory_read.execute({ target: "list" }, createExec());
		assert.ok(result.text.includes("2026-02-15.md"));
		assert.ok(result.text.includes("2026-02-14.md"));
		assert.ok(result.text.includes("2026-02-13.md"));
		assert.equal(result.details.files.length, 3);
		// Should be reverse sorted (newest first)
		assert.equal(result.details.files[0], "2026-02-15.md");
	});

	it("list daily logs when none exist", async () => {
		const result = await tools.memory_read.execute({ target: "list" }, createExec());
		assert.ok(result.text.includes("No daily logs found"));
	});

	it("list ignores non-md files", async () => {
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-02-15.md"), "a", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "daily", "notes.txt"), "b", "utf-8");
		const result = await tools.memory_read.execute({ target: "list" }, createExec());
		assert.equal(result.details.files.length, 1);
	});
});

// ---------------------------------------------------------------------------
// 8. Tool: memory_search / memory_status + qmd diagnostics
// ---------------------------------------------------------------------------

describe("runQmdSearch qmd diagnostics", () => {
	afterEach(() => {
		_resetExecFileForTest();
	});

	it("strips qmd spinner control sequences from stderr failures", async () => {
		_setExecFileForTest((_file, _args, _opts, cb) => {
			cb(
				new Error("Command failed: qmd vsearch"),
				"",
				"\u001b[?25l\u001b[?25h\u001b[2K\u001b[1A\u001b[Greal diagnostic",
			);
		});

		await assert.rejects(runQmdSearch("semantic", "query", 5), /real diagnostic/);
	});

	it("strips qmd spinner control sequences from the fallback error message", async () => {
		const spinner = "\u001b[?25l\u001b[?25h";
		const commandError = new Error(`Command failed: qmd vsearch\n${spinner}`);
		_setExecFileForTest((_file, _args, _opts, cb) => {
			cb(commandError, "", spinner);
		});

		let failure;
		try {
			await runQmdSearch("semantic", "query", 5);
		} catch (err) {
			failure = err;
		}

		assert.ok(failure instanceof Error);
		assert.ok(failure.message.includes("Command failed: qmd vsearch"));
		assert.ok(!failure.message.includes("\u001b"));
	});

	it("uses the configured qmd search timeout in execution and diagnostics", async () => {
		const previousTimeout = process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
		process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = "90000";
		let observedTimeout;
		try {
			const timeoutErr = Object.assign(new Error("Command failed: qmd vsearch"), { killed: true });
			_setExecFileForTest((_file, _args, opts, cb) => {
				observedTimeout = opts.timeout;
				cb(timeoutErr, "", "\u001b[?25l\u001b[?25h");
			});

			await assert.rejects(runQmdSearch("semantic", "query", 5), /qmd timed out after 90s/);
			assert.equal(observedTimeout, 90_000);
		} finally {
			if (previousTimeout === undefined) delete process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS;
			else process.env.PI_MEMORY_QMD_SEARCH_TIMEOUT_MS = previousTimeout;
		}
	});

	it("removes FORCE_COLOR and sets NO_COLOR for qmd child processes", () => {
		const env = buildQmdEnv({ FORCE_COLOR: "3", NO_COLOR: undefined, PATH: "bin" });

		assert.equal(env.FORCE_COLOR, undefined);
		assert.equal(env.NO_COLOR, "1");
		assert.equal(env.PATH, "bin");
	});
});

describe("getQmdSearchTimeoutMs", () => {
	it("accepts positive integer milliseconds and defaults invalid values", () => {
		assert.equal(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "90000" }), 90_000);
		assert.equal(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0.5" }), 60_000);
		assert.equal(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "0" }), 60_000);
		assert.equal(getQmdSearchTimeoutMs({ PI_MEMORY_QMD_SEARCH_TIMEOUT_MS: "invalid" }), 60_000);
	});
});

describe("memory_search tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		tools = registerPlugin().tools;
	});

	afterEach(cleanupTmpDir);

	it("registers with correct name", () => {
		assert.ok(tools.memory_search);
		assert.equal(tools.memory_search.name, "memory_search");
	});

	it("throws with setup instructions when qmd not fully configured", async () => {
		const execStub = (...args) => {
			const callback = args[args.length - 1];
			callback(new Error("qmd not found"), "", "");
		};
		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		try {
			await assert.rejects(tools.memory_search.execute({ query: "test" }, createExec()), /qmd/);
		} finally {
			_resetExecFileForTest();
		}
	});

	it("defaults mode to keyword and limit to 5", () => {
		const desc = tools.memory_search.description;
		assert.ok(desc.includes("keyword"));
		assert.ok(desc.includes("semantic"));
		assert.ok(desc.includes("deep"));
	});
});

describe("memory_status tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		tools = registerPlugin().tools;
	});

	afterEach(() => {
		_resetExecFileForTest();
		cleanupTmpDir();
	});

	it("registers with correct name", () => {
		assert.ok(tools.memory_status);
		assert.equal(tools.memory_status.name, "memory_status");
	});

	it("reports file inventory and qmd-unavailable state without throwing", async () => {
		const execStub = (...args) => {
			const callback = args[args.length - 1];
			callback(new Error("qmd not found"), "", "");
		};
		_setExecFileForTest(execStub);
		_setQmdAvailable(false);

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "remember this");

		const result = await tools.memory_status.execute({}, createExec());
		assert.ok(result.text.includes("Memory status"));
		assert.ok(result.text.includes("qmd available: ✗"));
		assert.equal(result.details.qmd, false);
		assert.ok(result.details.longTermChars > 0);
	});
});

// ---------------------------------------------------------------------------
// 9. Lifecycle adapters (dsh mapping)
// ---------------------------------------------------------------------------

describe("lifecycle hooks", () => {
	let mock;
	const prevExitSummary = process.env.PI_MEMORY_EXIT_SUMMARY;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		_resetMemorySnapshot();
		// Exit-summary tests must run with summaries ENABLED regardless of any
		// ambient PI_MEMORY_EXIT_SUMMARY in the calling shell.
		delete process.env.PI_MEMORY_EXIT_SUMMARY;
		mock = registerPlugin();
	});

	afterEach(() => {
		if (prevExitSummary === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY;
		else process.env.PI_MEMORY_EXIT_SUMMARY = prevExitSummary;
		cleanupTmpDir();
	});

	it("registers all adapted lifecycle listeners", () => {
		assert.ok(mock.hooks["agent/session-start"]);
		assert.ok(mock.hooks["agent/disposed"]);
		assert.ok(mock.hooks["agent/pre-step"]);
		assert.ok(mock.hooks["session/event"]);
	});

	it("registers the memory context as a system-prompt section", () => {
		const section = mock.getSection();
		assert.ok(section);
		assert.equal(section.name, "pi-memory:memory-context");
		assert.ok(section.order >= 900);
	});

	// -- context injection (before_agent_start → buildInjectedSectionText) --

	it("returns empty string when no memory files", () => {
		assert.equal(buildInjectedSectionText(), "");
	});

	it("injects memory into the section text", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Remember this", "utf-8");
		const text = buildInjectedSectionText();
		assert.ok(text.includes("Remember this"));
		assert.ok(text.includes("## Memory"));
	});

	it("includes usage instructions", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Some memory", "utf-8");
		const text = buildInjectedSectionText();
		assert.ok(text.includes("memory_write"));
		assert.ok(text.includes("memory_search"));
		assert.ok(text.includes("scratchpad"));
	});

	// -- session_shutdown → handleSessionShutdown --

	it("clears the update timer", async () => {
		_setQmdAvailable(true);
		scheduleQmdUpdate();
		assert.notEqual(_getUpdateTimer(), null);
		await handleSessionShutdown(createMockCtx().ctx, createMockAgent());
		assert.equal(_getUpdateTimer(), null);
	});

	it("is safe when no timer exists", async () => {
		_clearUpdateTimer();
		// Should not throw
		await handleSessionShutdown(createMockCtx().ctx, createMockAgent());
	});

	it("writes nothing when the llm service is unavailable", async () => {
		// The dsh headless flow never reaches agent/disposed with a live llm
		// service; when it does not, the summary must degrade to a no-op.
		await handleSessionShutdown(createMockCtx().ctx, createMockAgent("abcdef1234567890", fourMessageSession()));
		assert.equal(fs.existsSync(dailyPath(todayStr())), false);
	});

	it("skips the summary entirely when disabled", async () => {
		const prev = process.env.PI_MEMORY_EXIT_SUMMARY;
		process.env.PI_MEMORY_EXIT_SUMMARY = "0";
		try {
			const mockCtx = createMockCtx();
			let streamCalled = false;
			mockCtx.ctx.get = (svc) => {
				if (svc === "llm")
					return {
						stream() {
							streamCalled = true;
							throw new Error("should not be called");
						},
					};
				return null;
			};
			await handleSessionShutdown(mockCtx.ctx, createMockAgent("abcdef1234567890", fourMessageSession()));
			assert.equal(streamCalled, false);
			assert.equal(fs.existsSync(dailyPath(todayStr())), false);
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY;
			else process.env.PI_MEMORY_EXIT_SUMMARY = prev;
		}
	});

	it("skips trivial sessions without attempting a summary", async () => {
		const mockCtx = createMockCtx();
		let streamCalled = false;
		mockCtx.ctx.get = (svc) => {
			if (svc === "llm")
				return {
					stream() {
						streamCalled = true;
						throw new Error("should not be called");
					},
				};
			return null;
		};
		// 2 messages only — below the curated-write gate
		await handleSessionShutdown(
			mockCtx.ctx,
			createMockAgent("abcdef1234567890", [textMessage("user", "ls"), textMessage("assistant", "file.txt")]),
		);
		assert.equal(streamCalled, false);
		assert.equal(fs.existsSync(dailyPath(todayStr())), false);
	});

	it("persists a real summary from the llm stream to today's daily log", async () => {
		const mockCtx = createMockCtx();
		mockCtx.ctx.get = (svc) => {
			if (svc === "llm")
				return {
					stream() {
						return (async function* () {
							yield { type: "text-delta", index: 0, text: "### Decisions\n- Use SQLite.\n" };
							yield { type: "text-delta", index: 0, text: "### Notes\n- Config migrated.\n" };
							yield { type: "finish", reason: { kind: "stop" } };
						})();
					},
				};
			return null;
		};

		await handleSessionShutdown(mockCtx.ctx, createMockAgent("abcdef1234567890", fourMessageSession()));

		const content = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		assert.ok(content.includes("## Session Summary (auto, exit: session-end)"));
		assert.ok(content.includes("Use SQLite."));
	});

	it("stays responsive when summary generation hangs (self-imposed timeout)", async () => {
		const prev = process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
		process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "50";
		const mockCtx = createMockCtx();
		mockCtx.ctx.get = (svc) => {
			if (svc === "llm")
				return {
					stream() {
						return new Promise(() => {}); // never resolves
					},
				};
			return null;
		};
		try {
			await handleSessionShutdown(mockCtx.ctx, createMockAgent("abcdef1234567890", fourMessageSession()));
			assert.equal(fs.existsSync(dailyPath(todayStr())), false);
		} finally {
			if (prev === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
			else process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = prev;
		}
	});

	// -- session_before_compact → handlePreCompact --

	it("appends handoff when scratchpad has open items", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n- [ ] Follow up", "utf-8");
		await handlePreCompact("abcdef1234567890");
		const content = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		assert.ok(content.includes("Session Handoff"));
		assert.ok(content.includes("Follow up"));
	});

	it("does not write anything when no memory content", async () => {
		await handlePreCompact("abcdef1234567890");
		assert.equal(fs.existsSync(dailyPath(todayStr())), false);
	});

	it("writes the handoff with a session-id stamp", async () => {
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "- [ ] Task", "utf-8");
		await handlePreCompact("abcdef1234567890");
		const content = fs.readFileSync(dailyPath(todayStr()), "utf-8");
		assert.ok(content.includes("[abcdef12]"));
	});
});

// -- exit summary configurability --

describe("exit summary configurability", () => {
	let savedEnabled;
	let savedModel;
	beforeEach(() => {
		savedEnabled = process.env.PI_MEMORY_EXIT_SUMMARY;
		savedModel = process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
		// Run with summaries enabled regardless of ambient shell env.
		delete process.env.PI_MEMORY_EXIT_SUMMARY;
	});
	afterEach(() => {
		if (savedEnabled === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY;
		else process.env.PI_MEMORY_EXIT_SUMMARY = savedEnabled;
		if (savedModel === undefined) delete process.env.PI_MEMORY_EXIT_SUMMARY_MODEL;
		else process.env.PI_MEMORY_EXIT_SUMMARY_MODEL = savedModel;
	});

	it("PI_MEMORY_EXIT_SUMMARY=off (and other aliases) disable", () => {
		for (const value of ["off", "false", "no"]) {
			process.env.PI_MEMORY_EXIT_SUMMARY = value;
			assert.equal(isExitSummaryEnabled(), false);
		}
		delete process.env.PI_MEMORY_EXIT_SUMMARY;
		assert.equal(isExitSummaryEnabled(), true);
	});

	it("PI_MEMORY_EXIT_SUMMARY_MODEL routes the summary to the configured model", async () => {
		process.env.PI_MEMORY_EXIT_SUMMARY_MODEL = "anthropic/claude-haiku-4";
		const mockCtx = createMockCtx();
		let observed;
		mockCtx.ctx.get = (svc) => {
			if (svc === "llm")
				return {
					stream(opts) {
						observed = { provider: opts.provider, model: opts.model };
						return (async function* () {
							yield { type: "text-delta", index: 0, text: "### Notes\n- x\n" };
							yield { type: "finish", reason: { kind: "stop" } };
						})();
					},
				};
			return null;
		};
		await handleSessionShutdown(mockCtx.ctx, createMockAgent("abcdef1234567890", fourMessageSession()));
		assert.deepEqual(observed, { provider: "anthropic", model: "claude-haiku-4" });
	});

	it("falls back to the session model when the env override is absent", async () => {
		const mockCtx = createMockCtx();
		let observed;
		mockCtx.ctx.get = (svc) => {
			if (svc === "llm")
				return {
					stream(opts) {
						observed = { provider: opts.provider, model: opts.model };
						return (async function* () {
							yield { type: "text-delta", index: 0, text: "### Notes\n- x\n" };
							yield { type: "finish", reason: { kind: "stop" } };
						})();
					},
				};
			return null;
		};
		await handleSessionShutdown(mockCtx.ctx, createMockAgent("abcdef1234567890", fourMessageSession()));
		assert.deepEqual(observed, { provider: "openai", model: "gpt-4o-mini" });
	});

	it("getExitSummaryTimeoutMs parses env with fallback to default", () => {
		delete process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS;
		assert.equal(getExitSummaryTimeoutMs(), 10_000);
		process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "250";
		assert.equal(getExitSummaryTimeoutMs(), 250);
		process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "not-a-number";
		assert.equal(getExitSummaryTimeoutMs(), 10_000);
		process.env.PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS = "-5";
		assert.equal(getExitSummaryTimeoutMs(), 10_000);
	});
});

describe("isExitSummaryEmpty", () => {
	it("treats all-None summaries as empty", () => {
		const summary = [
			"### Decisions",
			"- None.",
			"### Lessons Learned",
			"- None.",
			"### Notes",
			"- None.",
			"### Follow-ups",
			"- None.",
		].join("\n");
		assert.equal(isExitSummaryEmpty(summary), true);
	});

	it("tolerates formatting variations (bullets, case, missing period)", () => {
		assert.equal(isExitSummaryEmpty("### Decisions\nNone\n### Notes\n* none."), true);
		assert.equal(isExitSummaryEmpty("None."), true);
		assert.equal(isExitSummaryEmpty("### Decisions\n### Notes"), true);
	});

	it("keeps summaries with any real content", () => {
		const summary = [
			"### Decisions",
			"- None.",
			"### Lessons Learned",
			"- None.",
			"### Notes",
			"- User prefers dark mode.",
			"### Follow-ups",
			"- None.",
		].join("\n");
		assert.equal(isExitSummaryEmpty(summary), false);
		assert.equal(isExitSummaryEmpty("### Notes\n- Discussed None. vs null semantics"), false);
	});
});

describe("renderConversationFromSession", () => {
	it("renders user/assistant text and tool records in order", () => {
		const events = [
			textMessage("user", "remember this"),
			textMessage("assistant", "noted"),
			{ type: "tool/call", data: { name: "memory_write", arguments: '{"target":"long_term"}' } },
			{ type: "tool/result", data: { message: { content: [{ type: "text", text: "Appended" }] } } },
		];
		const { text, messageCount } = renderConversationFromSession({ events });
		assert.equal(messageCount, 2);
		assert.ok(text.includes("user: remember this"));
		assert.ok(text.includes("assistant: noted"));
		assert.ok(text.includes("tool: memory_write"));
		assert.ok(text.includes("tool result: Appended"));
	});

	it("ignores non-text content blocks", () => {
		const events = [
			{ type: "user/message", data: { content: [{ type: "image", attachment: {} }] } },
			{ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "think" }] } } },
		];
		const { text, messageCount } = renderConversationFromSession({ events });
		assert.equal(messageCount, 0);
		assert.equal(text, "");
	});
});

describe("streamTextCompletion", () => {
	it("collects text deltas and stops at a normal finish", async () => {
		const ctx = {
			get(svc) {
				return svc === "llm"
					? {
							stream() {
								return (async function* () {
									yield { type: "text-delta", index: 0, text: "Hello " };
									yield { type: "text-delta", index: 0, text: "world" };
									yield { type: "finish", reason: { kind: "stop" } };
								})();
							},
						}
					: null;
			},
		};
		const text = await streamTextCompletion(ctx, { provider: "p", model: "m" }, "sys", "prompt");
		assert.equal(text, "Hello world");
	});

	it("throws on an error finish", async () => {
		const ctx = {
			get(svc) {
				return svc === "llm"
					? {
							stream() {
								return (async function* () {
									yield { type: "finish", reason: { kind: "error", failure: { message: "boom" } } };
								})();
							},
						}
					: null;
			},
		};
		await assert.rejects(streamTextCompletion(ctx, { provider: "p", model: "m" }, "sys", "prompt"), /boom/);
	});
});

describe("generateExitSummary", () => {
	it("returns an error result when no model is configured", async () => {
		const ctx = createMockCtx().ctx;
		const agent = { session: { id: "s", events: fourMessageSession() }, options: {} };
		const result = await generateExitSummary(ctx, agent);
		assert.equal(result.summary, null);
		assert.ok(result.error);
		assert.equal(result.hasMessages, true);
	});
});

// ---------------------------------------------------------------------------
// 10. KV cache stability: memory snapshot
// ---------------------------------------------------------------------------

describe("KV cache stability: memory snapshot", () => {
	const prevSnapshotEnv = process.env.PI_MEMORY_SNAPSHOT;
	const prevNoSearchEnv = process.env.PI_MEMORY_NO_SEARCH;

	beforeEach(() => {
		setupTmpDir();
		ensureDirs();
		_setQmdAvailable(false);
		_resetMemorySnapshot();
		// Default to stable mode for these tests; per-turn test overrides locally.
		delete process.env.PI_MEMORY_SNAPSHOT;
		// Avoid implicit search calls bleeding in.
		process.env.PI_MEMORY_NO_SEARCH = "1";
	});

	afterEach(() => {
		if (prevSnapshotEnv === undefined) delete process.env.PI_MEMORY_SNAPSHOT;
		else process.env.PI_MEMORY_SNAPSHOT = prevSnapshotEnv;
		if (prevNoSearchEnv === undefined) delete process.env.PI_MEMORY_NO_SEARCH;
		else process.env.PI_MEMORY_NO_SEARCH = prevNoSearchEnv;
		cleanupTmpDir();
	});

	it("byte-stable section text across turns despite mid-session file mutations", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Initial long-term content", "utf-8");
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts -->\n- [ ] initial item\n",
			"utf-8",
		);

		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("Initial long-term content"));

		// Mutate disk state mid-session (simulates external edits, scratchpad/daily writes via tools, etc.)
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "MUTATED long-term content XYZ", "utf-8");
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts2 -->\n- [ ] new mutated item\n",
			"utf-8",
		);
		fs.writeFileSync(dailyPath(todayStr()), "Brand new daily log mid-session", "utf-8");

		const result2 = buildInjectedSectionText();
		// The whole point: prompt must be byte-identical for KV cache.
		assert.equal(result2, result1);
		assert.ok(!result2.includes("MUTATED"));
		assert.ok(!result2.includes("Brand new daily log"));
	});

	it("handlePreCompact refreshes snapshot even when no handoff is written", async () => {
		// Snapshot captures an open scratchpad item plus some long-term content
		// so the post-refresh snapshot is still non-empty.
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Stable long-term content", "utf-8");
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n<!-- ts -->\n- [ ] stale item\n", "utf-8");
		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("stale item"));

		// User completes the item via scratchpad tool (does not mark dirty by design).
		fs.writeFileSync(path.join(tmpDir, "SCRATCHPAD.md"), "# Scratchpad\n\n<!-- ts -->\n- [x] stale item\n", "utf-8");

		// Compaction fires with no open scratchpad items and no daily log → empty handoff.
		await handlePreCompact("abcdef1234567890");

		// Next turn must reflect the new on-disk state because tool history was compacted away.
		const result2 = buildInjectedSectionText();
		assert.ok(result2);
		assert.ok(!result2.includes("stale item"));
		assert.ok(result2.includes("Stable long-term content"));
	});

	it("handlePreCompact refreshes snapshot so handoff is visible next turn", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "SCRATCHPAD.md"),
			"# Scratchpad\n\n<!-- ts -->\n- [ ] follow up later\n",
			"utf-8",
		);

		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("follow up later"));
		assert.ok(!result1.includes("Session Handoff"));

		await handlePreCompact("abcdef1234567890");

		const result2 = buildInjectedSectionText();
		assert.ok(result2.includes("Session Handoff"));
		// And it must now differ from the pre-compaction snapshot — that's the intentional cache boundary.
		assert.notEqual(result2, result1);
	});

	it("memory_write target=long_term marks snapshot dirty so next turn refreshes", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "OLD_FACT line", "utf-8");
		const mock = registerPlugin();

		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("OLD_FACT"));

		await mock.tools.memory_write.execute(
			{ target: "long_term", content: "NEW_FACT_ABOUT_X", mode: "append" },
			createExec(),
		);

		const result2 = buildInjectedSectionText();
		assert.ok(result2.includes("NEW_FACT_ABOUT_X"));
		// Snapshot did refresh, so previous bytes are no longer identical.
		assert.notEqual(result2, result1);
	});

	it("memory_write target=daily does NOT mark snapshot dirty (cache stays warm)", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Stable long-term content", "utf-8");
		const mock = registerPlugin();

		const result1 = buildInjectedSectionText();

		await mock.tools.memory_write.execute(
			{ target: "daily", content: "DAILY_NOTE_ABOUT_Y", mode: "append" },
			createExec(),
		);

		const result2 = buildInjectedSectionText();
		// Daily writes are echoed via tool-call args; snapshot must NOT churn.
		assert.equal(result2, result1);
		assert.ok(!result2.includes("DAILY_NOTE_ABOUT_Y"));
	});

	it("PI_MEMORY_SNAPSHOT=per-turn restores per-turn rebuild behavior", () => {
		process.env.PI_MEMORY_SNAPSHOT = "per-turn";
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "First content", "utf-8");

		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("First content"));

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "Second content REPLACED", "utf-8");

		const result2 = buildInjectedSectionText();
		assert.ok(result2.includes("Second content REPLACED"));
		assert.ok(!result2.includes("First content"));
	});

	it("handleSessionStart refreshes snapshot (resets module state across sessions)", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "session-1 content", "utf-8");
		const result1 = buildInjectedSectionText();
		assert.ok(result1.includes("session-1 content"));

		// Simulate a new session: file changes, then session_start fires before next turn.
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "session-2 content", "utf-8");
		_setExecFileForTest((_file, _args, _opts, cb) => {
			cb(new Error("not available"), "", "");
		});
		try {
			await handleSessionStart();
			const result2 = buildInjectedSectionText();
			assert.ok(result2.includes("session-2 content"));
			assert.ok(!result2.includes("session-1 content"));
		} finally {
			_resetExecFileForTest();
		}
	});

	it("snapshot caveat is included in stable mode header", () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "anything", "utf-8");
		const result = buildInjectedSectionText();
		// Reader-facing hint that ambient context may lag behind disk.
		assert.ok(result.toLowerCase().includes("snapshot"));
	});
});

// ---------------------------------------------------------------------------
// 11. Extension registration
// ---------------------------------------------------------------------------

describe("extension registration", () => {
	it("registers all 7 tools", () => {
		const mock = registerPlugin();
		assert.equal(Object.keys(mock.tools).length, 7);
		for (const name of [
			"memory_write",
			"memory_forget",
			"memory_restore",
			"memory_read",
			"scratchpad",
			"memory_search",
			"memory_status",
		]) {
			assert.ok(mock.tools[name], `missing tool ${name}`);
		}
	});

	it("tools have descriptions", () => {
		const mock = registerPlugin();
		for (const name of [
			"memory_write",
			"memory_forget",
			"memory_restore",
			"memory_read",
			"scratchpad",
			"memory_search",
			"memory_status",
		]) {
			assert.ok(mock.tools[name].description, `missing description for ${name}`);
		}
	});

	it("tools declare compiled JSON-Schema parameters and canonical output", () => {
		const mock = registerPlugin();
		for (const name of Object.keys(mock.tools)) {
			const def = mock.tools[name];
			assert.equal(def.parameters.type, "object", `${name} parameters must be a JSON-Schema object`);
			assert.ok(def.output, `${name} must declare output`);
			assert.equal(typeof def.output.render, "function");
			assert.equal(def.output.schema.type, "object");
		}
	});
});

// ---------------------------------------------------------------------------
// 12. Local calendar dates (regression: daily logs were keyed to UTC)
// ---------------------------------------------------------------------------

describe("local calendar dates", () => {
	const pad = (n) => String(n).padStart(2, "0");

	it("todayStr returns the LOCAL calendar date, not UTC", () => {
		const now = new Date();
		const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
		assert.equal(todayStr(), local);
	});

	it("yesterdayStr returns the LOCAL calendar date minus one day", () => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		assert.equal(yesterdayStr(), local);
	});

	it("nowTimestamp uses local date and local hour", () => {
		const now = new Date();
		const ts = nowTimestamp();
		assert.equal(ts.slice(0, 10), todayStr());
		// Tolerate the clock ticking across an hour boundary mid-test.
		const hour = Number(ts.slice(11, 13));
		assert.ok([now.getHours(), new Date().getHours()].includes(hour));
	});
});

// ---------------------------------------------------------------------------
// Line-preserving scratchpad mutations (regression: round-trip deleted
// any non-checklist content from SCRATCHPAD.md)
// ---------------------------------------------------------------------------

describe("line-preserving scratchpad mutations", () => {
	const file = [
		"# Scratchpad",
		"",
		"Hand-written note that must survive.",
		"",
		"## Ideas",
		"<!-- 2026-07-08 10:00:00 [abc12345] -->",
		"- [ ] fix the flaky test",
		"  extra detail under the item",
		"<!-- 2026-07-08 10:05:00 [abc12345] -->",
		"- [x] ship the release",
		"",
	].join("\n");

	it("scratchpadAdd appends and preserves all existing content", () => {
		const out = scratchpadAdd(file, "water the plants", "<!-- meta -->");
		assert.ok(out.includes("Hand-written note that must survive."));
		assert.ok(out.includes("## Ideas"));
		assert.ok(out.includes("  extra detail under the item"));
		assert.equal(out.endsWith("<!-- meta -->\n- [ ] water the plants\n"), true);
	});

	it("scratchpadAdd creates the standard skeleton for empty content", () => {
		const out = scratchpadAdd("", "first item", "<!-- meta -->");
		assert.ok(out.startsWith("# Scratchpad"));
		assert.ok(out.includes("- [ ] first item"));
	});

	it("scratchpadToggle flips only the matched item", () => {
		const { content, matched } = scratchpadToggle(file, "flaky", true);
		assert.equal(matched, true);
		assert.ok(content.includes("- [x] fix the flaky test"));
		assert.ok(content.includes("- [x] ship the release"));
		assert.ok(content.includes("Hand-written note that must survive."));
	});

	it("scratchpadToggle can uncheck a done item", () => {
		const { content, matched } = scratchpadToggle(file, "ship", false);
		assert.equal(matched, true);
		assert.ok(content.includes("- [ ] ship the release"));
	});

	it("scratchpadToggle reports no match honestly", () => {
		assert.equal(scratchpadToggle(file, "nonexistent", true).matched, false);
	});

	it("scratchpadClearDone removes done items and their meta, keeps the rest", () => {
		const { content, removed } = scratchpadClearDone(file);
		assert.equal(removed, 1);
		assert.ok(!content.includes("ship the release"));
		assert.ok(!content.includes("10:05:00"));
		assert.ok(content.includes("- [ ] fix the flaky test"));
		assert.ok(content.includes("Hand-written note that must survive."));
		assert.ok(content.includes("## Ideas"));
	});

	it("scratchpadClearDone preserves hand-written HTML comments", () => {
		const content = ["# Scratchpad", "", "<!-- Keep this deployment note. -->", "- [x] ship the release", ""].join(
			"\n",
		);
		const result = scratchpadClearDone(content);
		assert.equal(result.removed, 1);
		assert.ok(result.content.includes("<!-- Keep this deployment note. -->"));
	});
});

// ---------------------------------------------------------------------------
// clampSearchLimit (regression: NaN/0/negative/huge limits reached qmd -n)
// ---------------------------------------------------------------------------

describe("clampSearchLimit", () => {
	it("defaults when undefined or NaN", () => {
		assert.equal(clampSearchLimit(undefined), 5);
		assert.equal(clampSearchLimit(Number.NaN), 5);
	});

	it("clamps to the valid range and floors fractions", () => {
		assert.equal(clampSearchLimit(0), 1);
		assert.equal(clampSearchLimit(-3), 1);
		assert.equal(clampSearchLimit(3.7), 3);
		assert.equal(clampSearchLimit(9999), 25);
	});
});

// ---------------------------------------------------------------------------
// forgetBlocks + memory_forget (deletion as a first-class operation)
// ---------------------------------------------------------------------------

describe("forgetBlocks", () => {
	const file = [
		"Hand-written note about deployment.",
		"",
		"<!-- 2026-07-01 10:00:00 [abc] -->",
		"Balance is $12.69 #finance",
		"",
		"<!-- 2026-07-03 09:00:00 [def] -->",
		"Prefers dark mode #preference",
	].join("\n");

	it("removes the matching entry with its timestamp stamp", () => {
		const { content, removed } = forgetBlocks(file, "$12.69");
		assert.equal(removed.length, 1);
		assert.ok(removed[0].includes("Balance is $12.69"));
		assert.ok(removed[0].includes("2026-07-01"));
		assert.ok(!content.includes("$12.69"));
		assert.ok(content.includes("Prefers dark mode"));
		assert.ok(content.includes("Hand-written note about deployment."));
	});

	it("match is case-insensitive", () => {
		const { removed } = forgetBlocks(file, "DARK MODE");
		assert.equal(removed.length, 1);
	});

	it("removes multiple matching blocks", () => {
		const { content, removed } = forgetBlocks(file, "20");
		assert.equal(removed.length, 2); // both stamped entries contain 2026 dates
		assert.ok(content.includes("Hand-written note"));
	});

	it("removes an entire stamped entry when a later paragraph matches", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		assert.equal(removed.length, 1);
		assert.ok(removed[0].includes("Balance is $12.69"));
		assert.ok(removed[0].includes("Supporting detail"));
		assert.ok(!remaining.includes("Balance is $12.69"));
		assert.ok(!remaining.includes("Supporting detail"));
		assert.ok(remaining.includes("Prefers dark mode"));
	});

	it("preserves CRLF entry boundaries when removing a multi-paragraph entry", () => {
		const content = [
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\r\n");
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		assert.equal(removed.length, 1);
		assert.ok(removed[0].includes("Balance is $12.69"));
		assert.ok(removed[0].includes("Supporting detail"));
		assert.ok(!remaining.includes("Balance is $12.69"));
		assert.ok(remaining.includes("Prefers dark mode"));
	});

	it("recognizes the first generated entry when the file starts with a UTF-8 BOM", () => {
		const content = `\uFEFF${[
			"<!-- 2026-07-01 10:00:00 [abc] -->",
			"Balance is $12.69 #finance",
			"",
			"Supporting detail says this value is stale.",
			"",
			"<!-- 2026-07-03 09:00:00 [def] -->",
			"Prefers dark mode #preference",
		].join("\n")}`;
		const { content: remaining, removed } = forgetBlocks(content, "stale");
		assert.equal(removed.length, 1);
		assert.ok(removed[0].includes("Balance is $12.69"));
		assert.ok(!remaining.includes("Balance is $12.69"));
		assert.ok(remaining.includes("Prefers dark mode"));
	});

	it("no match leaves content untouched", () => {
		const { content, removed } = forgetBlocks(file, "nonexistent");
		assert.equal(removed.length, 0);
		assert.equal(content, file);
	});

	it("empty match removes nothing", () => {
		assert.equal(forgetBlocks(file, "  ").removed.length, 0);
	});

	it("removing the only entry empties the file", () => {
		const { content, removed } = forgetBlocks("only fact here\n", "only fact");
		assert.equal(removed.length, 1);
		assert.equal(content, "");
	});
});

describe("memory_forget tool", () => {
	let tools;

	beforeEach(() => {
		setupTmpDir();
		tools = registerPlugin().tools;
	});

	afterEach(cleanupTmpDir);

	it("registers with correct name", () => {
		assert.ok(tools.memory_forget);
	});

	it("removes matching entry from MEMORY.md and echoes it back", async () => {
		fs.writeFileSync(
			path.join(tmpDir, "MEMORY.md"),
			"<!-- ts [s] -->\nBalance is $12.69\n\nPrefers tabs over spaces\n",
			"utf-8",
		);
		const result = await tools.memory_forget.execute({ match: "$12.69" }, createExec());
		assert.ok(result.text.includes("Removed 1 entry"));
		assert.ok(result.text.includes("$12.69")); // recoverable echo
		const remaining = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(!remaining.includes("$12.69"));
		assert.ok(remaining.includes("Prefers tabs"));
	});

	it("reports no match without touching the file", async () => {
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "a fact\n", "utf-8");
		const result = await tools.memory_forget.execute({ match: "zzz" }, createExec());
		assert.ok(result.text.includes("No entries matching"));
		assert.equal(fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8"), "a fact\n");
	});

	it("targets a specific daily log by date", async () => {
		fs.mkdirSync(path.join(tmpDir, "daily"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "old wrong fact\n\nkeep me\n", "utf-8");
		const result = await tools.memory_forget.execute(
			{ match: "wrong fact", target: "daily", date: "2026-07-01" },
			createExec(),
		);
		assert.ok(result.text.includes("Removed 1 entry"));
		const remaining = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		assert.ok(remaining.includes("keep me"));
		assert.ok(!remaining.includes("wrong fact"));

		const restoreResult = await tools.memory_restore.execute({ recoveryId: result.details.recoveryId }, createExec());
		assert.ok(restoreResult.text.includes("Restored 1 entry"));
		const restored = fs.readFileSync(path.join(tmpDir, "daily", "2026-07-01.md"), "utf-8");
		assert.ok(restored.includes("wrong fact"));
		assert.ok(restored.includes("keep me"));
	});

	it("rejects empty match and bad dates", async () => {
		await assert.rejects(tools.memory_forget.execute({ match: "  " }, createExec()), /must not be empty/);
		await assert.rejects(
			tools.memory_forget.execute({ match: "x", target: "daily", date: "not-a-date" }, createExec()),
			/Invalid date format/,
		);
	});

	it("handles empty memory gracefully", async () => {
		const result = await tools.memory_forget.execute({ match: "x" }, createExec());
		assert.ok(result.text.includes("nothing to forget"));
	});

	it("rejects invalid recovery IDs without reading outside the recovery directory", async () => {
		await assert.rejects(
			tools.memory_restore.execute({ recoveryId: "../../MEMORY.md" }, createExec()),
			/No valid recovery record/,
		);
	});

	it("persists complete removed content and restores it by visible recovery ID", async () => {
		const longEntry = `<!-- 2026-07-01 10:00:00 [abc] -->\nwrong fact ${"x".repeat(4500)} recovery-tail`;
		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), longEntry, "utf-8");
		const forgetResult = await tools.memory_forget.execute({ match: "wrong fact" }, createExec());
		assert.ok(!forgetResult.text.includes("recovery-tail"));
		assert.ok(forgetResult.text.includes("memory_restore"));
		assert.ok(forgetResult.text.includes(forgetResult.details.recoveryId));

		const recoveryPath = path.join(tmpDir, "recovery", `${forgetResult.details.recoveryId}.json`);
		const recovery = JSON.parse(fs.readFileSync(recoveryPath, "utf-8"));
		assert.deepEqual(recovery.removedContent, [longEntry]);
		assert.equal(forgetResult.details.removedContent, undefined);

		fs.writeFileSync(path.join(tmpDir, "MEMORY.md"), "A later fact that must survive.\n", "utf-8");

		const restoreResult = await tools.memory_restore.execute(
			{ recoveryId: forgetResult.details.recoveryId },
			createExec(),
		);
		assert.ok(restoreResult.text.includes("Restored 1 entry"));
		const restoredMemory = fs.readFileSync(path.join(tmpDir, "MEMORY.md"), "utf-8");
		assert.ok(restoredMemory.includes("recovery-tail"));
		assert.ok(restoredMemory.includes("A later fact that must survive."));

		const secondRestore = await tools.memory_restore.execute(
			{ recoveryId: forgetResult.details.recoveryId },
			createExec(),
		);
		assert.ok(secondRestore.text.includes("already restored"));
	});
});
