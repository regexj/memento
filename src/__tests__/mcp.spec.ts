import { logger } from "../logger.ts";
import { createMcpClientManager } from "../mcp.ts";
import type { McpServerConfig } from "../types.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts");

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  const Client = vi.fn(function (this: {
    connect: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }) {
    this.connect = vi.fn().mockResolvedValue(undefined);
    this.callTool = vi.fn().mockResolvedValue({ ok: true });
    this.close = vi.fn().mockResolvedValue(undefined);
  });
  return { Client };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  const StdioClientTransport = vi.fn(function (this: {
    start: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.send = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
  });
  return { StdioClientTransport };
});

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
  const StreamableHTTPClientTransport = vi.fn(function (this: {
    start: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }) {
    this.start = vi.fn().mockResolvedValue(undefined);
    this.send = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn().mockResolvedValue(undefined);
  });
  return { StreamableHTTPClientTransport };
});

const MockedClient = vi.mocked(Client);
const MockedStdio = vi.mocked(StdioClientTransport);
const MockedHttp = vi.mocked(StreamableHTTPClientTransport);

function fakeTransport(): Transport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Transport;
}

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): Client {
  const client: FakeClient = {
    connect: overrides.connect ?? vi.fn().mockResolvedValue(undefined),
    callTool: overrides.callTool ?? vi.fn().mockResolvedValue({ ok: true }),
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
  };
  return client as unknown as Client;
}

const STDIO_CONFIG: McpServerConfig = {
  name: "test-stdio",
  command: "node",
  args: ["server.js"],
  toolCalls: [],
};

const HTTP_CONFIG: McpServerConfig = {
  name: "test-http",
  url: "https://example.com/mcp",
  toolCalls: [],
};

describe("createMcpClientManager.connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a connected client on first attempt success", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockReturnValue(client);
    const createTransport = vi.fn().mockImplementation(fakeTransport);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport,
    });

    const result = await manager.connect(STDIO_CONFIG);

    expect(result).toBe(client);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith(STDIO_CONFIG);
    expect((client as unknown as FakeClient).connect).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Connected to MCP server "test-stdio"'),
    );
  });

  it("retries once after the configured delay when the first attempt fails", async () => {
    vi.useFakeTimers();

    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const succeedingClient = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(succeedingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 5000,
      createClient,
      createTransport: fakeTransport,
    });

    const connectPromise = manager.connect(STDIO_CONFIG);

    // First attempt fails immediately; retry should wait exactly retryDelayMs.
    await vi.advanceTimersByTimeAsync(0);
    expect(
      (failingClient as unknown as FakeClient).connect,
    ).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 5000ms"),
      "boom",
    );

    await vi.advanceTimersByTimeAsync(5000);
    const result = await connectPromise;

    expect(result).toBe(succeedingClient);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(
      (succeedingClient as unknown as FakeClient).connect,
    ).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("on retry"),
    );
  });

  it("logs non-Error rejection reasons via String() coercion on the first attempt", async () => {
    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue("raw string failure"),
    });
    const succeedingClient = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(succeedingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await manager.connect(STDIO_CONFIG);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying in 0ms"),
      "raw string failure",
    );
  });

  it("throws and logs an error if the retry also fails", async () => {
    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error("still down")),
    });
    const createClient = vi.fn().mockReturnValue(failingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await expect(manager.connect(STDIO_CONFIG)).rejects.toThrow("still down");
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed after retry"),
      "still down",
    );
  });

  it("logs non-Error rejection reasons via String() coercion on retry failure", async () => {
    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue("second failure"),
    });
    const createClient = vi.fn().mockReturnValue(failingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await expect(manager.connect(STDIO_CONFIG)).rejects.toBe("second failure");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("failed after retry"),
      "second failure",
    );
  });

  it("uses the provided transport factory for both stdio and http server configs", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockReturnValue(client);
    const createTransport = vi.fn().mockImplementation(fakeTransport);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport,
    });

    await manager.connect(STDIO_CONFIG);
    await manager.connect(HTTP_CONFIG);

    expect(createTransport).toHaveBeenNthCalledWith(1, STDIO_CONFIG);
    expect(createTransport).toHaveBeenNthCalledWith(2, HTTP_CONFIG);
  });
});

