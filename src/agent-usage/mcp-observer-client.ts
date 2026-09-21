import { createConnection } from "node:net";
import type { McpObservation, McpObserverConfig } from "./mcp-observer.js";

/** A bounded acknowledgement guarantees start is persisted before the upstream call. Failure never alters its result. */
export const sendMcpObservation = (config: McpObserverConfig, event: McpObservation): Promise<void> => new Promise((resolve) => {
  const socket = createConnection(config.socketPath);
  const done = () => { socket.destroy(); resolve(); };
  socket.setTimeout(250, done);
  socket.once("error", done);
  socket.once("data", done);
  socket.once("close", resolve);
  socket.once("connect", () => socket.write(`${JSON.stringify({ token: config.token, event })}\n`));
});
