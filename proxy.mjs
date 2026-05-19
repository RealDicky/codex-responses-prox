import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

// --- Config ---
const PORT = parseInt(process.env.PORT || "31415", 10);

const MODEL_ROUTING = (() => {
  const raw = process.env.MODEL_ROUTING;
  if (raw) {
    try { return JSON.parse(raw); } catch { console.error("Invalid MODEL_ROUTING JSON"); return {}; }
  }
  const routing = {};
  const model = process.env.UPSTREAM_MODEL || "astron-code-latest";
  routing[model] = {
    base_url: (process.env.UPSTREAM_BASE_URL || "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2").replace(/\/+$/, ""),
    api_key: process.env.UPSTREAM_API_KEY || "",
    upstream_model: model,
  };
  return routing;
})();

function getProvider(modelName) {
  if (MODEL_ROUTING[modelName]) return MODEL_ROUTING[modelName];
  for (const key of Object.keys(MODEL_ROUTING)) {
    if (modelName.startsWith(key.split("-")[0])) return MODEL_ROUTING[key];
  }
  const firstKey = Object.keys(MODEL_ROUTING)[0];
  return firstKey ? MODEL_ROUTING[firstKey] : null;
}

function allModels() {
  return Object.keys(MODEL_ROUTING);
}

// --- Session store (for /health reporting only) ---
const sessions = new Map();
const MAX_SESSIONS = 100;
function saveSession(responseId, messages) {
  sessions.set(responseId, { messages, ts: Date.now() });
  if (sessions.size > MAX_SESSIONS) {
    let oldestK, oldestT = Infinity;
    for (const [k, v] of sessions) { if (v.ts < oldestT) { oldestT = v.ts; oldestK = k; } }
    if (oldestK) sessions.delete(oldestK);
  }
}

// --- Reasoning content store ---
// DeepSeek thinking mode returns `reasoning_content` alongside tool_calls and
// requires it to be passed back verbatim in subsequent requests as part of the
// assistant message.  Codex never echoes it (it doesn't appear in the Responses
// API output we send), so we cache it here by call_id and re-inject it when
// rebuilding the assistant message in toChatCompletions.
const toolCallReasoning = new Map();
const MAX_REASONING = 500;

function saveReasoning(callIds, reasoningContent) {
  if (!reasoningContent || !callIds.length) return;
  for (const id of callIds) toolCallReasoning.set(id, reasoningContent);
  if (toolCallReasoning.size > MAX_REASONING) {
    let n = toolCallReasoning.size - MAX_REASONING;
    for (const k of toolCallReasoning.keys()) { toolCallReasoning.delete(k); if (--n <= 0) break; }
  }
}

function getReasoning(callIds) {
  for (const id of callIds) { const r = toolCallReasoning.get(id); if (r) return r; }
  return null;
}

