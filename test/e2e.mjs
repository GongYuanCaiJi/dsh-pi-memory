// Ported from upstream pi-memory 0.4.2 test/e2e.ts.
//
// End-to-end tests for dsh-pi-memory. Runs a real `dsh` one-shot driver in a
// disposable profile and a disposable DSH_HOME, so it never touches your real
// profiles or memory files.
//
// Run:   npm run test:e2e
//
// Requirements:
//   - `dsh` CLI on PATH (npm install -g @deepseek-ai/dsh@next)
//   - A working model endpoint: a real DeepSeek API key
//     (DEEPSEEK_API_KEY) or the bundled mock (see mock-llm.mjs at the repo
//     root: node mock-llm.mjs && DEEPSEEK_BASE_URL=http://127.0.0.1:8099 ...)
//   - Optionally: `qmd` on PATH for the search tests
//
// What it tests:
//   1. Plugin loads and registers 7 tools
//   2. Memory context injection → LLM can answer from injected memory
//   3. Full round-trip: write in session 1, recall in session 2
//   4. Scratchpad add/done/list cycle
//   5. Daily log write
//   6. memory_search graceful behavior (qmd absent)
//   7–11. qmd-dependent: search results, no-results parsing, selective
//         injection, #tags/[[links]], handoff surfacing (skipped without qmd)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply, _clearUpdateTimer, _setBaseDir, _resetBaseDir } from "../index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXTENSION_PATH = path.resolve(import.meta.dirname ?? __dirname, "..", "index.js");
const TIMEOUT_MS = 120_000;

