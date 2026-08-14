<div align="center">

[![中文](#中文) | [English](#english)

# dsh-pi-memory

**让 DeepSeek Harness（dsh）跨会话记住事情：持久事实、每日日志、待办清单，以及可选的 qmd 语义搜索。**

[![license](https://img.shields.io/github/license/GongYuanCaiJi/dsh-pi-memory)](LICENSE)

</div>

---

# 中文

**dsh-pi-memory** 是 [pi-memory](https://github.com/jayzeng/pi-memory)（Pi 生态最流行的记忆插件）的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）移植版。你的 coding agent 每次开新会话都会忘光一切 —— 这个插件给它一份记忆：长期事实与决策、按天追加的工作日志、待办清单，全部是你可以直接读、改、提交的纯 Markdown 文件。装上可选的 [qmd](https://github.com/tobi/qmd) 之后，还能跨所有记忆做关键词、语义与混合**搜索**。

> 移植说明：代码与逻辑 100% 来自上游 [pi-memory](https://www.npmjs.com/package/pi-memory)（[jayzeng/pi-memory](https://github.com/jayzeng/pi-memory)，MIT）。本移植只改动了 dsh 插件入口与生命周期接线，每一处改动都有原因，逐条记录在移植票 [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18) 的交付回報里。**请也给上游 [pi-memory](https://github.com/jayzeng/pi-memory) 一个 star。**

## 功能

| 工具 | 说明 |
|------|------|
| `memory_write` | 写入 MEMORY.md（长期）或今日日志 |
| `memory_forget` | 删除匹配条目，并生成可恢复的删除记录 |
| `memory_restore` | 用 `memory_forget` 返回的 recovery ID 恢复删除 |
| `memory_read` | 读取任意记忆文件或列出每日日志 |
| `scratchpad` | 添加 / 完成 / 撤销 / 清理待办清单项 |
| `memory_search` | 跨所有记忆文件搜索（需要 qmd） |
| `memory_status` | 健康检查：文件位置、qmd / collection / embeddings 状态、当前配置 |

核心六件套（`memory_write`、`memory_forget`、`memory_restore`、`memory_read`、`scratchpad`、`memory_status`）装上即可用，**不需要任何额外配置**。搜索是可选能力。

### memory_search 模式

| 模式 | 速度 | 方法 | 最适合 |
|------|------|------|--------|
| `keyword` | ~30ms | BM25 | 具体术语、日期、名字、#标签、[[链接]] |
| `semantic` | ~2s | 向量搜索 | 相关概念、不同措辞 |
| `deep` | ~10s | 混合 + 重排 | 其他模式找不到时 |

## 效果

```text
# 会话 1
你 ▸ 这个仓库我永远用 pnpm，不用 npm。记住。
dsh ▸ 已记入长期记忆。   （写入 MEMORY.md）

# ……几天后，全新会话……
你 ▸ 把 prettier 加为 devDependency
dsh ▸ pnpm add -D prettier
      （从记忆里想起你的包管理器偏好——不用再提醒）
```

所有内容都存在 `$DSH_HOME/agent/memory/`（默认 `~/.dsh/agent/memory/`）下的 Markdown 文件里，你随时可以 `cat`：

```bash
$ cat ~/.dsh/agent/memory/MEMORY.md
<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->
#preference [[package-manager]] 这个仓库永远用 pnpm，不用 npm。
```

## 安装

> ⚠️ `dsh-pi-memory` 尚未发布到 npm，以下用本地路径安装。发布后即可用裸名安装（届时 README 会更新）。

```bash
# 1. 克隆本仓库并安装依赖
git clone https://github.com/GongYuanCaiJi/dsh-pi-memory.git
cd dsh-pi-memory && npm install

# 2. 装进一个 dsh profile（headless 一次性任务还需要 @deepseek-ai/dsh-headless@next）
P=verify-$(basename $PWD)-$$
dsh plugin --profile "$P" add @deepseek-ai/dsh-headless@next
dsh plugin --profile "$P" add ./dsh-pi-memory

# 3. 用起来
dsh --profile "$P" "记住：我偏好深色模式"
dsh --profile "$P" "我上次说过偏好什么？"   # 新会话，它还记得
```

### 可选：启用 qmd 搜索

`memory_search`（以及 `per-turn` 模式的自动检索注入）需要 [qmd](https://github.com/tobi/qmd)，两种安装方式任选：

```bash
npm install -g @tobilu/qmd                      # 不需要 Bun
bun install -g https://github.com/tobi/qmd      # 确保 ~/.bun/bin 在 PATH 上
```

qmd 就绪后，插件会在**下一次会话启动时自动创建** `pi-memory` collection 与路径 context —— 无需手动步骤。随时运行 `memory_status` 确认 qmd、collection、embeddings 的状态。

语义 / deep 模式需要向量 embeddings；插件会自动保持最新（写入后在后台跑 `qmd embed`）。第一次 embed 会下载 embedding 模型，所以全新安装后语义搜索可能要等一分钟左右才上线。想手动设置：

```bash
qmd collection add ~/.dsh/agent/memory --name pi-memory
qmd context add /daily "Daily append-only work logs organized by date" -c pi-memory
qmd context add / "Curated long-term memory: decisions, preferences, facts, lessons" -c pi-memory
qmd embed
```

没有 qmd 时，核心工具完全可用，只有 `memory_search` 与选择性注入需要它。

## 文件布局

```
~/.dsh/agent/memory/
  MEMORY.md              # 策展的长期记忆
  SCRATCHPAD.md           # 待办清单
  daily/
    2026-02-15.md         # 每日追加日志
    2026-02-14.md
    ...
  recovery/
    <recovery-id>.json    # memory_forget 删除的完整负载与恢复状态
```

## 工作原理

### 上下文注入

每个 agent turn 之前，按优先级注入以下内容到 system prompt：

1. **未完成的待办项**（最多 2K 字符）
2. **今日日志**（最多 3K 字符，尾部）
3. **MEMORY.md**（最多 4K 字符，中间截断）
4. **昨日日志**（最多 3K 字符，尾部——优先级最低，先被裁掉）

总量上限 16K 字符。

### KV 缓存稳定快照（默认）

本地前缀缓存运行时（llama.cpp、vLLM、MLX）从第一个分叉 token 起就会失效。如果注入的记忆块每 turn 都变，整个会话历史每一 turn 都会被重算。

为了让前缀字节稳定，插件在刻意选择的检查点对记忆上下文做快照，期间每个 turn 输出相同字节。快照在以下时机刷新：

- **会话启动** —— 每会话一份新快照
- **压缩（compaction）** —— 写入 handoff 后刷新（一次刻意的缓存边界）
- **`memory_write` 且 `target: long_term`** —— 标记快照脏，下一 turn 刷新
- **跨日** —— 快照记录的日期不再是今天

`target: daily` 的写入与 `scratchpad` 写入**不**标记脏 —— 它们高频发生，内容已经通过工具调用参数回显。模型随时可以用 `memory_read` / `memory_search` 拿到权威最新状态。

设置 `PI_MEMORY_SNAPSHOT=per-turn` 可恢复旧的逐 turn 重建行为（含逐 prompt 的 qmd 搜索注入）。

### 选择性注入（`per-turn` 模式，可选）

`PI_MEMORY_SNAPSHOT=per-turn` 且 qmd 可用时，插件会在每个 turn 前用你的 prompt 自动搜索记忆，把命中前 3 条与标准上下文一起注入。搜索有 3 秒超时、失败静默。默认 `stable` 模式下，模型随时可以自己调 `memory_search`。

### 标签与链接

在记忆内容里用 `#tags` 与 `[[wiki-links]]` 提高可搜性：

```markdown
#decision [[database-choice]] 后端全部选 PostgreSQL。
#preference [[editor]] 用户偏好 Neovim + LazyVim 配置。
#lesson [[api-versioning]] URL 前缀版本化（/v1/）避开 CDN 缓存问题。
```

这是内容约定，不是强制元数据。qmd 的全文索引会免费让它们可搜。

### 会话交接（handoff）

上下文窗口压缩时，插件自动把交接条目写进今日日志：

```markdown
<!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
## Session Handoff
**未完成的待办项：**
- [ ] 修 auth bug
- [ ] 看 PR #42
**最近日志上下文：**
...今日日志最后 15 行...
```

### 其他行为

- **持久化**：记忆文件就是磁盘上的 Markdown —— 可读、可编辑、git 友好。
- **可恢复删除**：`memory_forget` 先把完整删除内容存进 `recovery/` 再改记忆，返回的 recovery ID 可交给 `memory_restore`。恢复 JSON 在 qmd 的 `**/*.md` 索引之外。
- **工具响应预览**：写入 / scratchpad 工具返回大小受限的预览而非全文。
- **qmd 自动建 collection**：qmd 可用时，首次会话启动自动创建 collection 与路径 context。
- **qmd 自动重索引**：每次写入后，后台防抖 `qmd update`（fire-and-forget，不阻塞），可用 `PI_MEMORY_QMD_UPDATE` 关闭。
- **qmd embeddings**：语义 / deep 搜索所需向量自动保持最新 —— 重索引后与启动时后台跑增量 `qmd embed`。随 `PI_MEMORY_QMD_UPDATE` 一并关闭。
- **优雅降级**：没有 qmd 时核心工具照常工作，`memory_search` 返回安装指引。

### 配置

| 变量 | 取值 | 默认 | 说明 |
|------|------|------|------|
| `PI_MEMORY_DIR` | 路径 | `$DSH_HOME/agent/memory` | 覆盖记忆存储目录（默认在 dsh home 下，而非 Pi 的 `~/.pi`） |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | `stable` 在检查点快照记忆以保 KV 缓存稳定；`per-turn` 每 turn 重建（旧行为） |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | 控制写入后的自动 `qmd update` + `qmd embed` |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | 正整数（毫秒） | `60000` | 显式 `memory_search` 的 qmd 查询超时 |
| `PI_MEMORY_NO_SEARCH` | `1` | 未设置 | 关闭 `per-turn` 模式的选择性注入（`stable` 模式无效） |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | 未设置 | 生命周期过渡（reload/new/resume/fork）也写退出总结；默认过渡跳过总结以提速 |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` 关闭 | 未设置（启用） | 关闭会话结束时的退出总结（不做 LLM 调用、不跑 `qmd update`，退出即时） |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | 未设置（会话模型） | 写退出总结用的模型，比如更便宜的。无法解析则回退会话模型 |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | 正整数（毫秒） | `10000` | 退出总结自限超时；超时则不落盘 |

> 移植注：`session_shutdown` 在 dsh 上映射为 `agent/disposed` —— 该事件只在 dsh 主动销毁 agent 且服务仍存活时触发；headless 一次性任务结束时服务先于插件析构，退出总结会安静跳过（不崩溃、不落盘）。这是 dsh 生命周期与 Pi 的差异，详见移植票 [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18)。

## 故障排查

先跑 `memory_status` —— 大多数问题一眼可见。

| 症状 | 原因 | 修复 |
|------|------|------|
| `memory_search` 说需要 qmd | qmd 未安装或不在 PATH | 安装 qmd（`npm install -g @tobilu/qmd`）；Bun 安装的确保 `~/.bun/bin` 在 PATH |
| 搜不到你确定存在的词 | 索引过期 | 写入后有后台 `qmd update`；若关闭了（`PI_MEMORY_QMD_UPDATE=off`），手动 `qmd update` |
| semantic / deep 报 "need embeddings" | 向量还没建 | 后台会自动开始 embed——稍后重试；`PI_MEMORY_QMD_UPDATE` 为 `manual`/`off` 时自己跑 `qmd embed` |
| collection `pi-memory` 缺失 | 自动建库没跑（qmd 是会话中途装的） | 跑任意 `memory_search`（会自动建）或手动 `qmd collection add ~/.dsh/agent/memory --name pi-memory` |
| Windows 上 qmd 在 shell 里能用、dsh 里不能 | `.cmd`/`.ps1` shim 损坏 | 插件会绕过 shim，直接用 `node` 调 qmd 的 JS 入口；确保 npm 全局 `node_modules` 目录在 PATH |
| 写入后记忆没注入 | 缓存稳定快照只在检查点刷新 | 长期写入下一 turn 刷新；daily/scratchpad 用 `memory_read`，或设 `PI_MEMORY_SNAPSHOT=per-turn` |

## 运行测试

```bash
# 单元测试（无 LLM、无 qmd——快、确定性。仅需 Node）
npm test

# 端到端测试（需要 dsh + API key，可选 qmd）
npm run test:e2e

# 没有 API key？用仓库根目录的 mock-llm.mjs（一个脚本化 mock LLM，规则见文件头注释）：
node mock-llm.mjs                        # 起在 127.0.0.1:8099
DEEPSEEK_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=mock-key npm run test:e2e

# 召回效果评估（需要 dsh + API key + qmd）
npm run test:eval

# 固定 provider/model 跑更便宜的 eval
PI_E2E_PROVIDER=deepseek-official PI_E2E_MODEL=deepseek-v4-flash npm run test:eval
```

所有测试都会备份并恢复现有记忆文件。

### 测试层级

| 层级 | 命令 | 需求 | 测什么 |
|------|------|------|--------|
| 单元 | `npm test` | Node | 上下文构建、截断、handoff、scratchpad 解析、qmd 管道 |
| E2E | `npm run test:e2e` | dsh + API key | 工具注册、写入 / 召回、scratchpad 生命周期、搜索 |
| Eval | `npm run test:eval` | dsh + API key + qmd | 有无选择性注入的召回准确率对比 |

## 开发

单文件插件（`index.js`），无需构建步骤。

```bash
# 直接用 dsh 测
P=verify-$(basename $PWD)-$$
dsh plugin --profile "$P" add @deepseek-ai/dsh-headless@next
dsh plugin --profile "$P" add .
dsh --profile "$P" "记住：我偏好深色模式"

# 验证记忆已写入
cat ~/.dsh/agent/memory/MEMORY.md
```

## 发布（维护者）

tag 驱动。推送 `v*` tag 会触发发布 workflow：lint、build、单元测试、校验 tag 与 `package.json` 版本一致，然后发布到 npm。

```bash
npm version patch   # 或 minor / major
git push --follow-tags
```

## 更新日志

上游 [CHANGELOG.md](./CHANGELOG.md) 逐字保留（SHA-256 钉在 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 中，可自验）。dsh 移植本身的改动清单见移植票 [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18) 的交付回報。

## 第三方声明

上游 `pi-memory` 为 MIT 许可。完整声明与逐字文件校验见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，许可文本见 [LICENSE](./LICENSE)。

---

# English

**dsh-pi-memory** is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) port of [pi-memory](https://github.com/jayzeng/pi-memory), the most popular memory extension in the Pi ecosystem. Your coding agent forgets everything between sessions — this plugin gives it a memory: durable facts and decisions, a running daily log, and a scratchpad of things to come back to — all as plain Markdown files you can read, edit, and commit. With optional [qmd](https://github.com/tobi/qmd) it also gets keyword, semantic, and hybrid **search** across everything it has ever remembered.

> Porting notes: the code and logic are 100% from upstream [pi-memory](https://www.npmjs.com/package/pi-memory) ([jayzeng/pi-memory](https://github.com/jayzeng/pi-memory), MIT). This port only changes the dsh plugin entry and lifecycle wiring; every change is listed with a reason in the delivery report of porting ticket [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18). **Please also star upstream [pi-memory](https://github.com/jayzeng/pi-memory).**

## Features

| Tool | Description |
|------|-------------|
| `memory_write` | Write to MEMORY.md (long-term) or daily log |
| `memory_forget` | Delete matching entries and create a durable recovery record |
| `memory_restore` | Restore a deletion using the recovery ID returned by `memory_forget` |
| `memory_read` | Read any memory file or list daily logs |
| `scratchpad` | Add/done/undo/clear/list checklist items |
| `memory_search` | Search across all memory files (requires qmd) |
| `memory_status` | Health check: where files live, qmd/collection/embeddings state, active config |

The six core tools (`memory_write`, `memory_forget`, `memory_restore`, `memory_read`, `scratchpad`, `memory_status`) work immediately with no other setup. Search is opt-in below.

### memory_search modes

| Mode | Speed | Method | Best for |
|------|-------|--------|----------|
| `keyword` | ~30ms | BM25 | Specific terms, dates, names, #tags, [[links]] |
| `semantic` | ~2s | Vector search | Related concepts, different wording |
| `deep` | ~10s | Hybrid + reranking | When other modes miss |

## What it feels like

```text
# Session 1
you ▸ I always use pnpm in this repo, never npm. Remember that.
dsh ▸ Got it — saved to long-term memory.   (writes MEMORY.md)

# …days later, brand new session…
you ▸ add prettier as a dev dependency
dsh ▸ pnpm add -D prettier
      (recalled your package-manager preference from memory — no reminder needed)
```

Everything lives in `$DSH_HOME/agent/memory/` (default `~/.dsh/agent/memory/`) as Markdown, so you can also just `cat` it:

```bash
$ cat ~/.dsh/agent/memory/MEMORY.md
<!-- 2026-06-07 10:12:03 [a1b2c3d4] -->
#preference [[package-manager]] Always use pnpm in this repo, never npm.
```

## Installation

> ⚠️ `dsh-pi-memory` is not published to npm yet — install from a local checkout below. Once published, a bare-name install works (this README will be updated).

```bash
# 1. Clone this repo and install dependencies
git clone https://github.com/GongYuanCaiJi/dsh-pi-memory.git
cd dsh-pi-memory && npm install

# 2. Add it to a dsh profile (headless one-shot runs also need @deepseek-ai/dsh-headless@next)
P=verify-$(basename $PWD)-$$
dsh plugin --profile "$P" add @deepseek-ai/dsh-headless@next
dsh plugin --profile "$P" add ./dsh-pi-memory

# 3. Use it
dsh --profile "$P" "Remember: I prefer dark mode"
dsh --profile "$P" "What did I say I prefer?"   # brand new session — it remembers
```

### Optional: enable search with qmd

`memory_search` (and selective injection in `per-turn` mode) need [qmd](https://github.com/tobi/qmd). Either install method works:

```bash
npm install -g @tobilu/qmd                      # no Bun required
bun install -g https://github.com/tobi/qmd      # ensure ~/.bun/bin is on PATH
```

When qmd is present, the plugin **automatically creates** the `pi-memory` collection and path contexts on the next session start — no manual step. Run `memory_status` any time to confirm qmd, the collection, and embeddings are ready.

Semantic/deep modes need vector embeddings; the plugin keeps them current automatically (`qmd embed` runs in the background at session start and after writes). The very first embed downloads the embedding model, so semantic search may take a minute to come online on a fresh install. To set the collection up by hand:

```bash
qmd collection add ~/.dsh/agent/memory --name pi-memory
qmd context add /daily "Daily append-only work logs organized by date" -c pi-memory
qmd context add / "Curated long-term memory: decisions, preferences, facts, lessons" -c pi-memory
qmd embed
```

Without qmd, the core tools still work fully — only `memory_search` and selective injection require it.

## File layout

```
~/.dsh/agent/memory/
  MEMORY.md              # Curated long-term memory
  SCRATCHPAD.md           # Checklist of things to fix/remember
  daily/
    2026-02-15.md         # Daily append-only log
    2026-02-14.md
    ...
  recovery/
    <recovery-id>.json    # Complete payload and restore state for a memory_forget deletion
```

## How it works

### Context injection

Before every agent turn, the following are injected into the system prompt (in priority order):

1. **Open scratchpad items** (up to 2K chars)
2. **Today's daily log** (up to 3K chars, tail)
3. **MEMORY.md** (up to 4K chars, middle-truncated)
4. **Yesterday's daily log** (up to 3K chars, tail — lowest priority, trimmed first)

Total injection is capped at 16K chars.

### KV cache-stable snapshot (default)

Local prefix-caching runtimes (llama.cpp, vLLM, MLX) invalidate from the first divergent token onward. If the injected memory block changes turn-to-turn, every subsequent user / assistant / tool token gets reprocessed — effectively the entire conversation history each turn.

To keep the prefix byte-stable, the plugin snapshots the memory context at deliberate checkpoints and emits the same bytes for every turn in between. Snapshots refresh on:

- **session start** — fresh snapshot per session
- **compaction** — handoff is written then snapshot refreshes (one intentional cache boundary)
- **`memory_write` with `target: long_term`** — marks the snapshot dirty so the next turn refreshes
- **Day rollover** — snapshot's captured date no longer matches today

`memory_write` with `target: daily` and `scratchpad` writes do **not** mark dirty — they're high-frequency and the write content is already echoed via tool-call args. The model can always call `memory_read` / `memory_search` for the authoritative latest state.

Set `PI_MEMORY_SNAPSHOT=per-turn` to opt out and restore the old per-turn rebuild behavior, including automatic per-prompt qmd search injection.

### Selective injection (opt-in via `per-turn` mode)

When `PI_MEMORY_SNAPSHOT=per-turn` is set and qmd is available, the plugin automatically searches memory using the user's prompt before each turn. The top 3 keyword results are injected alongside the standard context. The search has a 3-second timeout and fails silently. In the default `stable` mode, the model gets the same capability by calling `memory_search` on demand.

### Tags and links

Use `#tags` and `[[wiki-links]]` in memory content to improve searchability:

```markdown
#decision [[database-choice]] Chose PostgreSQL for all backend services.
#preference [[editor]] User prefers Neovim with LazyVim config.
#lesson [[api-versioning]] URL prefix versioning (/v1/) avoids CDN cache issues.
```

These are content conventions, not enforced metadata. qmd's full-text indexing makes them searchable for free.

### Session handoff

When the context window compacts, the plugin automatically captures a handoff entry in today's daily log:

```markdown
<!-- HANDOFF 2026-02-15 14:30:00 [a1b2c3d4] -->
## Session Handoff
**Open scratchpad items:**
- [ ] Fix auth bug
- [ ] Review PR #42
**Recent daily log context:**
...last 15 lines of today's log...
```

### Other behavior

- **Persistence**: Memory files are plain Markdown on disk — readable, editable, and git-friendly.
- **Recoverable deletion**: `memory_forget` stores complete deleted entries under `recovery/` before changing memory and returns a recovery ID that `memory_restore` can use. Recovery JSON is outside qmd's `**/*.md` index.
- **Tool response previews**: Write/scratchpad tools return size-capped previews instead of full file contents.
- **qmd auto-setup**: On first session start with qmd available, the plugin creates the collection and path contexts automatically.
- **qmd re-indexing**: After every write, a debounced `qmd update` runs in the background (fire-and-forget, non-blocking) unless disabled via `PI_MEMORY_QMD_UPDATE`.
- **qmd embeddings**: Vector embeddings for semantic/deep search are kept current automatically — `qmd embed` (incremental) runs in the background after each re-index and as a catch-up at session start. Disabled along with re-indexing via `PI_MEMORY_QMD_UPDATE`.
- **Graceful degradation**: If qmd is not installed, core tools work fine. `memory_search` returns install instructions.

### Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `PI_MEMORY_DIR` | path | `$DSH_HOME/agent/memory` | Override the memory storage directory (defaults under the dsh home, not Pi's `~/.pi`) |
| `PI_MEMORY_SNAPSHOT` | `stable`, `per-turn` | `stable` | `stable` snapshots memory at checkpoints for KV cache stability; `per-turn` rebuilds every turn (legacy behavior) |
| `PI_MEMORY_QMD_UPDATE` | `background`, `manual`, `off` | `background` | Controls automatic `qmd update` + `qmd embed` after writes |
| `PI_MEMORY_QMD_SEARCH_TIMEOUT_MS` | positive integer (milliseconds) | `60000` | Sets the timeout for explicit `memory_search` qmd queries |
| `PI_MEMORY_NO_SEARCH` | `1` | unset | Disable selective injection in `per-turn` mode (no effect in `stable` mode) |
| `PI_MEMORY_SUMMARIZE_TRANSITIONS` | `1`, `true`, `yes`, `on` | unset | Also write exit summaries during lifecycle transitions (reload/new/resume/fork). By default these transitions skip summaries for speed. |
| `PI_MEMORY_EXIT_SUMMARY` | `0`, `off`, `false`, `no` to disable | unset (enabled) | Disable the exit summary on session end. Ending then does no LLM call and no `qmd update`, so it is instant; explicit `memory_write` during sessions is unaffected. |
| `PI_MEMORY_EXIT_SUMMARY_MODEL` | `provider/model-id` | unset (session model) | Model used to write the exit summary, e.g. a cheaper/faster one. Unresolvable specs fall back to the session model. |
| `PI_MEMORY_EXIT_SUMMARY_TIMEOUT_MS` | positive integer (milliseconds) | `10000` | Self-imposed timeout for exit-summary generation on session end. On expiry nothing is persisted. |

> Porting note: `session_shutdown` maps to dsh's `agent/disposed` — that event fires only when dsh disposes an agent while services are still live; in headless one-shot runs the services are torn down before plugin disposers run, so the exit summary is silently skipped (no crash, nothing persisted). This is a dsh-vs-Pi lifecycle difference, detailed in porting ticket [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18).

## Troubleshooting

Run the `memory_status` tool first — it reports most of these at a glance.

| Symptom | Cause | Fix |
|---------|-------|-----|
| `memory_search` says qmd is required | qmd not installed or not on `PATH` | Install qmd (`npm install -g @tobilu/qmd`); if installed via Bun, ensure `~/.bun/bin` is on `PATH` |
| Search returns nothing for terms you know exist | Index is stale | A background `qmd update` runs after writes; if disabled (`PI_MEMORY_QMD_UPDATE=off`), run `qmd update` manually |
| "need embeddings" on semantic/deep search | Vectors not built yet | Embedding starts automatically in the background — retry shortly. If `PI_MEMORY_QMD_UPDATE` is `manual`/`off`, run `qmd embed` yourself |
| Collection `pi-memory` missing | Auto-setup didn't run (qmd installed mid-session) | Run any `memory_search` (auto-creates it) or `qmd collection add ~/.dsh/agent/memory --name pi-memory` |
| qmd works in the shell but not from dsh on Windows | Broken `.cmd`/`.ps1` shims | The plugin bypasses them by invoking qmd's JS entry with `node`; make sure the npm global `node_modules` dir is on `PATH` |
| Memory isn't being injected after a write | Cache-stable snapshot only refreshes at checkpoints | Long-term writes refresh next turn; for daily/scratchpad use `memory_read`, or set `PI_MEMORY_SNAPSHOT=per-turn` |

## Running tests

```bash
# Unit tests (no LLM, no qmd — fast, deterministic. Node only.)
npm test

# End-to-end tests (requires dsh + API key, optionally qmd)
npm run test:e2e

# No API key? Use mock-llm.mjs at the repo root (a scripted mock LLM; its
# response rules are documented in the file header):
node mock-llm.mjs                        # serves on 127.0.0.1:8099
DEEPSEEK_BASE_URL=http://127.0.0.1:8099 DEEPSEEK_API_KEY=mock-key npm run test:e2e

# Recall effectiveness eval (requires dsh + API key + qmd)
npm run test:eval

# Pin provider/model for cheaper eval runs
PI_E2E_PROVIDER=deepseek-official PI_E2E_MODEL=deepseek-v4-flash npm run test:eval
```

All tests back up and restore existing memory files.

### Test levels

| Level | Command | Requirements | What it tests |
|-------|---------|-------------|---------------|
| Unit | `npm test` | Node | Context builder, truncation, handoff, scratchpad parsing, qmd plumbing |
| E2E | `npm run test:e2e` | dsh + API key | Tool registration, write/recall, scratchpad lifecycle, search |
| Eval | `npm run test:eval` | dsh + API key + qmd | Recall accuracy with vs without selective injection |

## Development

This is a single-file plugin (`index.js`). No build step required.

```bash
# Test with dsh directly
P=verify-$(basename $PWD)-$$
dsh plugin --profile "$P" add @deepseek-ai/dsh-headless@next
dsh plugin --profile "$P" add .
dsh --profile "$P" "remember: I prefer dark mode"

# Verify memory was written
cat ~/.dsh/agent/memory/MEMORY.md
```

## Publishing (maintainers)

Releases are tag-driven. Pushing a `v*` tag runs the publish workflow, which lints, builds, runs the unit tests, verifies the tag matches `package.json`, and then publishes to npm.

```bash
npm version patch   # or minor / major
git push --follow-tags
```

## Changelog

Upstream [CHANGELOG.md](./CHANGELOG.md) is preserved verbatim (its SHA-256 is pinned in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) so the claim is self-verifiable). The dsh port's own change list lives in the delivery report of porting ticket [#18](https://github.com/GongYuanCaiJi/deepseek-harness/issues/18).

## Third-party notices

Upstream `pi-memory` is MIT-licensed. Full notices and verbatim-file verification live in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md); the license text is in [LICENSE](./LICENSE).
