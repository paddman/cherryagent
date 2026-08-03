import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenAICompatibleProvider, OpenAICompatibleProviderError } from "./OpenAICompatibleProvider.js";

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port");
  return address.port;
}

test("times out when response headers arrive but the body stalls", async (context) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"choices":[');
  });
  const port = await listen(server);
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const provider = new OpenAICompatibleProvider({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "local",
    model: "test-model",
    timeoutMs: 1_000,
  });

  const startedAt = Date.now();
  await assert.rejects(
    () => provider.complete({ messages: [{ role: "user", content: "hello" }], tools: [] }),
    (error: unknown) => error instanceof OpenAICompatibleProviderError && error.timedOut,
  );
  assert.ok(Date.now() - startedAt < 3_000);
});
