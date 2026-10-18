#!/usr/bin/env python3
"""Exercise real OpenCode 2 HTTP hooks with a local Anthropic fixture.

Uses a private server, database, HOME, fake token pool and loopback backend.
Never sends fixture credentials to Anthropic or touches the user's state.
Run after pnpm build: python3 scripts/check-v2-runtime.py --opencode /path/to/opencode
"""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--opencode", default=shutil.which("opencode"))
parser.add_argument("--plugin", type=Path, help="test an extracted package instead of this checkout")
parser.add_argument("--keep", action="store_true", help="keep isolated fixture/log directory")
parser.add_argument("--long", action="store_true", help="also hold a real quota wait beyond 300 seconds")
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix="claude-v2-runtime-", dir="/tmp/opencode" if Path("/tmp/opencode").is_dir() else None))
home = root / "home"
project = root / "project"
project.mkdir()
config_dir = home / ".config/opencode"
config_dir.mkdir(parents=True)
data = home / ".local/share/opencode"
data.mkdir(parents=True)
token_file = data / "claude-auth-tokens.json"
rotation_file = data / "claude-auth-rotation.json"
wait_dir = data / "claude-auth-waits"
tokens = ["sk-ant-oat01-" + letter * 24 for letter in "ABCD"]
ids = [hashlib.sha256(token.encode()).hexdigest()[:8] for token in tokens]
calls = []
scenario = "success"
results = []
process = None
server_log = None


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(path)


def roster(count=3):
    atomic_json(token_file, {"version": 1, "accounts": [
        {"id": ids[i], "token": tokens[i], "addedAt": 1_790_000_000_000, "label": f"Fixture {i}"}
        for i in range(count)
    ]})


def wait_for(predicate, timeout=12, interval=0.025):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(interval)
    raise AssertionError("condition did not settle before timeout")


