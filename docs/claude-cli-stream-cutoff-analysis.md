# Claude CLI 流式输出半句后停止问题分析

## 给 Claude 的问题摘要

Claude Code CLI 通过本地 `AIClient2API` 代理请求 `claude-kiro-oauth` 时，模型输出半句后被正常结束。CLI 没有报错，transcript 显示 `stop_reason: "end_turn"`，但文本明显不完整：

```text
I need to understand what the user wants—they're looking to hide the streaming media module since it's not fully implemented yet. Let me check the workflow documentation and relevant files to
```

我需要你重点判断：当前适配层到底应该如何识别 Kiro/ai-mirror 上游流的“真实完成”，以及在上游半截断流时，应该如何避免把它伪装成 Claude API 的正常 `end_turn/message_stop`。

## 运行环境

- 项目目录：`C:/Users/Administrator/Documents/krio-proxy/AIClient2API`
- Claude CLI 执行目录：`C:/Code/hdhive`
- Claude CLI prompt：`隐藏掉流媒体模块 现在基本没实现`
- Claude CLI 代理配置：`ANTHROPIC_BASE_URL=http://localhost:3000/claude-kiro-oauth`
- AIClient2API 当前 provider：`claude-kiro-oauth`
- 本地服务端口：`127.0.0.1:3000`

## 具体表现

1. 用户在 Claude CLI 输入：

   ```text
   隐藏掉流媒体模块 现在基本没实现
   ```

2. CLI 只输出一段英文半句，然后停止：

   ```text
   I need to understand what the user wants—they're looking to hide the streaming media module since it's not fully implemented yet. Let me check the workflow documentation and relevant files to
   ```

3. CLI 侧没有异常提示，也没有继续工具调用。

4. Claude transcript 显示这是一个正常 assistant message：

   - 文件：`C:/Users/Administrator/.claude/projects/C--Code-hdhive/8d0f7ab9-cecc-4bda-9dde-b232c9a66c21.jsonl`
   - assistant 行：line 16
   - `stop_reason: "end_turn"`
   - `stop_details: null`
   - `output_tokens: 36`
   - Stop hook 正常：
     - line 18：`hookErrors: []`
     - line 18：`preventedContinuation: false`
   - turn duration：
     - line 19：`durationMs: 7682`

结论：这不是 Claude CLI 崩溃，也不是 Stop hook 阻止继续，而是客户端收到了一个被代理包装成“正常结束”的短回复。

## 关键代理日志证据

主请求 ID：`127.0.0.1:659eb32a`

日志文件：

- stdout：`C:/Users/Administrator/Documents/krio-proxy/AIClient2API/.codex-fresh-master-20260628-185332.out.log`
- stderr：`C:/Users/Administrator/Documents/krio-proxy/AIClient2API/.codex-fresh-master-20260628-185332.err.log`

AI Monitor 聚合出的 Claude SSE 响应只有 20 个事件、15 个文本 delta，拼接后的文本正好等于 CLI 显示的半句：

```text
text_len=191
text=I need to understand what the user wants—they're looking to hide the streaming media module since it's not fully implemented yet. Let me check the workflow documentation and relevant files to
```

最后两个事件是正常完成：

```json
[
  {
    "type": "message_delta",
    "delta": {
      "stop_reason": "end_turn"
    },
    "usage": {
      "input_tokens": 26775,
      "output_tokens": 36,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  },
  {
    "type": "message_stop"
  }
]
```

stderr 同一请求有关键警告：

```text
[2026-06-28 18:55:27.679] [Req:127.0.0.1:659eb32a] [WARN] [Kiro Stream] contextUsagePercentage not received, using estimation
```

这说明当时适配层没有收到上游常见的完成/usage 标记，但仍然继续补了 Claude `message_delta end_turn` 和 `message_stop`。

## 当前代码路径

主要文件：

- `src/providers/claude/claude-kiro.js`
- `src/utils/common.js`
- `tests/kiro-provider.test.js`

相关代码点：

