"""RunPod handler: proves one batch, returns the seal.

Input: {"input_json_b64": ..., "auth": <PNLX_WORKER_AUTH_TOKEN when configured>}
Output: {"image_id", "journal_b64", "seal_b64", "journal_digest", "seal_digest", "duration_ms"}
Failures return generic messages only; stderr can contain witness material.
"""

import base64
import json
import os
import subprocess
import tempfile
import time

import runpod

PROVER = "/usr/local/bin/pnlx-risc0-batch-match-prover"
PROVER_TIMEOUT_SECONDS = int(os.environ.get("PNLX_WORKER_TIMEOUT_SECONDS", "1740"))
AUTH_TOKEN = os.environ.get("PNLX_WORKER_AUTH_TOKEN", "")


def check_auth(job_input: dict) -> None:
    if not AUTH_TOKEN:
        return
    if job_input.get("auth") != AUTH_TOKEN:
        raise RuntimeError("unauthorized")


def handler(job: dict) -> dict:
    job_input = job.get("input") or {}
    check_auth(job_input)

    input_json_b64 = job_input.get("input_json_b64")
    if not isinstance(input_json_b64, str) or not input_json_b64:
        return {"status": "INVALID_INPUT", "message": "input_json_b64 is required"}

    try:
        with tempfile.TemporaryDirectory(prefix="pnlx-job-") as workdir:
            input_path = os.path.join(workdir, "input.json")
            output_dir = os.path.join(workdir, "out")
            os.makedirs(output_dir, mode=0o700)
            with open(input_path, "wb") as handle:
                handle.write(base64.b64decode(input_json_b64))
            os.chmod(input_path, 0o600)

            environment = dict(os.environ)
            environment["RISC0_PROVER"] = "local"
            environment["RISC0_DEV_MODE"] = "0"

            started = time.time()
            completed = subprocess.run(
                [PROVER, input_path, output_dir],
                capture_output=True,
                text=True,
                timeout=PROVER_TIMEOUT_SECONDS,
                env=environment,
            )
            duration_ms = int((time.time() - started) * 1000)

            if completed.returncode != 0:
                return {
                    "status": "PROVER_FAILED",
                    "message": "prover execution failed",
                    "duration_ms": duration_ms,
                }

            with open(os.path.join(output_dir, "journal.bin"), "rb") as handle:
                journal = handle.read()
            with open(os.path.join(output_dir, "seal.bin"), "rb") as handle:
                seal = handle.read()
            with open(os.path.join(output_dir, "proof.json"), encoding="utf-8") as handle:
                metadata = json.load(handle)

            return {
                "image_id": metadata["image_id"],
                "journal_b64": base64.b64encode(journal).decode("ascii"),
                "seal_b64": base64.b64encode(seal).decode("ascii"),
                "journal_digest": metadata["journal_digest"],
                "seal_digest": metadata["seal_digest"],
                "duration_ms": duration_ms,
            }
    except subprocess.TimeoutExpired:
        return {"status": "PROVER_TIMEOUT", "message": "prover deadline exceeded"}
    except Exception:
        return {"status": "WORKER_ERROR", "message": "worker execution failed"}


runpod.serverless.start({"handler": handler})