def publications():
    return list(wait_dir.glob("*.json"))


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", "0")))
        payload = json.loads(body)
        auth = self.headers.get("authorization", "").removeprefix("Bearer ")
        index = tokens.index(auth) if auth in tokens else -1
        calls.append({"account": index, "time": time.monotonic(), "body": body,
                      "beta": self.headers.get("anthropic-beta"),
                      "has_api_key": self.headers.get("x-api-key") is not None})
        assert index >= 0, "unexpected credential reached the fixture backend"
        status = 200
        if scenario == "rotate" and index < 2:
            status = 429
        elif scenario in {"wait", "clear", "add", "cancel", "long"} and len(calls) <= 3:
            status = 429
        if status == 429:
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "600" if scenario == "long" else "10")
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"rate_limit_error","message":"fixture quota"}}')
            return
        assert "x-anthropic-billing-header" in body.decode(), "subscription transformation was not applied"
        assert not self.headers.get("x-api-key"), "native API key was not stripped"
        events = [
            {"type": "message_start", "message": {"id": "msg_fixture", "type": "message", "role": "assistant",
             "model": payload["model"], "content": [], "stop_reason": None, "stop_sequence": None,
             "usage": {"input_tokens": 1, "output_tokens": 0}}},
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "PARITY_OK"}},
            {"type": "content_block_stop", "index": 0},
            {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": {"output_tokens": 1}},
            {"type": "message_stop"},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for event in events:
            self.wfile.write(f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n'.encode())
            self.wfile.flush()


backend = ThreadingHTTPServer(("127.0.0.1", 0), Backend)
threading.Thread(target=backend.serve_forever, daemon=True).start()
title_plugin = root / "title-fixture"
title_plugin.mkdir()
(title_plugin / "index.js").write_text('export default { id: "parity.title", async setup(ctx) { await ctx.session.hook("title", (event) => { event.result = "Parity runtime fixture" }) } }\n')
atomic_json(config_dir / "opencode.json", {
    "$schema": "https://opencode.ai/config.json",
    "plugins": ["*", str(args.plugin.resolve() if args.plugin else repo), str(title_plugin)],
    "model": "anthropic/claude-haiku-4-5",
    "providers": {"anthropic": {"settings": {"baseURL": f"http://127.0.0.1:{backend.server_port}/v1"}}},
    "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
    "update": "disable",
})
env = {key: value for key, value in os.environ.items() if key in ["PATH", "LANG", "SHELL", "TERM", "LD_LIBRARY_PATH"]}
env.update({
    "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
    "XDG_DATA_HOME": str(home / ".local/share"), "XDG_STATE_HOME": str(home / ".local/state"),
    "XDG_CACHE_HOME": str(home / ".cache"), "OPENCODE_DB": str(root / "fixture.db"),
    "CLAUDE_CONFIG_DIR": str(home / ".claude"), "CLAUDE_AUTH_DEBUG": "1",
    "OPENCODE_CLAUDE_AUTH_TOKENS_FILE": str(token_file),
    "OPENCODE_CLAUDE_AUTH_ROTATION_FILE": str(rotation_file),
    "OPENCODE_CLAUDE_AUTH_WAIT_DIR": str(wait_dir),
    "OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS": "1200",
    "OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES": "1",
    "OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS": "50",
    "OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS": "1",
    "OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS": "1",
    "OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS": "5000",
})


def stop():
    global process, server_log
    if process is not None and process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
    if server_log:
        server_log.close()
    process = None


def start():
    global process, server_log, server_url, password
    log_path = root / "server.log"
    server_log = log_path.open("w")
    process = subprocess.Popen([args.opencode, "serve", "--hostname", "127.0.0.1", "--port", "0"],
                               cwd=project, env=env, stdout=server_log, stderr=subprocess.STDOUT,
                               start_new_session=True)
    def ready():
        text = log_path.read_text()
        match = re.search(r"server listening on (http://127.0.0.1:\d+)", text)
        secret = re.search(r"server password (\S+)", text)
        if process.poll() is not None:
            raise AssertionError(f"private server exited: {text[-1500:]}")
        return (match.group(1), secret.group(1)) if match and secret else None
    server_url, password = wait_for(ready, timeout=45)


def api(method, path, data=None):
    headers = {"Authorization": "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode(),
               "Content-Type": "application/json", "x-opencode-directory": str(project)}
    req = Request(server_url + path, data=json.dumps(data).encode() if data is not None else None,
                  headers=headers, method=method)
    try:
        with urlopen(req, timeout=15) as response:
            body = response.read()
            return json.loads(body) if body else None
    except HTTPError as error:
        raise AssertionError(f"{method} {path}: {error.code} {error.read().decode()[:500]}") from error


def session():
    sid = api("POST", "/api/session", {"title": "Isolated parity check"})["data"]["id"]
    api("POST", f"/api/session/{sid}/model", {"model": {"providerID": "anthropic", "id": "claude-haiku-4-5"}})
    api("POST", f"/api/session/{sid}/prompt", {"text": "PARITY_CONTROLLED: reply OK without tools."})
    return sid


def completed(sid, timeout=12):
    def done():
        messages = api("GET", f"/api/session/{sid}/message")["data"]
        idle = next((m for m in messages if m["type"] == "idle"), None)
        if not idle:
            return None
        assert idle["outcome"] == "succeeded", f"turn failed: {idle.get('error')}"
        text = "".join(c.get("text", "") for m in messages if m["type"] == "assistant"
                       for c in m.get("content", []) if c["type"] == "text")
        assert text == "PARITY_OK", text
        return True
    wait_for(done, timeout=timeout, interval=0.25 if timeout > 30 else 0.025)
    api("DELETE", f"/api/session/{sid}")


def reset(name):
    global scenario
    assert not publications(), "a previous turn leaked a wait publication"
    scenario = name
    calls.clear()
    roster()
    atomic_json(rotation_file, {"version": 1, "cooldowns": {}})


def passed(name):
    results.append(name)
    print("PASS", name, flush=True)


try:
    roster()
    start()
    bootstrap_data = api("POST", "/api/session", {"title": "Bootstrap isolated parity runtime"})
    bootstrap = bootstrap_data["data"]["id"]
    plugin = wait_for(lambda: next((p for p in api("GET", "/api/plugin")["data"]
                                  if p.get("id") == "griffinmartin.claude-auth"), None), timeout=45)
    assert plugin["state"]["status"] == "active", plugin
    attempt = api("POST", "/api/integration/anthropic/connect/oauth", {
        "methodID": "claude-setup-token", "answer": {"tokens": " ".join(tokens[:3])},
    })["data"]
    wait_for(lambda: api("GET", "/api/integration/anthropic")["data"]["connections"])
    api("DELETE", f"/api/session/{bootstrap}")
    passed("fresh private server loads the package and creates a marked token connection")

    reset("rotate")
    completed(session())
    assert [c["account"] for c in calls] == [0, 1, 2], [c["account"] for c in calls]
    assert len({c["body"] for c in calls}) == 1, "body changed during resends"
    assert all(c["beta"] and not c["has_api_key"] for c in calls)
    passed("real host HTTP hooks rotate A -> B -> C, preserve the body, decode streamed success")

    reset("wait")
    sid = session()
    wait_for(publications)
    assert [c["account"] for c in calls] == [0, 1, 2]
    viewer = subprocess.run(["node", str(repo / "scripts/quota-watch.mjs"), "--time-zone", "Europe/London"],
                            env=env, capture_output=True, text=True, timeout=5)
    assert viewer.returncode == 0, viewer.stderr
    assert "in-flight quota wait" in viewer.stdout, viewer.stdout
    assert "sk-ant-" not in viewer.stdout
    completed(sid)
    assert len(calls) == 4 and calls[-1]["time"] - calls[0]["time"] >= 1.0
    assert not publications()
    passed("all-account exhaustion publishes a quota-watch countdown then resumes after reset without probes")

    reset("clear")
    sid = session()
    wait_for(publications)
    state = json.loads(rotation_file.read_text())
    del state["cooldowns"][f"token:{ids[0]}"]
    changed = time.monotonic()
    atomic_json(rotation_file, state)
    completed(sid)
    assert calls[-1]["account"] == 0 and calls[-1]["time"] - changed < 0.8
    passed("a sibling clearing a cooldown wakes the real host hook early")

    reset("add")
    sid = session()
    wait_for(publications)
    changed = time.monotonic()
    roster(4)
    completed(sid)
    assert calls[-1]["account"] == 3 and calls[-1]["time"] - changed < 0.8
    passed("a newly pasted account wakes and rescues an already waiting turn")

    reset("cancel")
    sid = session()
    wait_for(publications)
    before = len(calls)
    api("POST", f"/api/session/{sid}/interrupt", {"continue": False})
    wait_for(lambda: not publications(), timeout=3)
    time.sleep(0.15)
    assert len(calls) == before, "Stop caused an unwanted extra provider request"
    api("DELETE", f"/api/session/{sid}")
    passed("Stop interrupts a held quota wait promptly and removes its countdown")

    reset("cancel")
    first = session()
    wait_for(lambda: len(publications()) == 1)
    second = session()
    wait_for(lambda: len(publications()) == 2)
    before = len(calls)
    api("POST", f"/api/session/{first}/interrupt", {"continue": False})
    wait_for(lambda: len(publications()) == 1, timeout=3)
    assert len(calls) == before, "a preflight waiter sent an exhausted-account probe"
    scenario = "success"
    state = json.loads(rotation_file.read_text())
    del state["cooldowns"][f"token:{ids[0]}"]
    atomic_json(rotation_file, state)
    completed(second)
    api("DELETE", f"/api/session/{first}")
    assert len(calls) == before + 1 and not publications()
    passed("concurrent host waits remain independent; stopping one does not cancel or erase the other")

    reset("success")
    atomic_json(rotation_file, {"version": 1, "cooldowns": {
        f"token:{ids[0]}": {"until": int(time.time() * 1000) + 60_000, "reason": "retry-after", "at": int(time.time() * 1000)},
    }})
    stop()
    start()
    completed(session())
    assert [c["account"] for c in calls] == [1], [c["account"] for c in calls]
    assert f"token:{ids[0]}" in json.loads(rotation_file.read_text())["cooldowns"]
    passed("restart retains connections/cooldowns; preflight skips A and B's success does not clear A's bench")

    attempt = api("POST", "/api/integration/anthropic/connect/oauth", {
        "methodID": "claude-token-remove", "answer": {"id": ids[1]},
    })["data"]
    wait_for(lambda: ids[1] not in [a["id"] for a in json.loads(token_file.read_text())["accounts"]])
    passed("the token-removal connect method removes the chosen stored account")
    if args.long:
        reset("long")
        env["OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS"] = "310000"
        env["OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS"] = "360000"
        stop()
        start()
        sid = session()
        wait_for(publications)
        completed(sid, timeout=350)
        assert len(calls) == 4 and calls[-1]["time"] - calls[0]["time"] >= 300
        assert not publications()
        passed("a real held quota wait crosses 300 seconds and completes without a provider probe storm")
    print(json.dumps({"passed": len(results), "checks": results}, indent=2))
finally:
    stop()
    backend.shutdown()
    backend.server_close()
    if args.keep:
        print("Fixture logs:", root)
    else:
        shutil.rmtree(root)
