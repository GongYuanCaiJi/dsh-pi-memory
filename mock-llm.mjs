// mock-llm.mjs — a minimal OpenAI-compatible SSE server for local e2e runs.
//
// What it is: a scripted stand-in for the DeepSeek API that lets
// `npm run test:e2e` run end-to-end without a real API key. It is NOT a
// general-purpose model; it answers from canned rules tuned to the e2e
// scenarios (see below) and records every request to the dir given by
// MOCK_LLM_LOG_DIR (default: none).
//
// How to run (before `npm run test:e2e`):
//   node mock-llm.mjs                # serves on 127.0.0.1:8099
//   DEEPSEEK_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=mock-key \
//     npm run test:e2e
//
// Response rules (evaluated in order per request):
//   1. If the tools list includes `memory_write` and the last user message
//      starts with "Remember:", emit a memory_write tool call whose content is
//      the rest of that message (the e2e "session 1 writes memory" scenario).
//   2. Else if the assembled system prompt contains "Favorite color: purple",
//      answer "purple, sushi" (the direct context-injection scenario).
//   3. Else if the system prompt contains "Seattle", answer "seattle, tea"
//      (the cross-session recall scenario).
//   4. Else echo the last user message with an "OK:" prefix.
import http from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";

const PORT = Number(process.env.PORT ?? 8099);
const LOG_DIR = process.env.MOCK_LLM_LOG_DIR;
let callCount = 0;

function systemText(parsed) {
	const first = parsed.messages?.[0];
	if (first?.role === "system" && typeof first.content === "string") return first.content;
	return "";
}

function firstUserText(parsed) {
	// dsh assembles messages as [system, task(user), runtime-context(user), skills-reminder(user), ...]
	// — the task is always the FIRST string-content user message.
	const messages = parsed.messages ?? [];
	for (const m of messages) {
		if (m.role === "user" && typeof m.content === "string") return m.content;
	}
	return "";
}

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		callCount += 1;
		let parsed;
		try {
			parsed = JSON.parse(body || "{}");
		} catch {
			parsed = {};
		}
		if (LOG_DIR) {
			mkdirSync(LOG_DIR, { recursive: true });
			writeFileSync(`${LOG_DIR}/req-${callCount}.json`, JSON.stringify(parsed, null, 2));
		}

		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		const emit = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
		const done = () => res.write("data: [DONE]\n\n");

		emit({
			id: `chatcmpl-${callCount}`,
			object: "chat.completion.chunk",
			created: Date.now(),
			model: "mock",
			choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
		});

		const sys = systemText(parsed);
		const lastUser = firstUserText(parsed);
		const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
		const hasMemoryWrite = (parsed.tools ?? []).some((t) => t.function?.name === "memory_write");
		const historyHasToolResult = (parsed.messages ?? []).some(
			(m) =>
				m.role === "tool" ||
				(Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" || b.type === "tool")),
		);

		let finalText = `OK: ${lastUser.slice(0, 120)}`;
		if (!historyHasToolResult && hasTools && hasMemoryWrite && lastUser.startsWith("Remember:")) {
			const content = lastUser.replace(/^Remember:\s*/, "");
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: `call_mem_${callCount}`,
									type: "function",
									function: {
										name: "memory_write",
										arguments: JSON.stringify({ target: "long_term", content }),
									},
								},
							],
						},
						finish_reason: null,
					},
				],
			});
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			});
		} else if (sys.includes("Favorite color: purple")) {
			finalText = "purple, sushi";
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: { content: finalText } }],
			});
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
		} else if (sys.includes("PostgreSQL")) {
			finalText = "postgresql";
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: { content: finalText } }],
			});
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
		} else if (sys.includes("Seattle")) {
			finalText = "seattle, tea";
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: { content: finalText } }],
			});
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
		} else {
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: { content: finalText } }],
			});
			emit({
				id: `chatcmpl-${callCount}`,
				object: "chat.completion.chunk",
				created: Date.now(),
				model: "mock",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			});
		}

		emit({
			id: `chatcmpl-${callCount}`,
			object: "chat.completion.chunk",
			created: Date.now(),
			model: "mock",
			choices: [{ index: 0, delta: {}, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }],
		});
		done();
		res.end();
	});
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock llm on 127.0.0.1:${PORT}`));