describe("createMcpClientManager.callTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to client.callTool with correct arguments and returns the result", async () => {
    const fakeResult = { content: [{ type: "text", text: "ok" }] };
    const client = fakeClient({
      callTool: vi.fn().mockResolvedValue(fakeResult),
    });

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient: () => client,
      createTransport: fakeTransport,
    });

    const args = { query: "test", limit: 10 };
    const result = await manager.callTool(client, "search", args);

    expect(result).toBe(fakeResult);
    expect((client as unknown as FakeClient).callTool).toHaveBeenCalledWith({
      name: "search",
      arguments: args,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Calling MCP tool "search"'),
    );
  });

  it("propagates errors thrown by client.callTool", async () => {
    const client = fakeClient({
      callTool: vi.fn().mockRejectedValue(new Error("tool failed")),
    });

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient: () => client,
      createTransport: fakeTransport,
    });

    await expect(manager.callTool(client, "broken", {})).rejects.toThrow(
      "tool failed",
    );
  });
});

describe("createMcpClientManager.connect caching by server name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the cached client on subsequent connect calls for the same server name", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockReturnValue(client);
    const createTransport = vi.fn().mockImplementation(fakeTransport);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport,
    });

    const first = await manager.connect({ ...STDIO_CONFIG, name: "shared" });
    const second = await manager.connect({ ...STDIO_CONFIG, name: "shared" });

    expect(first).toBe(second);
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect((client as unknown as FakeClient).connect).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Reusing existing MCP client for server "shared"',
      ),
    );
  });

  it("creates distinct clients for different server names", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    const first = await manager.connect({ ...STDIO_CONFIG, name: "a" });
    const second = await manager.connect({ ...STDIO_CONFIG, name: "b" });

    expect(first).toBe(clientA);
    expect(second).toBe(clientB);
    expect(first).not.toBe(second);
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it("closes the underlying client exactly once on disconnectAll when the same name was connected multiple times", async () => {
    const client = fakeClient();
    const createClient = vi.fn().mockReturnValue(client);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await manager.connect({ ...STDIO_CONFIG, name: "shared" });
    await manager.connect({ ...STDIO_CONFIG, name: "shared" });
    await manager.connect({ ...STDIO_CONFIG, name: "shared" });
    await manager.disconnectAll();

    expect((client as unknown as FakeClient).close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Disconnected 1 MCP client(s)");
  });

  it("does not populate the cache when a connect attempt fails after retry", async () => {
    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const succeedingClient = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(succeedingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await expect(
      manager.connect({ ...STDIO_CONFIG, name: "x" }),
    ).rejects.toThrow("nope");

    const result = await manager.connect({ ...STDIO_CONFIG, name: "x" });

    expect(result).toBe(succeedingClient);
    expect(createClient).toHaveBeenCalledTimes(3);
    expect(
      (succeedingClient as unknown as FakeClient).connect,
    ).toHaveBeenCalledTimes(1);
  });

  it("clears the cache on disconnectAll so a subsequent connect opens a fresh client", async () => {
    const firstClient = fakeClient();
    const secondClient = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    const first = await manager.connect({ ...STDIO_CONFIG, name: "shared" });
    await manager.disconnectAll();
    const second = await manager.connect({ ...STDIO_CONFIG, name: "shared" });

    expect(first).toBe(firstClient);
    expect(second).toBe(secondClient);
    expect(first).not.toBe(second);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(
      (secondClient as unknown as FakeClient).connect,
    ).toHaveBeenCalledTimes(1);
  });
});

describe("createMcpClientManager.disconnectAll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("closes every connected client and clears internal state", async () => {
    const clientA = fakeClient();
    const clientB = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(clientA)
      .mockReturnValueOnce(clientB);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await manager.connect({ ...STDIO_CONFIG, name: "a" });
    await manager.connect({ ...STDIO_CONFIG, name: "b" });
    await manager.disconnectAll();

    expect((clientA as unknown as FakeClient).close).toHaveBeenCalledTimes(1);
    expect((clientB as unknown as FakeClient).close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Disconnected 2 MCP client(s)");

    // Second disconnectAll should be a no-op after clients were cleared.
    await manager.disconnectAll();
    expect((clientA as unknown as FakeClient).close).toHaveBeenCalledTimes(1);
    expect((clientB as unknown as FakeClient).close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith("Disconnected 0 MCP client(s)");
  });

  it("logs a warning when a client fails to close but still closes the rest", async () => {
    const failingClient = fakeClient({
      close: vi.fn().mockRejectedValue(new Error("close failed")),
    });
    const healthyClient = fakeClient();
    const createClient = vi
      .fn()
      .mockReturnValueOnce(failingClient)
      .mockReturnValueOnce(healthyClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await manager.connect({ ...STDIO_CONFIG, name: "fail" });
    await manager.connect({ ...STDIO_CONFIG, name: "ok" });
    await manager.disconnectAll();

    expect(
      (failingClient as unknown as FakeClient).close,
    ).toHaveBeenCalledTimes(1);
    expect(
      (healthyClient as unknown as FakeClient).close,
    ).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Error while disconnecting MCP client",
      "close failed",
    );
  });

  it("coerces non-Error close rejection reasons via String()", async () => {
    const failingClient = fakeClient({
      close: vi.fn().mockRejectedValue("disconnect string"),
    });
    const createClient = vi.fn().mockReturnValue(failingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await manager.connect(STDIO_CONFIG);
    await manager.disconnectAll();

    expect(logger.warn).toHaveBeenCalledWith(
      "Error while disconnecting MCP client",
      "disconnect string",
    );
  });

  it("does not retain clients from failed connect attempts", async () => {
    const failingClient = fakeClient({
      connect: vi.fn().mockRejectedValue(new Error("nope")),
    });
    const createClient = vi.fn().mockReturnValue(failingClient);

    const manager = createMcpClientManager({
      retryDelayMs: 0,
      createClient,
      createTransport: fakeTransport,
    });

    await expect(manager.connect(STDIO_CONFIG)).rejects.toThrow("nope");
    await manager.disconnectAll();

    expect(
      (failingClient as unknown as FakeClient).close,
    ).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Disconnected 0 MCP client(s)");
  });
});

describe("createMcpClientManager default factories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("instantiates the MCP Client with memento identity when no factory is supplied", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });

    await manager.connect(STDIO_CONFIG);

    expect(MockedClient).toHaveBeenCalledTimes(1);
    expect(MockedClient).toHaveBeenCalledWith(
      { name: "memento", version: "1.0.0" },
      { capabilities: {} },
    );
  });

  it("creates a StdioClientTransport when the server config has a command", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });

    await manager.connect(STDIO_CONFIG);

    expect(MockedStdio).toHaveBeenCalledTimes(1);
    expect(MockedStdio).toHaveBeenCalledWith({
      command: "node",
      args: ["server.js"],
    });
    expect(MockedHttp).not.toHaveBeenCalled();
  });

  it("passes env through to StdioClientTransport when provided", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });
    const configWithEnv: McpServerConfig = {
      name: "with-env",
      command: "node",
      env: { TOKEN: "abc" },
      toolCalls: [],
    };

    await manager.connect(configWithEnv);

    expect(MockedStdio).toHaveBeenCalledWith({
      command: "node",
      env: { TOKEN: "abc" },
    });
  });

  it("creates a StreamableHTTPClientTransport when the server config has a url", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });

    await manager.connect(HTTP_CONFIG);

    expect(MockedHttp).toHaveBeenCalledTimes(1);
    const [urlArg, optionsArg] = MockedHttp.mock.calls[0]!;
    expect(urlArg).toBeInstanceOf(URL);
    expect((urlArg as URL).toString()).toBe("https://example.com/mcp");
    expect(optionsArg).toBeUndefined();
    expect(MockedStdio).not.toHaveBeenCalled();
  });

  it("passes headers through to StreamableHTTPClientTransport via requestInit when provided", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });
    const configWithHeaders: McpServerConfig = {
      name: "with-headers",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
      toolCalls: [],
    };

    await manager.connect(configWithHeaders);

    expect(MockedHttp).toHaveBeenCalledTimes(1);
    const [urlArg, optionsArg] = MockedHttp.mock.calls[0]!;
    expect(urlArg).toBeInstanceOf(URL);
    expect((urlArg as URL).toString()).toBe("https://example.com/mcp");
    expect(optionsArg).toEqual({
      requestInit: { headers: { Authorization: "Bearer token" } },
    });
  });

  it("throws when a server config has neither command nor url", async () => {
    const manager = createMcpClientManager({ retryDelayMs: 0 });

    const invalidConfig: McpServerConfig = {
      name: "broken",
      toolCalls: [],
    };

    await expect(manager.connect(invalidConfig)).rejects.toThrow(
      /must include either "command" \(stdio\) or "url" \(streamable HTTP\)\./,
    );
  });

  it("uses the default retry delay of 5000ms when retryDelayMs is not provided", async () => {
    vi.useFakeTimers();
    try {
      const failingConnect = vi
        .fn()
        .mockRejectedValueOnce(new Error("first"))
        .mockResolvedValueOnce(undefined);
      MockedClient.mockImplementationOnce(function (this: {
        connect: ReturnType<typeof vi.fn>;
        callTool: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      }) {
        this.connect = failingConnect;
        this.callTool = vi.fn();
        this.close = vi.fn().mockResolvedValue(undefined);
      } as unknown as (
        ...args: ConstructorParameters<typeof Client>
      ) => Client);

      const manager = createMcpClientManager();
      const connectPromise = manager.connect(STDIO_CONFIG);

      await vi.advanceTimersByTimeAsync(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying in 5000ms"),
        "first",
      );

      await vi.advanceTimersByTimeAsync(5000);
      await connectPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});