// --- Helpers ---
function genId(prefix = "resp") {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function jsonRes(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// --- Convert Responses API request → Chat Completions request ---
//
// Codex uses the Responses API in stateless mode (no previous_response_id).
// Each request's `input` array already contains the full conversation history,
// including prior assistant tool calls as `function_call` items.  We must
// convert them properly; consecutive function_call items get grouped into a
// single assistant message (Chat Completions requires one assistant message
// with all tool_calls, followed by one tool message per call_id).
function toChatCompletions(reqBody, provider) {
  const messages = [];

  if (reqBody.instructions) {
    messages.push({ role: "system", content: reqBody.instructions });
  }

  const input = reqBody.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    // Buffer consecutive function_call items so they emit as one assistant message.
    const pendingToolCalls = [];

    const flushToolCalls = () => {
      if (pendingToolCalls.length > 0) {
        const msg = { role: "assistant", content: null, tool_calls: [...pendingToolCalls] };
        // DeepSeek thinking mode: re-attach reasoning_content so upstream doesn't reject
        const reasoning = getReasoning(pendingToolCalls.map((tc) => tc.id));
        if (reasoning) msg.reasoning_content = reasoning;
        messages.push(msg);
        pendingToolCalls.length = 0;
      }
    };

    for (const item of input) {
      if (typeof item === "string") {
        flushToolCalls();
        messages.push({ role: "user", content: item });
      } else if (item.type === "message") {
        flushToolCalls();
        const content = Array.isArray(item.content)
          ? item.content.filter((c) => c.type === "input_text").map((c) => c.text).join("\n")
          : item.content;
        if (item.role === "user") {
          messages.push({ role: "user", content });
        } else if (item.role === "assistant") {
          messages.push({ role: "assistant", content });
        }
        // system items inside input are rare but harmless to skip
      } else if (item.type === "function_call") {
        // Responses API: represents a previous assistant tool call in the history.
        // Buffer for grouping — consecutive calls belong to the same assistant turn.
        pendingToolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        });
      } else if (item.type === "function_call_output") {
        // Must be preceded by the matching assistant tool_calls message.
        // Inject reasoning_content if DeepSeek thinking mode was used for that turn.
        flushToolCalls();
        messages.push({ role: "tool", content: item.output, tool_call_id: item.call_id });
      }
      // Other item types (reasoning, web_search_call, …) are silently skipped.
    }
    flushToolCalls();
  }

  const ccReq = {
    model: provider.upstream_model || reqBody.model,
    messages,
    stream: reqBody.stream ?? false,
  };

  if (reqBody.max_output_tokens) ccReq.max_tokens = reqBody.max_output_tokens;
  if (reqBody.temperature !== undefined) ccReq.temperature = reqBody.temperature;
  if (reqBody.top_p !== undefined) ccReq.top_p = reqBody.top_p;

  if (reqBody.tools && reqBody.tools.length > 0) {
    // Responses API tool shape: { type, name, description, parameters }
    // Chat Completions tool shape: { type, function: { name, description, parameters } }
    ccReq.tools = reqBody.tools
      .filter((t) => t.type === "function")
      .map(({ type: _t, ...rest }) => ({ type: "function", function: rest }));
    if (reqBody.tool_choice) ccReq.tool_choice = reqBody.tool_choice;
  }

  return ccReq;
}

// --- Convert Chat Completions response → Responses API response ---
function toResponsesAPI(ccResp, model) {
  const choice = ccResp.choices?.[0];
  const msg = choice?.message;
  const output = [];

  if (msg) {
    if (msg.content) {
      output.push({
        type: "message",
        id: genId("msg"),
        role: "assistant",
        content: [{ type: "output_text", text: msg.content }],
        status: "completed",
      });
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        output.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
          status: "completed",
        });
      }
    }
  }

  return {
    id: genId("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || ccResp.model,
    status: "completed",
    output,
    usage: {
      input_tokens: ccResp.usage?.prompt_tokens || 0,
      output_tokens: ccResp.usage?.completion_tokens || 0,
      total_tokens: ccResp.usage?.total_tokens || 0,
    },
  };
}