// Everything test-scoped lives under one temp root, cleaned up at the end.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-e2e-"));
const DSH_HOME = path.join(TMP, "dsh-home");
const MEMORY_DIR = path.join(TMP, "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const SCRATCHPAD_FILE = path.join(MEMORY_DIR, "SCRATCHPAD.md");
const DAILY_DIR = path.join(MEMORY_DIR, "daily");
const PROFILE = `verify-e2e-${Date.now()}`;

const BASE_ENV = {
	...process.env,
	DSH_HOME,
	PI_MEMORY_DIR: MEMORY_DIR,
	PI_MEMORY_EXIT_SUMMARY: "0",
	PI_MEMORY_QMD_UPDATE: "off",
};

// ---------------------------------------------------------------------------
// Test harness (upstream's local assert/test helpers, kept verbatim)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const errors = [];

function assert(condition, message) {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`);
	}
}

async function test(name, fn) {
	process.stdout.write(`  ${name} ... `);
	try {
		await fn();
		console.log("\x1b[32mPASS\x1b[0m");
		passed++;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log(`\x1b[31mFAIL\x1b[0m\n    ${msg}`);
		failed++;
		errors.push(`${name}: ${msg}`);
	}
}

/** Register the plugin against a mock ctx (tool-level tests, no dsh needed). */
function registeredTools() {
	const tools = {};
	const ctx = {
		tools: { register: (def) => ((tools[def.name] = def), () => {}) },
		on: () => () => {},
		inject: () => {},
		effect: () => () => {},
		get: () => null,
	};
	apply(ctx, {});
	return tools;
}

function toolExecutionContext(sessionId = "e2e-test") {
	return { agent: { session: { id: sessionId }, options: {} }, signal: new AbortController().signal };
}

async function runTool(name, params) {
	const tool = registeredTools()[name];
	assert(Boolean(tool), `${name} tool is not registered`);
	return await tool.execute(params, toolExecutionContext());
}

function toolResultText(result) {
	return typeof result.text === "string" ? result.text : "";
}

/** Run dsh headless in the disposable profile. */
function runDsh(prompt, opts = {}) {
	const timeout = opts.timeout ?? TIMEOUT_MS;
	let stdout = "";
	let stderr = "";
	let errorMessage = "";
	let exitCode = 0;
	try {
		stdout = execFileSync("dsh", ["--profile", PROFILE, prompt], {
			timeout,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			env: BASE_ENV,
		});
	} catch (err) {
		stdout = err.stdout ?? "";
		stderr = err.stderr ?? "";
		errorMessage = err.message ?? "";
		exitCode = err.status ?? 1;
	}
	return { exitCode, stdout, stderr, errorMessage };
}

function formatDshFailure(result, label = "dsh") {
	const parts = [`${label} exited with code ${result.exitCode}`];
	if (result.errorMessage) parts.push(`error:\n${result.errorMessage.slice(0, 2_000)}`);
	if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim().slice(0, 2_000)}`);
	if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim().slice(0, 2_000)}`);
	return parts.join("\n");
}

function assertDshExitedOk(result, label = "dsh") {
	assert(result.exitCode === 0, formatDshFailure(result, label));
}

function todayStr() {
	// The plugin keys daily logs by the LOCAL calendar day (not UTC) — the e2e
	// must look at the same date the tool wrote to. Upstream's toISOString()
	// helper was UTC and missed evening writes (pi-memory bug fixed upstream in
	// index.ts; this harness now matches the plugin's local-date semantics).
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function checkQmdAvailable() {
	try {
		execFileSync("qmd", ["status"], { stdio: "ignore", timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

function checkQmdCollection(name) {
	try {
		const stdout = execFileSync("qmd", ["collection", "list", "--json"], { encoding: "utf-8", timeout: 10_000 });
		try {
			const parsed = JSON.parse(stdout);
			if (Array.isArray(parsed)) return parsed.some((c) => c.name === name || c === name);
		} catch {
			// qmd 2.x prints a table even with --json — fall back to substring
			// matching, exactly like the plugin's checkCollection does.
		}
		return stdout.includes(name);
	} catch {
		return false;
	}
}

function runQmdUpdate() {
	try {
		execFileSync("qmd", ["update"], { stdio: "ignore", timeout: 30_000 });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testExtensionLoads() {
	const tools = Object.keys(registeredTools()).sort();
	const expected = [
		"memory_forget",
		"memory_read",
		"memory_restore",
		"memory_search",
		"memory_status",
		"memory_write",
		"scratchpad",
	];
	assert(tools.length === expected.length, `expected ${expected.length} tools, got ${tools.length}: ${tools.join(", ")}`);
	for (const name of expected) {
		assert(tools.includes(name), `${name} not registered. Got: ${tools.join(", ")}`);
	}
}

function testContextInjectionDirect() {
	fs.mkdirSync(MEMORY_DIR, { recursive: true });
	fs.writeFileSync(
		MEMORY_FILE,
		"<!-- test -->\n## Preferences\n- Favorite color: purple\n- Favorite food: sushi\n- Home city: Portland\n",
		"utf-8",
	);

	const result = runDsh(
		"Based on the memory context you have, what is the user's favorite color and favorite food? Answer with just the two values separated by a comma, nothing else.",
	);

	assertDshExitedOk(result);

	const text = result.stdout.toLowerCase();
	assert(text.includes("purple"), `Response does not mention "purple". Got: ${result.stdout.slice(0, 300)}`);
	assert(text.includes("sushi"), `Response does not mention "sushi". Got: ${result.stdout.slice(0, 300)}`);
}

async function testMemoryWriteAndRecall() {
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	// Session 1: the model calls memory_write through the real dsh tool pipeline.
	const writeResult = runDsh("Remember: User lives in Seattle. User's favorite drink is tea.");
	assertDshExitedOk(writeResult, "dsh (write)");

	const memoryContent = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, "utf-8") : "";
	assert(
		memoryContent.toLowerCase().includes("seattle"),
		`MEMORY.md does not contain "seattle". Content: ${memoryContent.slice(0, 300)}`,
	);

	// Session 2: brand new session — recall from injected memory context.
	const recallResult = runDsh(
		"Based on what you know from memory, answer: 1) Where does the user live? 2) What is the user's favorite drink? Answer with just the facts.",
	);

	assertDshExitedOk(recallResult, "dsh (recall)");

	const recallText = recallResult.stdout.toLowerCase();
	assert(
		recallText.includes("seattle"),
		`Recall does not mention "seattle". Got: ${recallResult.stdout.slice(0, 300)}`,
	);
	assert(recallText.includes("tea"), `Recall does not mention "tea". Got: ${recallResult.stdout.slice(0, 300)}`);
}

async function testScratchpadCycle() {
	if (fs.existsSync(SCRATCHPAD_FILE)) fs.unlinkSync(SCRATCHPAD_FILE);

	await runTool("scratchpad", { action: "add", text: "Fix the login bug" });

	const afterAdd = fs.existsSync(SCRATCHPAD_FILE) ? fs.readFileSync(SCRATCHPAD_FILE, "utf-8") : "";
	assert(afterAdd.includes("Fix the login bug"), `SCRATCHPAD.md missing item. Content: ${afterAdd.slice(0, 200)}`);
	assert(afterAdd.includes("[ ]"), "Item should be unchecked");

	await runTool("scratchpad", { action: "done", text: "login bug" });

	const afterDone = fs.readFileSync(SCRATCHPAD_FILE, "utf-8");
	assert(afterDone.includes("[x]"), "Item should be checked after done");

	const listResult = await runTool("scratchpad", { action: "list" });
	const listText = toolResultText(listResult).toLowerCase();
	assert(
		listText.includes("login bug"),
		`Scratchpad list should include item. Result: ${listText.slice(0, 300)}`,
	);
}

async function testDailyLog() {
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);

	fs.mkdirSync(DAILY_DIR, { recursive: true });
	if (fs.existsSync(dailyFile)) fs.unlinkSync(dailyFile);

	await runTool("memory_write", { target: "daily", content: "Worked on dsh-pi-memory extension today" });

	assert(fs.existsSync(dailyFile), `Daily log file not created: ${dailyFile}`);
	const content = fs.readFileSync(dailyFile, "utf-8");
	assert(content.includes("dsh-pi-memory extension"), `Daily log missing text. Content: ${content.slice(0, 200)}`);
}

async function testMemorySearchGraceful() {
	// No qmd on PATH: memory_search must surface the install instructions as an
	// error the model can see (dsh turns a thrown execute into isError).
	try {
		await runTool("memory_search", { query: "test query", mode: "keyword" });
		assert(false, "memory_search should have thrown without qmd");
	} catch (err) {
		assert(err instanceof Error, "expected an Error from memory_search");
		assert(/qmd/i.test(err.message), `expected qmd install instructions, got: ${err.message.slice(0, 200)}`);
	}
}

async function testMemorySearchWithQmd() {
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `QMD_E2E_TOKEN_${Date.now()}`;
	await runTool("memory_write", { target: "long_term", content: `Search token: ${token}` });

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed during search test");

	const searchResult = await runTool("memory_search", { query: token, mode: "keyword" });
	const searchText = toolResultText(searchResult);

	assert(
		searchText.toLowerCase().includes(token.toLowerCase()),
		`Search results did not mention token. Got: ${searchText.slice(0, 400)}`,
	);
	assert(
		searchText.includes("qmd://"),
		`Search results did not include a qmd file path. Got: ${searchText.slice(0, 400)}`,
	);
}

async function testMemorySearchNoResultsWithQmd() {
	const token = `QMD_E2E_NORESULT_${Date.now()}_${Math.random().toString(16).slice(2)}`;

	const searchResult = await runTool("memory_search", { query: token, mode: "keyword" });

	const text = toolResultText(searchResult).toLowerCase();
	assert(
		text.includes("no results found") && text.includes(token.toLowerCase()),
		`Expected no-results message mentioning token. Got: ${toolResultText(searchResult).slice(0, 400)}`,
	);
	assert(
		!text.includes("failed to parse qmd output") && !text.includes("memory_search error"),
		`Expected no parse error. Got: ${toolResultText(searchResult).slice(0, 400)}`,
	);
}

async function testSelectiveInjection() {
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `SELINJ_${Date.now()}`;
	await runTool("memory_write", {
		target: "long_term",
		content: `#decision [[database-choice]] We decided to use PostgreSQL (codename: ${token}) for all backend services.`,
	});

	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	// New session: per-turn selective injection requires PI_MEMORY_SNAPSHOT=per-turn.
	const recallResult = runDsh(
		"Based on the context you have available, what database was chosen for backend services? Just state the database name and codename. Do NOT use any tools.",
		{ envExtra: { PI_MEMORY_SNAPSHOT: "per-turn" } },
	);
	assertDshExitedOk(recallResult, "dsh (recall)");

	const text = recallResult.stdout.toLowerCase();
	assert(
		text.includes("postgresql") || text.includes(token.toLowerCase()),
		`Recall did not mention PostgreSQL or token. Got: ${recallResult.stdout.slice(0, 400)}`,
	);
}

