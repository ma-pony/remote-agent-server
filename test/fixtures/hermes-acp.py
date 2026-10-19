"""Small native ACP boundary fixture; no model or Hermes installation needed."""
import asyncio
import json
import runpy
import sys
from types import ModuleType, SimpleNamespace


class RequestError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class HermesACPAgent:
    def __init__(self):
        self.state = SimpleNamespace(agent=SimpleNamespace(), history=[], is_running=False)
        self.session_manager = SimpleNamespace(get_session=lambda _: self.state)

    async def prompt(self, prompt, session_id, **kwargs):
        state = self.state
        state.is_running = True
        try:
            result = await asyncio.to_thread(state.agent.run_conversation)
        except Exception:
            # Hermes currently converts an exception to ordinary text as well.
            result = {"final_response": "Error: private exception details"}
        state.history.append(result)
        state.is_running = False
        return SimpleNamespace(stop_reason="cancelled" if prompt == "cancel" else "end_turn")


async def check():
    agent = server.HermesACPAgent()
    outcomes = []

    async def turn(result, prompt="go"):
        def run():
            if isinstance(result, Exception):
                raise result
            return result

        agent.state.agent.run_conversation = run
        try:
            response = await agent.prompt(prompt, "session")
            outcomes.append({"stopReason": response.stop_reason})
        except RequestError as error:
            outcomes.append({"code": error.code, "message": str(error)})
        assert agent.state.agent.run_conversation is run
        assert not agent.state.is_running

    await turn({"failed": True, "completed": False, "error": "private upstream details"})
    # A successful turn in the same Session must not inherit the previous error.
    await turn({"failed": False, "completed": True, "final_response": "ok"})
    # Ordinary model text must never be interpreted as a failure.
    await turn({"final_response": "API call failed after 3 retries: fictional example"})
    await turn({"failed": True}, "cancel")
    await turn(RuntimeError("private exception details"))
    assert len(agent.state.history) == 5
    print(json.dumps(outcomes))


acp = ModuleType("acp")
exceptions = ModuleType("acp.exceptions")
exceptions.RequestError = RequestError
adapter = ModuleType("acp_adapter")
server = ModuleType("acp_adapter.server")
server.HermesACPAgent = HermesACPAgent
entry = ModuleType("acp_adapter.entry")
entry.main = lambda: asyncio.run(check())
adapter.server = server
adapter.entry = entry
sys.modules.update({
    "acp": acp, "acp.exceptions": exceptions, "acp_adapter": adapter,
    "acp_adapter.server": server, "acp_adapter.entry": entry,
})
runpy.run_path(sys.argv[1], run_name="__main__")