// --- SSE helpers ---
function sseLine(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// --- Stream Chat Completions → Stream Responses API ---
function handleStream(upstreamUrl, apiKey, ccReq, reqBody, res) {
  const respId = genId("resp");
  const msgId = genId("msg");
  const model = reqBody.model;
  const createdAt = Math.floor(Date.now() / 1000);

  const url = new URL(upstreamUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    if (upstreamRes.statusCode !== 200) {
      let errBody = "";
      upstreamRes.on("data", (c) => (errBody += c));
      upstreamRes.on("end", () => {
        console.error(`Upstream error ${upstreamRes.statusCode}: ${errBody.slice(0, 500)}`);
        jsonRes(res, upstreamRes.statusCode, {
          error: { message: `Upstream returned ${upstreamRes.statusCode}: ${errBody.slice(0, 500)}` },
        });
      });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const responseObj = {
      id: respId,
      object: "response",
      created_at: createdAt,
      model,
      status: "queued",
      output: [],
      usage: null,
    };

    // response.created
    res.write(sseLine("response.created", { type: "response.created", response: { ...responseObj } }));

    // response.in_progress
    responseObj.status = "in_progress";
    res.write(sseLine("response.in_progress", { type: "response.in_progress", response: { ...responseObj } }));

    let buffer = "";
    let textStarted = false;
    let totalContent = "";
    let totalReasoning = "";
    let toolCalls = [];
    let usage = null;
    let outputIndex = 0;

    upstreamRes.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") continue;

        let ccChunk;
        try { ccChunk = JSON.parse(data); } catch { continue; }

        if (ccChunk.usage) usage = ccChunk.usage;

        const delta = ccChunk.choices?.[0]?.delta;
        if (!delta) continue;

        // --- Reasoning content (DeepSeek thinking mode) — accumulate silently ---
        if (delta.reasoning_content) totalReasoning += delta.reasoning_content;

        // --- Text content ---
        if (delta.content) {
          if (!textStarted) {
            textStarted = true;
            const msgItem = {
              type: "message",
              id: msgId,
              role: "assistant",
              content: [],
              status: "in_progress",
            };

            res.write(sseLine("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: msgItem,
            }));

            const textPart = { type: "output_text", text: "" };
            res.write(sseLine("response.content_part.added", {
              type: "response.content_part.added",
              output_index: outputIndex,
              content_index: 0,
              item_id: msgId,
              part: textPart,
            }));
          }

          totalContent += delta.content;

          res.write(sseLine("response.output_text.delta", {
            type: "response.output_text.delta",
            output_index: outputIndex,
            content_index: 0,
            item_id: msgId,
            delta: delta.content,
          }));
        }

        // --- Tool calls ---
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = { id: tc.id || genId("fc"), name: "", arguments: "", outputIdx: outputIndex + (textStarted ? 1 : 0) + idx };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function?.name) {
              toolCalls[idx].name = tc.function.name;
              const fcItem = {
                type: "function_call",
                id: toolCalls[idx].id,
                call_id: toolCalls[idx].id,
                name: tc.function.name,
                arguments: "",
                status: "in_progress",
              };
              res.write(sseLine("response.output_item.added", {
                type: "response.output_item.added",
                output_index: toolCalls[idx].outputIdx,
                item: fcItem,
              }));
            }
            if (tc.function?.arguments) {
              toolCalls[idx].arguments += tc.function.arguments;
              res.write(sseLine("response.function_call_arguments.delta", {
                type: "response.function_call_arguments.delta",
                output_index: toolCalls[idx].outputIdx,
                item_id: toolCalls[idx].id,
                delta: tc.function.arguments,
              }));
            }
          }
        }
      }
    });

    upstreamRes.on("end", () => {
      // Close text content
      if (textStarted) {
        res.write(sseLine("response.content_part.done", {
          type: "response.content_part.done",
          output_index: outputIndex,
          content_index: 0,
          item_id: msgId,
          part: { type: "output_text", text: totalContent },
        }));

        res.write(sseLine("response.output_item.done", {
          type: "response.output_item.done",
          output_index: outputIndex,
          item: {
            type: "message",
            id: msgId,
            role: "assistant",
            content: [{ type: "output_text", text: totalContent }],
            status: "completed",
          },
        }));
      }

      // Close tool calls
      for (const tc of toolCalls) {
        res.write(sseLine("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          output_index: tc.outputIdx,
          item_id: tc.id,
          arguments: tc.arguments,
        }));

        res.write(sseLine("response.output_item.done", {
          type: "response.output_item.done",
          output_index: tc.outputIdx,
          item: {
            type: "function_call",
            id: tc.id,
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            status: "completed",
          },
        }));
      }

      // Build final output
      const finalOutput = [];
      if (textStarted) {
        finalOutput.push({
          type: "message",
          id: msgId,
          role: "assistant",
          content: [{ type: "output_text", text: totalContent }],
          status: "completed",
        });
      }
      for (const tc of toolCalls) {
        finalOutput.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
          status: "completed",
        });
      }

      // Save tool_calls (and reasoning) to session store
      if (toolCalls.length > 0) {
        const callIds = toolCalls.map((tc) => tc.id);
        if (totalReasoning) saveReasoning(callIds, totalReasoning);
        const sessionMsgs = [{
          role: "assistant",
          content: totalContent || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }];
        saveSession(respId, sessionMsgs);
      }

      // response.completed
      res.write(sseLine("response.completed", {
        type: "response.completed",
        response: {
          id: respId,
          object: "response",
          created_at: createdAt,
          model,
          status: "completed",
          output: finalOutput,
          usage: {
            input_tokens: usage?.prompt_tokens || 0,
            output_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || 0,
          },
        },
      }));

      res.end();
    });
  });

  upstreamReq.on("error", (err) => {
    console.error("Upstream error:", err.message);
    if (!res.headersSent) {
      jsonRes(res, 502, { error: { message: `Upstream error: ${err.message}` } });
    } else {
      res.end();
    }
  });

  upstreamReq.write(JSON.stringify(ccReq));
  upstreamReq.end();
}