- `claude-kiro.js:2817`：`parseAwsEventStreamBuffer(buffer)`
- `claude-kiro.js:2885`：兼容 `{"text": "..."}`
- `claude-kiro.js:3017`：`streamApiReal()` 解析上游 stream chunk
- `claude-kiro.js:3360` 左右：`generateContentStream()` 消费 `streamApiReal()`
- `claude-kiro.js:3710` 旧逻辑：缺 `contextUsagePercentage` 时估算 input tokens
- `claude-kiro.js:3715` 旧逻辑：无论上游是否明确完成，都发送 `message_delta`
- `claude-kiro.js:3726` 旧逻辑：发送 `message_stop`
- `common.js:2461`：Claude 流式错误会输出 `event: error`

## 我已经做过的修复

### 修复 1：兼容 ai-mirror text-only chunk

问题背景：上游可能输出 `{"text":"..."}`，旧 parser 未必把它识别为正文。

当前改动：

- 文件：`src/providers/claude/claude-kiro.js`
- 逻辑：当 parsed JSON 只有 `text` 字段，且没有 `followupPrompt/name/toolUseId/input/stop/contextUsagePercentage` 时，将其作为 content event。

测试：

- 文件：`tests/kiro-provider.test.js`
- 用例：`treats ai-mirror text-only chunks as content events`

这个修复解决的是“正文 chunk 被忽略”，但这次半句停止不是这个问题；日志已经证明正文 chunk 被正确输出了，只是后续流提前结束。

### 修复 2：按 AWS Event Stream 帧解析上游 payload

问题背景：旧 parser 在字符串里扫描 `{...}`，对 AWS Event Stream 二进制帧和跨 chunk 边界不够稳，可能漏帧或错切。

当前改动：

- 文件：`src/providers/claude/claude-kiro.js`
- 逻辑：`parseAwsEventStreamBuffer()` 对 Buffer 输入优先按 AWS Event Stream 帧长切 payload；非帧文本上游保留宽松 JSON 扫描。
- 提取 `_classifyKiroEventPayload()` 统一识别 content/text/tool/contextUsage 事件。

这个修复降低 parser 把正常上游事件漏掉的风险，也保留了 ai-mirror text-only chunk 兼容。

### 修复 3：缓冲到完成标记并内部重试半截流

问题背景：本次日志显示有可见正文，但没有 `contextUsagePercentage`，旧逻辑仍补 `end_turn/message_stop`。

当前改动：

- 文件：`src/providers/claude/claude-kiro.js`
- 新增：`_streamKiroEventsWithRecovery(...)`
- 默认：`KIRO_BUFFER_UNTIL_COMPLETE !== false` 时，收到 `contextUsagePercentage` 前先缓冲上游事件，不向 Claude CLI 下发。
- 如果上游在完成标记前结束，且尚未提交任何事件，则丢弃本次缓冲并重试整条上游请求。
- 如果重试用尽仍无完成标记，则 flush 最后一次缓冲内容，并沿用估算 token 的历史收尾逻辑。
- 可选：`KIRO_BUFFER_UNTIL_COMPLETE === false` 时恢复低延迟 streaming，达到阈值或出现工具调用后提交。

当前行为：

默认模式下，短回复不会在确认完成前提前发给 CLI；半截 EOF 会先在代理层内部重试，避免把第一次半句直接包装成正常 `end_turn`。

```text
[Kiro Stream] Upstream ended without completion marker before commit (...); retrying upstream request
```

完成标记正常到达后，再一次性 flush 已缓冲事件并补标准 Claude 结束事件：

```json
{"type":"message_delta","delta":{"stop_reason":"end_turn"}}
{"type":"message_stop"}
```

测试：

- 文件：`tests/kiro-provider.test.js`
- 用例：`falls back to end_turn when upstream stream omits the completion marker`
- 用例：`drops unfinished streamed tool input and closes the stream gracefully`

验证命令：

```powershell
npx jest tests/kiro-provider.test.js --runInBand --testNamePattern="ai-mirror text-only|KiroApiService streaming|AI monitor stream aggregation"
```

结果：

```text
Test Suites: 1 passed, 1 total
Tests: 30 skipped, 9 passed, 39 total
```

## 这个修复为什么仍需继续观察

