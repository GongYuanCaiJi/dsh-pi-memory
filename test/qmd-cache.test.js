// Ported from upstream pi-memory 0.4.2 test/qmd-cache.ts to node:test.
// Covers qmd status/collection caching, setupQmdCollection cache seeding, and
// the lifecycle-transition exit-summary skip guard.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	_clearQmdStatusCaches,
	_resetExecFileForTest,
	_setExecFileForTest,
	_setQmdAvailable,
	checkCollection,
	detectQmd,
	setupQmdCollection,
	shouldSkipExitSummaryForReason,
} from "../index.js";

function mockExecFile(handler) {
	let calls = 0;
	const fn = (cmd, args, _options, callback) => {
		calls++;
		const result = handler(cmd, args);
		queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", result.stderr ?? ""));
	};
	_setExecFileForTest(fn);
	return () => calls;
}

describe("qmd status and collection caches", () => {
	afterEach(() => {
		_resetExecFileForTest();
		_clearQmdStatusCaches();
	});

	it("detectQmd caches its status within the TTL", async () => {
		const qmdCalls = mockExecFile((cmd, args) => {
			assert.equal(cmd, "qmd");
			assert.deepEqual(args, ["collection", "list"]);
			return {};
		});

		assert.equal(await detectQmd(), true);
		assert.equal(await detectQmd(), true);
		assert.equal(qmdCalls(), 1, "detectQmd should cache qmd status within the TTL");
	});

	it("checkCollection caches collection lookups within the TTL", async () => {
		const collectionCalls = mockExecFile((cmd, args) => {
			assert.equal(cmd, "qmd");
			assert.deepEqual(args, ["collection", "list", "--json"]);
			return { stdout: JSON.stringify([{ name: "pi-memory" }]) };
		});

		assert.equal(await checkCollection("pi-memory"), true);
		assert.equal(await checkCollection("pi-memory"), true);
		assert.equal(collectionCalls(), 1, "checkCollection should cache collection lookup within the TTL");

		_setQmdAvailable(false);
		assert.equal(await detectQmd(), false, "_setQmdAvailable should seed the cached status");
	});

	it("setupQmdCollection seeds the cache so checkCollection does not re-run setup", async () => {
		_clearQmdStatusCaches();
		let setupCalls = 0;
		let postSetupListCalls = 0;
		_setExecFileForTest((cmd, args, _options, callback) => {
			assert.equal(cmd, "qmd");
			if (args[0] === "collection" && args[1] === "add") {
				setupCalls++;
				queueMicrotask(() => callback(null, "", ""));
				return;
			}
			if (args[0] === "context" && args[1] === "add") {
				queueMicrotask(() => callback(null, "", ""));
				return;
			}
			if (args[0] === "collection" && args[1] === "list") {
				postSetupListCalls++;
				queueMicrotask(() => callback(null, JSON.stringify([{ name: "pi-memory" }]), ""));
				return;
			}
			queueMicrotask(() => callback(new Error(`unexpected args: ${args.join(" ")}`), "", ""));
		});

		assert.equal(await setupQmdCollection(), true);
		assert.equal(setupCalls, 1);
		assert.equal(await checkCollection("pi-memory"), true);
		assert.equal(postSetupListCalls, 0, "setupQmdCollection should seed the collection cache");
	});

	it("shouldSkipExitSummaryForReason skips transitions unless opted in", () => {
		const original = process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
		try {
			delete process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
			assert.equal(shouldSkipExitSummaryForReason("reload"), true);
			assert.equal(shouldSkipExitSummaryForReason("new"), true);
			assert.equal(shouldSkipExitSummaryForReason("session-end"), false);

			process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = "1";
			assert.equal(shouldSkipExitSummaryForReason("reload"), false);
			assert.equal(shouldSkipExitSummaryForReason("new"), false);
		} finally {
			if (original === undefined) delete process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
			else process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = original;
		}
	});
});
