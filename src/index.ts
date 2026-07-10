import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createRuntime } from "./bootstrap.js";

const { agent, tools } = await createRuntime();
const terminal = createInterface({ input, output });

console.log(`CherryAgent ready with ${tools.list().length} tools.`);
console.log("Type /exit to quit.\n");

try {
  while (true) {
    const message = (await terminal.question("You > ")).trim();
    if (!message) continue;
    if (message === "/exit" || message === "/quit") break;

    try {
      const result = await agent.run(message, { sessionId: "cli-session", userId: "local-user" });
      console.log(`\nCherry > ${result.answer}`);
      console.log(`[${result.steps} agent step${result.steps === 1 ? "" : "s"}]\n`);
    } catch (error) {
      console.error("\nCherryAgent error:", error instanceof Error ? error.message : String(error), "\n");
    }
  }
} finally {
  terminal.close();
}