当前修复已经从“事后报错”推进到“提交前缓冲 + 上游内部重试”，能避免大部分开头半截流被直接写给 CLI。但它仍依赖 `contextUsagePercentage` 作为最强完成信号，且需要真实上游流量继续观察。

### 风险 1：把 `contextUsagePercentage` 当唯一完成标记可能过窄

现在的判断近似是：

```text
有正文 + 没有 contextUsagePercentage = 不完整流
```

如果 Kiro/ai-mirror 在某些合法完成场景下不会发送 `contextUsagePercentage`，而是用其他 completion marker，那么当前修复会误判正常回复为 502。

需要 Claude 帮忙确认：Kiro/CodeWhisperer streaming 的真实 completion signal 到底有哪些，是否一定有 `contextUsagePercentage`，是否还有 `stop/followupPrompt/metadata/done` 等事件。

### 风险 2：streaming 模式下仍可能提交后才发现截断

默认 `buffer-until-complete` 模式会在完成标记前缓冲，不会把开头半句提前写给 CLI。只有显式设置 `KIRO_BUFFER_UNTIL_COMPLETE === false` 恢复实时流式时，才可能在达到阈值或出现工具调用后提交。

提交后才截断的场景不能安全重试，否则会重复输出；此时仍只能沿用估算 token 的历史收尾逻辑。

### 风险 3：没有记录足够 raw upstream event

本次 AI Monitor 只记录了转换后的 Claude SSE 聚合，没有完整 raw AWS event-stream payload。要定位上游是“真的只返回半句”还是 parser 漏掉了后续事件，需要在 `streamApiReal()` 层增加更强诊断：

- 每个 raw chunk byte length
- 每次 parse 出的 event 类型
- stream EOF 时 buffer 剩余长度和片段
- 是否出现了非 JSON / 被忽略 JSON
- 是否有 upstream `end/error/done` 语义但 parser 未识别

### 风险 4：AI Monitor 请求 ID 有串号问题

日志中出现过：

```text
[Req:127.0.0.1:659eb32a] [AI Monitor][127.0.0.1:61912516] >>> Internal Req Converted ...
```

原因很可能是 provider adapter 把 `_monitorRequestId` 写到了共享的 `this.config`：

```js
this.config._monitorRequestId = requestBody._monitorRequestId;
```

这会导致并发请求时 AI Monitor 内部转换日志串号。它不是半句停止的直接原因，因为最终 `[Res Full]` 仍可按外层 `Req:659eb32a` 对齐，但会严重干扰后续排障。

建议单独修复：不要把 request scoped id 写入共享 provider config，改为局部变量或传入 `buildCodewhispererRequest(..., { monitorRequestId })`。

### 风险 5：`Invalid profileArn` 警告可能影响模型/上游状态

同一时间 stderr 有：

```text
[Req:127.0.0.1:659eb32a] [WARN] [Kiro] Failed to fetch available models (Status: 400): ... {"message":"Invalid profileArn."}
```

生成请求仍然进入了 `generateContentStream`，所以这不是直接失败点。但它说明 Kiro management/model-list 路径配置不完全健康，可能影响模型解析、fallback、credential health 或后续重试策略。

## 可能根因排序

1. **最可能：上游 Kiro/ai-mirror HTTP stream 提前 EOF，适配层误认为正常完成。**
   证据：主请求有正文、无 `contextUsagePercentage`、旧逻辑补了 `end_turn/message_stop`。

2. **parser 漏识别了某种 completion 或 continuation event。**
   如果上游实际发了完成信号，但不是当前 parser 支持的结构，会导致错误判断。

3. **上游确实只生成半句并结束，但没有明确 stop reason。**
   这种情况下也不应该包装成 Claude `end_turn`，至少应标记异常，因为自然语言明显不完整。

4. **AI Monitor 串号干扰了诊断。**
   不是主因，但会让 request-level 证据不可靠，必须修。

5. **Kiro profile/model-list 配置异常。**
   `Invalid profileArn` 不是本次断流直接证据，但值得排查。

## 建议 Claude 优先检查的问题