// --- Non-streaming request ---
function handleNonStream(upstreamUrl, apiKey, ccReq, reqBody, res) {
  const url = new URL(upstreamUrl);
  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };

  const upstreamReq = https.request(options, (upstreamRes) => {
    let body = "";
    upstreamRes.on("data", (chunk) => (body += chunk));
    upstreamRes.on("end", () => {
      try {
        const ccResp = JSON.parse(body);
        if (ccResp.error) {
          jsonRes(res, upstreamRes.statusCode || 500, ccResp);
          return;
        }
        const resp = toResponsesAPI(ccResp, reqBody.model);

        // Save tool_calls to session store
        const msg = ccResp.choices?.[0]?.message;
        if (msg?.tool_calls?.length > 0) {
          const callIds = msg.tool_calls.map((tc) => tc.id);
          if (msg.reasoning_content) saveReasoning(callIds, msg.reasoning_content);
          saveSession(resp.id, [{
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.function.name, arguments: tc.function.arguments },
            })),
          }]);
        }

        jsonRes(res, 200, resp);
      } catch {
        jsonRes(res, 502, { error: { message: "Invalid upstream response" } });
      }
    });
  });

  upstreamReq.on("error", (err) => {
    jsonRes(res, 502, { error: { message: `Upstream error: ${err.message}` } });
  });

  upstreamReq.write(JSON.stringify(ccReq));
  upstreamReq.end();
}

// --- HTTP Server ---
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    jsonRes(res, 200, {
      object: "list",
      data: allModels().map((id) => ({
        id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "custom",
      })),
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    jsonRes(res, 200, {
      status: "ok",
      models: allModels(),
      sessions: sessions.size,
      routing: Object.entries(MODEL_ROUTING).map(([k, v]) => ({
        model: k,
        upstream: v.base_url,
        upstream_model: v.upstream_model,
      })),
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/responses") {
    jsonRes(res, 404, { error: { message: "Not found. Use POST /v1/responses" } });
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let reqBody;
    try { reqBody = JSON.parse(body); } catch {
      jsonRes(res, 400, { error: { message: "Invalid JSON" } });
      return;
    }

    const provider = getProvider(reqBody.model);
    if (!provider) {
      jsonRes(res, 400, { error: { message: `Unknown model: ${reqBody.model}. Available: ${allModels().join(", ")}` } });
      return;
    }

    const ccReq = toChatCompletions(reqBody, provider);
    const upstreamUrl = `${provider.base_url}/chat/completions`;

    const hasToolOutputs = reqBody.input?.some?.((i) => i.type === "function_call_output");
    const msgRoles = ccReq.messages.map((m) => m.role + (m.tool_calls ? `[tc:${m.tool_calls.map((t) => t.function?.name || "?").join(",")}]` : "")).join("→");
    console.log(`[${new Date().toISOString()}] model=${reqBody.model} stream=${ccReq.stream} prev_resp=${reqBody.previous_response_id || "-"} tool_outputs=${!!hasToolOutputs} msgs=${ccReq.messages.length} [${msgRoles}]`);

    if (ccReq.stream) {
      handleStream(upstreamUrl, provider.api_key, ccReq, reqBody, res);
    } else {
      handleNonStream(upstreamUrl, provider.api_key, ccReq, reqBody, res);
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Codex Responses Proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`Models: ${allModels().join(", ")}`);
  for (const [model, prov] of Object.entries(MODEL_ROUTING)) {
    console.log(`  ${model} → ${prov.base_url}/chat/completions (upstream: ${prov.upstream_model || model})`);
  }
});
