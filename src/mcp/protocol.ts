// protocol.ts - The part of the Model Context Protocol this server needs: JSON-RPC 2.0 messages, one
// per line on stdin / stdout (the stdio transport), with initialize, ping, tools/list, tools/call,
// prompts/list and prompts/get (prompts: ready-made instructions a client offers as commands).
// Small enough to keep here instead of pulling in an SDK (the release is one compiled file).
// Nothing but protocol messages may be written to stdout.

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema of the arguments (type "object")
  annotations?: ToolAnnotations;
  // Returns the text of the result (objects are sent as JSON). Throwing makes an error result the
  // model can read (bad arguments, nothing open...), not a protocol error.
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description: string;
  arguments?: McpPromptArgument[];
  // The text of the user message the prompt becomes. Throwing: an invalid-params error.
  get(args: Record<string, string>): string;
}

export interface McpServerOptions {
  name: string;
  version: string;
  instructions: string; // how to use the tools, given to the model when it connects
  tools: McpTool[];
  prompts?: McpPrompt[];
}

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_VERSION = "2025-06-18";

const reply = (id: Message["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Message["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function createMcpServer(opts: McpServerOptions) {
  const tools = new Map(opts.tools.map((t) => [t.name, t]));
  const prompts = new Map((opts.prompts ?? []).map((p) => [p.name, p]));

  // One incoming message -> the response to send (null for notifications and responses).
  async function handle(msg: unknown): Promise<object | null> {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return failure(null, -32600, "Invalid request");
    const { id, method, params = {} } = msg as Message;
    if (typeof method !== "string") return null; // a response to something we never sent
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return null; // notifications/initialized, notifications/cancelled...

    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false }, ...(prompts.size ? { prompts: { listChanged: false } } : {}) },
          serverInfo: { name: opts.name, version: opts.version },
          instructions: opts.instructions,
        });
      }
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
        });
      case "tools/call": {
        const tool = typeof params.name === "string" ? tools.get(params.name) : undefined;
        if (!tool) return failure(id, -32602, `Unknown tool: ${String(params.name)}`);
        const args = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
        try {
          const out = await tool.run(args);
          return reply(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] });
        } catch (e) {
          return reply(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
        }
      }
      case "prompts/list":
        return reply(id, {
          prompts: [...prompts.values()].map((p) => ({
            name: p.name,
            ...(p.title ? { title: p.title } : {}),
            description: p.description,
            arguments: p.arguments ?? [],
          })),
        });
      case "prompts/get": {
        const prompt = typeof params.name === "string" ? prompts.get(params.name) : undefined;
        if (!prompt) return failure(id, -32602, `Unknown prompt: ${String(params.name)}`);
        const raw = typeof params.arguments === "object" && params.arguments !== null ? (params.arguments as Record<string, unknown>) : {};
        const args = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v.trim() : String(v ?? "")]));
        for (const a of prompt.arguments ?? []) if (a.required && !args[a.name]) return failure(id, -32602, `Missing argument: ${a.name}`);
        try {
          return reply(id, { description: prompt.description, messages: [{ role: "user", content: { type: "text", text: prompt.get(args) } }] });
        } catch (e) {
          return failure(id, -32602, e instanceof Error ? e.message : String(e));
        }
      }
      default:
        return failure(id, -32601, `Method not found: ${method}`);
    }
  }

  // One line of input -> the lines to write (a JSON-RPC batch is answered as one array).
  async function handleLine(line: string): Promise<string | null> {
    if (!line.trim()) return null;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify(failure(null, -32700, "Parse error"));
    }
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handle))).filter((r) => r !== null);
      return out.length ? JSON.stringify(out) : null;
    }
    const out = await handle(msg);
    return out ? JSON.stringify(out) : null;
  }

  return { handle, handleLine };
}

// Serve on stdin / stdout until stdin closes. Messages are handled one at a time, in order.
export async function serveStdio(server: ReturnType<typeof createMcpServer>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const out = await server.handleLine(line);
      if (out) process.stdout.write(`${out}\n`);
    }
  }
  const last = await server.handleLine(buffer);
  if (last) process.stdout.write(`${last}\n`);
}