1. Kiro/CodeWhisperer streaming 上游协议中，什么事件代表“响应完整结束”？
2. `contextUsagePercentage` 是否可靠地表示完成？有没有合法流不发送它？
3. `parseAwsEventStreamBuffer()` 是否会把 AWS Event Stream 的某些帧误解析、漏解析或截断？
4. 当 `for await (const chunk of stream)` 正常结束但没有 completion marker 时，应该 retry、error、还是允许结束？
5. 对已经发送给 CLI 的半截 delta，后续 `event:error` 是否会被 Claude CLI 正确视为失败？
6. 是否应该在代理层对 Claude CLI 请求启用一次内部重试，并在确认完成前缓冲 early chunks？
7. `_monitorRequestId` 写入共享 config 的并发串号应该怎么改最小？

## 我建议的修复方向

### 方向 A：先修正确性，避免提前伪正常结束

当前补丁属于这个方向：

- 默认缓冲到 `contextUsagePercentage` 再下发。
- 提交前 EOF 时在代理层内部重试。
- 重试用尽后才 flush 最后一次缓冲并按历史兼容逻辑收尾。

优点：

- 阻止最常见的“第一次半句也算完成”直接暴露给 CLI。
- 测试可复现。

缺点：

- 默认牺牲逐字流式，响应会在完成标记后一次性出现。
- 如果上游合法完成但长期不发 `contextUsagePercentage`，会增加重试成本。

### 方向 B：增加 raw upstream completion 识别

应该在 `streamApiReal()` 中维护状态：

```text
sawContent
sawContextUsage
sawExplicitStop
sawCompletionMarker
ignoredEventCount
remainingBufferLength
```

并让 `generateContentStream()` 判断：

```text
有明确完成 marker -> 可以发 message_delta/message_stop
无完成 marker + 有正文 -> incomplete stream error
无完成 marker + 无正文 -> empty response error
```

关键是先搞清楚 `sawExplicitStop/sawCompletionMarker` 应该识别哪些上游事件。

### 方向 C：短缓冲 + 内部重试

为了避免“半句已经发给 CLI 后才报错”，当前实现采用默认全程缓冲策略：

- 在收到 completion marker 前缓冲所有事件。
- 如果 marker 正常到达，flush 缓冲内容。
- 如果流提前 EOF，直接重试，不向 CLI 输出半句。

这会牺牲首 token 延迟，但对 CLI 体验更正确。需要低延迟时可显式关闭 `KIRO_BUFFER_UNTIL_COMPLETE`。

### 方向 D：修 AI Monitor 串号

不要使用共享 `this.config._monitorRequestId` 保存请求 ID。

建议改成：

```js
const monitorRequestId = requestBody._monitorRequestId;
delete requestBody._monitorRequestId;
...
await this.buildCodewhispererRequest(..., { resolvedModelId, monitorRequestId });
```

然后 `buildCodewhispererRequest()` 内部使用 `options.monitorRequestId` 调用 hook。

## 当前仓库状态

当前未提交改动：

```text
?? docs/claude-cli-stream-cutoff-analysis.md
M src/providers/claude/claude-kiro.js
M tests/kiro-provider.test.js
```

diff 摘要：

```text
docs/claude-cli-stream-cutoff-analysis.md | 385 +++++++++++++++++++++++++
src/providers/claude/claude-kiro.js       | 448 ++++++++++++++++++++++--------
tests/kiro-provider.test.js               |  59 +++-
3 files changed, 767 insertions(+), 125 deletions(-)
```

本地服务已经重启过一次：

- 旧 PID：`7300`
- 新 PID：`16804`
- `/health` 返回：`{"status":"healthy","provider":"claude-kiro-oauth"}`

但尚未重新用 Claude CLI 跑同一个 prompt 做端到端复现验证。

## 请 Claude 给出的结果

请基于上面的证据，给出：

1. 当前补丁是否合理。
2. `contextUsagePercentage` 是否能作为 completion marker。
3. 如果不能，应该识别哪些 upstream event 作为完成。
4. 如何处理“已经向 CLI 发出部分 delta 后才发现 upstream incomplete”。
5. 是否应该实现 early chunk buffer + retry。
6. `_monitorRequestId` 串号的最小修复方案。
7. 需要新增哪些测试用例覆盖正常流、半截流、无 usage 正常流、parser 漏事件、并发监控串号。
