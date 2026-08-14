// Ported from upstream pi-memory 0.4.2 test/eval-recall.ts.
//
// Recall effectiveness eval for dsh-pi-memory selective injection.
//
// Seeds a memory corpus, then runs recall questions in two conditions:
//   A) With selective injection (PI_MEMORY_SNAPSHOT=per-turn + qmd)
//   B) Without selective injection (PI_MEMORY_NO_SEARCH=1)
//
// Measures whether the agent can answer from injected context alone (no tool
// use). Requires `dsh` on PATH, a model endpoint, and `qmd` with the
// pi-memory collection configured. Backs up and restores the eval memory dir.
//
// Run:   npm run test:eval
// Options:
//   EVAL_RUNS=1                Number of runs per condition (default: 1)
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 120_000;
const EVAL_RUNS = parseInt(process.env.EVAL_RUNS ?? "1", 10);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-memory-eval-"));
const DSH_HOME = path.join(TMP, "dsh-home");
const MEMORY_DIR = path.join(TMP, "memory");
const MEMORY_FILE = path.join(MEMORY_DIR, "MEMORY.md");
const DAILY_DIR = path.join(MEMORY_DIR, "daily");
const PROFILE = `verify-eval-${Date.now()}`;

const BASE_ENV = {
	...process.env,
	DSH_HOME,
	PI_MEMORY_DIR: MEMORY_DIR,
	PI_MEMORY_EXIT_SUMMARY: "0",
	PI_MEMORY_QMD_UPDATE: "off",
};

// ---------------------------------------------------------------------------
// Memory corpus — diverse topics, varying ages (upstream corpus, verbatim)
// ---------------------------------------------------------------------------

function todayStr() {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return d.toISOString().slice(0, 10);
}

const CORPUS = [
	{ target: "long_term", content: "#decision [[database-choice]] Chose PostgreSQL for all backend services. Evaluated MySQL and MongoDB but PostgreSQL won for JSON support and reliability." },
	{ target: "long_term", content: "#decision [[auth-strategy]] Using JWT tokens with refresh rotation. Access tokens expire in 15 minutes, refresh tokens in 7 days." },
	{ target: "long_term", content: "#preference [[editor]] User prefers Neovim with LazyVim config. Does not use VS Code." },
	{ target: "long_term", content: "#decision [[deployment]] Deploying to Fly.io for production. Staging runs on Railway. Considered Render but latency was worse." },
	{ target: "long_term", content: "#preference [[language]] Primary language is TypeScript. Uses Bun as runtime, not Node. Avoids Python for backend work." },
	{ target: "long_term", content: "#decision [[css-framework]] Using Tailwind CSS v4. No component library — building custom components. Rejected shadcn for this project." },
	{ target: "long_term", content: "#lesson [[api-versioning]] API versioning via URL prefix (/v1/, /v2/) not headers. Learned this after header-based versioning caused CDN cache issues." },
	{ target: "long_term", content: "#preference [[testing]] Prefers integration tests over unit tests. Uses Playwright for e2e. Vitest for unit/integration when needed." },
	{ target: "long_term", content: "#decision [[state-management]] Using Zustand for client state. No Redux. Server state via TanStack Query." },
	{ target: "long_term", content: "#preference [[git-workflow]] Uses trunk-based development. Short-lived feature branches, squash merges to main. No release branches." },
	{ target: "long_term", content: "#decision [[email-provider]] SendGrid for transactional email. Resend was considered but SendGrid had better deliverability in testing." },
	{ target: "long_term", content: "#lesson [[caching]] Redis for session cache and rate limiting. Tried in-memory caching first but it didn't survive deploys on Fly.io." },
	{ target: "long_term", content: "#preference [[color-scheme]] User prefers dark mode in all tools. Terminal theme is Catppuccin Mocha." },
	{ target: "long_term", content: "#decision [[monitoring]] Using Grafana Cloud for metrics and Sentry for error tracking. PagerDuty for on-call alerts." },
	{ target: "long_term", content: "#decision [[file-storage]] S3-compatible storage via Cloudflare R2. Cheaper than AWS S3 for egress. Images served through Cloudflare CDN." },
	{ target: "daily", date: todayStr(), content: "## Morning standup\nWorking on user profile page redesign. Need to add avatar upload using R2 bucket.\n\n## Afternoon\nFixed a bug where JWT refresh tokens weren't being rotated on mobile clients." },
	{ target: "daily", date: daysAgo(1), content: "## Tasks completed\n- Migrated email templates from Handlebars to React Email\n- Updated SendGrid integration to use new API key\n- Reviewed PR #87: rate limiting middleware\n\n## Notes\nDiscovered that Playwright tests are flaky on CI — need to add retry logic." },
	{ target: "daily", date: daysAgo(3), content: "## Database migration\nAdded full-text search index on posts table using PostgreSQL tsvector. Performance improved 10x for search queries." },
	{ target: "daily", date: daysAgo(5), content: "## DevOps\nSet up GitHub Actions CI pipeline. Runs Vitest + Playwright on every PR. Deploy to staging on merge to main via Fly.io CLI." },
	{ target: "daily", date: daysAgo(7), content: "## Auth refactor\nMoved from cookie-based sessions to JWT. Had to update all API middleware. CORS config changed for the mobile app." },
	{ target: "daily", date: daysAgo(10), content: "## Performance tuning\nAdded Redis caching layer for frequently accessed user profiles. Cache TTL set to 5 minutes. Reduced p95 latency from 400ms to 50ms." },
	{ target: "daily", date: daysAgo(14), content: "## Initial deployment\nFirst deploy to Fly.io. Set up 2 machines in IAD region. Added health check endpoint at /api/health. Configured auto-scaling 1-3 instances." },
	{ target: "daily", date: daysAgo(20), content: "## Project kickoff\nStarted the project with Bun + Hono for the API server. Chose Drizzle ORM for type-safe database access with PostgreSQL." },
	{ target: "daily", date: daysAgo(25), content: "## Research\nEvaluated ORMs: Prisma vs Drizzle vs Kysely. Drizzle won — lighter weight, better TypeScript inference, works well with Bun." },
	{ target: "daily", date: daysAgo(30), content: "## Architecture planning\nDecided on monorepo structure: /apps/web (Next.js), /apps/api (Hono), /packages/shared (types + utils). Using Turborepo for builds." },
];