async function testTagsInSearch() {
	if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);

	const token = `TAG_${Date.now()}`;
	await runTool("memory_write", {
		target: "long_term",
		content: `#preference [[editor-choice]] Always use vim for editing (ref: ${token}).`,
	});
	const updated = runQmdUpdate();
	assert(updated, "qmd update failed");

	const tagResult = await runTool("memory_search", { query: "#preference", mode: "keyword" });
	const tagText = toolResultText(tagResult);
	assert(
		tagText.includes(token) || tagText.toLowerCase().includes("vim"),
		`Tag search did not find the entry. Got: ${tagText.slice(0, 400)}`,
	);

	const linkResult = await runTool("memory_search", { query: "editor-choice", mode: "keyword" });
	const linkText = toolResultText(linkResult);
	assert(
		linkText.includes(token) || linkText.toLowerCase().includes("vim"),
		`Wiki-link search did not find the entry. Got: ${linkText.slice(0, 400)}`,
	);
}

function testHandoffSurvivesToNextSession() {
	const today = todayStr();
	const dailyFile = path.join(DAILY_DIR, `${today}.md`);
	fs.mkdirSync(DAILY_DIR, { recursive: true });

	const token = `HANDOFF_${Date.now()}`;
	const handoff = [
		"<!-- HANDOFF 2025-01-01 00:00:00 [testtest] -->",
		"## Session Handoff",
		"**Open scratchpad items:**",
		`- [ ] Complete the ${token} migration`,
		"**Recent daily log context:**",
		"Refactored auth module",
	].join("\n");

	fs.writeFileSync(dailyFile, handoff, "utf-8");

	const result = runDsh(
		"Based on the context you have available, what migration task is open? Just state the task name. Do NOT use any tools.",
	);
	assertDshExitedOk(result);

	const text = result.stdout.toLowerCase();
	assert(
		text.includes(token.toLowerCase()) || text.includes("migration"),
		`Handoff content not surfaced. Got: ${result.stdout.slice(0, 400)}`,
	);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("\n\x1b[1mdsh-pi-memory end-to-end tests\x1b[0m\n");

	if (!fs.existsSync(EXTENSION_PATH)) {
		console.error(`Extension not found at ${EXTENSION_PATH}`);
		process.exit(1);
	}
	console.log(`Extension: ${EXTENSION_PATH}`);
	console.log(`Memory dir: ${MEMORY_DIR}`);

	// Preflight: check dsh is available
	process.stdout.write("Preflight: checking dsh CLI ... ");
	try {
		const version = execFileSync("dsh", ["--version"], { encoding: "utf-8", env: BASE_ENV });
		console.log(`\x1b[32mOK\x1b[0m (${version.trim()})`);
	} catch (err) {
		console.log("\x1b[31mFAILED\x1b[0m");
		console.error("Ensure `dsh` is on PATH: npm install -g @deepseek-ai/dsh@next");
		process.exit(1);
	}

	// Set up the disposable profile: headless bundle + this plugin (tarball).
	console.log("Setting up disposable profile ...");
	fs.mkdirSync(DSH_HOME, { recursive: true });
	try {
		execFileSync("dsh", ["plugin", "--profile", PROFILE, "add", "@deepseek-ai/dsh-headless@next"], {
			env: BASE_ENV,
			stdio: "pipe",
		});
		const tarball = execFileSync("npm", ["pack", "--silent"], { encoding: "utf-8" }).trim().split("\n").pop();
		execFileSync("dsh", ["plugin", "--profile", PROFILE, "add", path.resolve(tarball)], { env: BASE_ENV, stdio: "pipe" });
		fs.unlinkSync(tarball);
	} catch (err) {
		console.error(`Failed to set up profile: ${err.message}`);
		process.exit(1);
	}

	// Tool-level tests run against a temp memory dir in-process.
	_setBaseDir(MEMORY_DIR);
	fs.mkdirSync(MEMORY_DIR, { recursive: true });

	// If qmd is available, point a pi-memory collection at the temp memory dir
	// so the qmd-dependent tests exercise the real search pipeline. Upstream
	// required a manual collection; automating it keeps the qmd path verifiable.
	const qmdAvailable = checkQmdAvailable();
	if (qmdAvailable) {
		try {
			// Remove any stale pi-memory collection from a previous run (it may
			// point at a deleted temp dir); --force on add does NOT re-point.
			execFileSync("qmd", ["collection", "remove", "pi-memory", "--force"], { stdio: "ignore", timeout: 15_000 });
		} catch {
			// No prior collection — fine.
		}
		try {
			execFileSync("qmd", ["collection", "add", MEMORY_DIR, "--name", "pi-memory", "--force"], {
				stdio: "ignore",
				timeout: 15_000,
			});
			execFileSync("qmd", ["context", "add", "/daily", "Daily append-only work logs organized by date", "-c", "pi-memory"], {
				stdio: "ignore",
				timeout: 15_000,
			});
			execFileSync("qmd", ["context", "add", "/", "Curated long-term memory: decisions, preferences, facts, lessons", "-c", "pi-memory"], {
				stdio: "ignore",
				timeout: 15_000,
			});
		} catch {
			// Collection setup is best-effort; tests degrade to "skipped" below.
		}
	}

	try {
		console.log("\n\x1b[1m1. Extension loading\x1b[0m");
		await test("extension registers 7 tools", testExtensionLoads);

		console.log("\n\x1b[1m2. Context injection (direct write)\x1b[0m");
		await test("LLM answers from injected memory context", testContextInjectionDirect);

		console.log("\n\x1b[1m3. Memory write + cross-session recall\x1b[0m");
		await test("write memory in session 1, recall in session 2", testMemoryWriteAndRecall);

		console.log("\n\x1b[1m4. Scratchpad lifecycle\x1b[0m");
		await test("add → done → list cycle", testScratchpadCycle);

		console.log("\n\x1b[1m5. Daily log\x1b[0m");
		await test("write daily log entry", testDailyLog);

		console.log("\n\x1b[1m6. Memory search\x1b[0m");
		await test("memory_search graceful behavior without qmd", testMemorySearchGraceful);

		const qmdCollection = qmdAvailable && checkQmdCollection("pi-memory");
		if (qmdAvailable && qmdCollection) {
			console.log("\n\x1b[1m7. Memory search with qmd\x1b[0m");
			await test("memory_search returns results with qmd", testMemorySearchWithQmd);

			console.log("\n\x1b[1m8. Memory search no-results parsing\x1b[0m");
			await test("memory_search handles qmd no-results output", testMemorySearchNoResultsWithQmd);

			console.log("\n\x1b[1m9. Selective injection via qmd\x1b[0m");
			await test("related prompt surfaces memory without explicit search", testSelectiveInjection);

			console.log("\n\x1b[1m10. Tags and links in search\x1b[0m");
			await test("#tags and [[links]] found by keyword search", testTagsInSearch);

			console.log("\n\x1b[1m11. Handoff survives to next session\x1b[0m");
			await test("handoff in daily log is visible in new session context", testHandoffSurvivesToNextSession);
		} else {
			console.log("\n\x1b[1m7–11. qmd-dependent tests\x1b[0m");
			console.log("  (skipped: qmd not available or collection missing)");
			skipped += 5;
		}
	} finally {
		_clearUpdateTimer();
		_resetBaseDir();
	}

	console.log(`\n\x1b[1mResults: ${passed} passed, ${failed} failed, ${skipped} skipped\x1b[0m`);
	if (errors.length > 0) {
		console.log("\nFailures:");
		for (const err of errors) {
			console.log(`  \x1b[31m✗\x1b[0m ${err}`);
		}
	}
	console.log("");

	fs.rmSync(TMP, { recursive: true, force: true });

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
