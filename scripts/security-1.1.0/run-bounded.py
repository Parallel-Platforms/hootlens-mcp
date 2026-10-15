import hashlib
import json
import os
import pathlib
import subprocess
import sys
from datetime import datetime, timezone

# The Node helper has protocol, subprocess and overall deadlines. This outer
# deadline kills only this invocation's owned process tree if cleanup stalls.
invocation_path, invocation_sha256 = sys.argv[1:]
invocation_bytes = pathlib.Path(invocation_path).resolve().read_bytes()
if hashlib.sha256(invocation_bytes).hexdigest() != invocation_sha256:
    raise ValueError("Reviewed invocation hash mismatch")
invocation = json.loads(invocation_bytes)
if invocation["schemaVersion"] != 1:
    raise ValueError("Unknown invocation schema")
if pathlib.Path(invocation["wrapper"]).resolve() != pathlib.Path(__file__).resolve():
    raise ValueError("Reviewed wrapper path mismatch")
for binding in invocation["bindings"]:
    if hashlib.sha256(pathlib.Path(binding["path"]).read_bytes()).hexdigest() != binding["sha256"]:
        raise ValueError("Frozen input mismatch: " + binding["name"])
node, helper = invocation["node"], invocation["helper"]
destination = pathlib.Path(invocation["output"]).resolve()
destination.mkdir(parents=True, exist_ok=True)
reservation = destination / "wrapper.lock"
with reservation.open("x", encoding="utf-8") as handle:
    json.dump({"startedAt": datetime.now(timezone.utc).isoformat(),
               "helperSha256": hashlib.sha256(pathlib.Path(helper).read_bytes()).hexdigest()}, handle)
env = {key: value for key, value in os.environ.items()
       if key.lower() in ("path", "systemroot", "temp", "tmp", "comspec")}
argv = [node, helper, str(pathlib.Path(invocation_path).resolve()), invocation_sha256]
child = None
result = {"startedAt": datetime.now(timezone.utc).isoformat(),
          "invocationSha256": invocation_sha256,
          "timeoutSeconds": 270, "automaticRetries": 0, "stopAttempted": False}
stdout = b""
stderr = b""

def stop_owned_tree():
    if child is None or child.poll() is not None or result["stopAttempted"]:
        return
    result["stopAttempted"] = True
    try:
        if os.name == "nt":
            stopped = subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"],
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            result["treeTerminationExitCode"] = stopped.returncode
    except Exception as error:
        result["treeTerminationError"] = str(error)
    if child.poll() is None:
        try:
            child.kill()
        except Exception as error:
            result["fallbackKillError"] = str(error)

def drain_stopped_child():
    global stdout, stderr
    if child is None:
        return
    try:
        stdout, stderr = child.communicate(timeout=10)
    except Exception as error:
        result["finalCommunicateError"] = str(error)
        try:
            child.wait(timeout=5)
        except Exception as wait_error:
            result["finalWaitError"] = str(wait_error)

try:
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    result["pid"] = child.pid
    stdout, stderr = child.communicate(timeout=270)
    result["exitCode"] = child.returncode
except subprocess.TimeoutExpired:
    result["timedOut"] = True
    stop_owned_tree()
    drain_stopped_child()
    result["exitCode"] = child.returncode
except Exception as error:
    result["error"] = str(error)
    stop_owned_tree()
    drain_stopped_child()
    result["exitCode"] = child.returncode if child is not None else None
finally:
    if child is not None and child.poll() is None:
        stop_owned_tree()
        drain_stopped_child()
    result["closed"] = child is None or child.poll() is not None
    result["unresolvedPid"] = child.pid if child is not None and not result["closed"] else None
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    (destination / "wrapper.stdout.txt").write_bytes(stdout)
    (destination / "wrapper.stderr.txt").write_bytes(stderr)
    (destination / "wrapper-result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
print(json.dumps(result))
sys.exit(0 if result.get("exitCode") == 0 and result["closed"] and not result.get("timedOut") and not result.get("error") else 1)
