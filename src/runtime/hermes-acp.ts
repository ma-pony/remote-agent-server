import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ADAPTER = `"""Preserve Hermes' structured turn failures at the ACP boundary."""
from acp.exceptions import RequestError
from acp_adapter import entry, server


class ManagedHermesACPAgent(server.HermesACPAgent):
    async def prompt(self, prompt, session_id, **kwargs):
        state = self.session_manager.get_session(session_id)
        if state is None:
            return await super().prompt(prompt, session_id, **kwargs)

        agent = state.agent
        original = agent.run_conversation
        failed = False

        def run_conversation(*args, **kwargs):
            nonlocal failed
            try:
                result = original(*args, **kwargs)
            except Exception:
                failed = True
                raise
            failed = result.get("failed") is True
            return result

        agent.run_conversation = run_conversation
        try:
            response = await super().prompt(prompt, session_id, **kwargs)
        finally:
            agent.run_conversation = original

        # Native prompt() has already saved history and released the running state.
        if failed and response.stop_reason != "cancelled":
            raise RequestError(-32603, "Hermes upstream request failed")
        return response


server.HermesACPAgent = ManagedHermesACPAgent
entry.main()
`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Use the installed Hermes CLI's Python environment without changing its files. */
export const prepareHermesAcp = async (home: string): Promise<string> => {
  const path = join(home, "remote-agent-acp.py");
  await writeFile(path, ADAPTER, { mode: 0o600 });
  const launch = [
    "hermes=$(command -v hermes) || exit 127",
    'IFS= read -r interpreter < "$hermes"',
    'case "$interpreter" in',
    '  "#!"*python*) interpreter=${interpreter#\\#!} ;;',
    '  *) echo "Hermes must use its Python CLI entry point" >&2; exit 1 ;;',
    "esac",
    // Word splitting matches a Python shebang, including /usr/bin/env python3.
    'exec $interpreter "$1"'
  ].join("\n");
  return `sh -c ${shellQuote(launch)} hermes-acp ${shellQuote(path)}`;
};