const QUESTIONS = [
	{ id: "db", question: "What database are we using for this project and why was it chosen?", expectedKeywords: ["postgresql", "postgres"], source: "long_term", topic: "database choice" },
	{ id: "auth", question: "How does our authentication work? What kind of tokens do we use?", expectedKeywords: ["jwt", "refresh"], source: "long_term", topic: "auth strategy" },
	{ id: "deploy", question: "Where is our production app deployed?", expectedKeywords: ["fly.io", "fly"], source: "long_term", topic: "deployment" },
	{ id: "email", question: "What email service are we using for transactional emails?", expectedKeywords: ["sendgrid"], source: "long_term", topic: "email provider" },
	{ id: "css", question: "What CSS framework does this project use?", expectedKeywords: ["tailwind"], source: "long_term", topic: "CSS framework" },
	{ id: "state", question: "What do we use for client-side state management?", expectedKeywords: ["zustand"], source: "long_term", topic: "state management" },
	{ id: "storage", question: "Where do we store uploaded files and images?", expectedKeywords: ["r2", "cloudflare"], source: "long_term", topic: "file storage" },
	{ id: "monitoring", question: "What tools do we use for monitoring and error tracking?", expectedKeywords: ["grafana", "sentry"], source: "long_term", topic: "monitoring" },
	{ id: "today_work", question: "What am I currently working on today?", expectedKeywords: ["profile", "avatar", "redesign"], source: "today", topic: "current work" },
	{ id: "yesterday_email", question: "What did we do with email templates recently?", expectedKeywords: ["react email", "sendgrid", "migrated", "handlebars"], source: "yesterday", topic: "recent email work" },
	{ id: "older_fts", question: "Did we add full-text search? What technology powers it?", expectedKeywords: ["tsvector", "postgresql", "full-text"], source: "older_daily", topic: "full-text search" },
	{ id: "older_orm", question: "Which ORM are we using and what alternatives were considered?", expectedKeywords: ["drizzle"], source: "older_daily", topic: "ORM choice" },
	{ id: "older_ci", question: "How does our CI/CD pipeline work?", expectedKeywords: ["github actions", "vitest", "playwright"], source: "older_daily", topic: "CI/CD" },
	{ id: "older_monorepo", question: "What is our project's monorepo structure?", expectedKeywords: ["turborepo", "monorepo", "hono"], source: "older_daily", topic: "architecture" },
	{ id: "older_perf", question: "What caching improvements were made for user profiles?", expectedKeywords: ["redis", "50ms", "cache"], source: "older_daily", topic: "performance" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runDsh(prompt, envExtra = {}) {
	let stdout = "";
	let exitCode = 0;
	try {
		stdout = execFileSync("dsh", ["--profile", PROFILE, prompt], {
			timeout: TIMEOUT_MS,
			encoding: "utf-8",
			maxBuffer: 10 * 1024 * 1024,
			env: { ...BASE_ENV, ...envExtra },
		});
	} catch (err) {
		stdout = err.stdout ?? "";
		exitCode = err.status ?? 1;
	}
	return { exitCode, stdout: stdout.toLowerCase() };
}

function seedCorpus() {
	fs.mkdirSync(DAILY_DIR, { recursive: true });
	for (const entry of CORPUS) {
		if (entry.target === "long_term") {
			const existing = fs.existsSync(MEMORY_FILE) ? fs.readFileSync(MEMORY_FILE, "utf-8") : "";
			fs.writeFileSync(MEMORY_FILE, existing ? `${existing}\n\n${entry.content}\n` : `${entry.content}\n`);
		} else {
			const file = path.join(DAILY_DIR, `${entry.date}.md`);
			const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
			fs.writeFileSync(file, existing ? `${existing}\n\n${entry.content}\n` : `${entry.content}\n`);
		}
	}
	// qmd index must be current for the per-turn search condition.
	try {
		execFileSync("qmd", ["update"], { stdio: "ignore", timeout: 60_000, env: BASE_ENV });
	} catch {
		// qmd may be absent — the selective-injection condition will simply score 0.
	}
}

function scoreAnswer(stdout, question) {
	return question.expectedKeywords.some((kw) => stdout.includes(kw));
}

function runCondition(label, envExtra) {
	let correct = 0;
	const rows = [];
	for (const q of QUESTIONS) {
		let hits = 0;
		for (let i = 0; i < EVAL_RUNS; i++) {
			const { exitCode, stdout } = runDsh(q.question, envExtra);
			if (exitCode === 0 && scoreAnswer(stdout, q)) hits++;
		}
		const ok = hits > 0;
		if (ok) correct++;
		rows.push({ id: q.id, ok, source: q.source, topic: q.topic });
	}
	const pct = Math.round((correct / QUESTIONS.length) * 100);
	console.log(`\n${label}: ${correct}/${QUESTIONS.length} (${pct}%)`);
	for (const row of rows) {
		console.log(`  ${row.ok ? "✓" : "✗"} ${row.id.padEnd(16)} [${row.source.padEnd(10)}] ${row.topic}`);
	}
	return pct;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log("\n\x1b[1mdsh-pi-memory recall eval\x1b[0m\n");

	fs.mkdirSync(DSH_HOME, { recursive: true });
	try {
		execFileSync("dsh", ["plugin", "--profile", PROFILE, "add", "@deepseek-ai/dsh-headless@next"], { env: BASE_ENV, stdio: "pipe" });
		const tarball = execFileSync("npm", ["pack", "--silent"], { encoding: "utf-8" }).trim().split("\n").pop();
		execFileSync("dsh", ["plugin", "--profile", PROFILE, "add", path.resolve(tarball)], { env: BASE_ENV, stdio: "pipe" });
		fs.unlinkSync(tarball);
	} catch (err) {
		console.error(`Failed to set up profile: ${err.message}`);
		process.exit(1);
	}

	seedCorpus();

	const withInjection = runCondition("A) With selective injection (per-turn)", { PI_MEMORY_SNAPSHOT: "per-turn" });
	const withoutInjection = runCondition("B) Without selective injection (no search)", {
		PI_MEMORY_SNAPSHOT: "per-turn",
		PI_MEMORY_NO_SEARCH: "1",
	});

	console.log(`\n\x1b[1mDelta (A − B): ${withInjection - withoutInjection} percentage points\x1b[0m`);

	fs.rmSync(TMP, { recursive: true, force: true });
	process.exit(0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
