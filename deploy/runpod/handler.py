"""RunPod handler: proves one batch, returns the seal.

Input: {"input_json_b64": ..., "auth": <PNLX_WORKER_AUTH_TOKEN when configured>, "include_error_trace": true for diagnostic requests}
Output: {"image_id", "journal_b64", "seal_b64", "journal_digest", "seal_digest", "duration_ms"}
Full process output is returned only when include_error_trace is explicitly enabled; it can contain witness material.
"""

import base64
import json
import os
import re
import subprocess
import tempfile
import time
import traceback

PROVER = "/usr/local/bin/pnlx-risc0-batch-match-prover"
PROVER_TIMEOUT_SECONDS = int(os.environ.get("PNLX_WORKER_TIMEOUT_SECONDS", "1740"))
AUTH_TOKEN = os.environ.get("PNLX_WORKER_AUTH_TOKEN", "")


def safe_failure_code(stderr: str) -> str:
    value = stderr.lower()
    if re.search(r"out of memory|cuda_error_out_of_memory|failed to allocate", value):
        return "GPU_OUT_OF_MEMORY"
    if re.search(r"cuda driver|no cuda-capable device|failed to initialize cuda|cuda error", value):
        return "GPU_RUNTIME_ERROR"
    if "batch-match guest image id" in value and "does not match" in value:
        return "IMAGE_ID_MISMATCH"
    if "execute batch-match guest preflight" in value or "guest preflight" in value:
        return "GUEST_PREFLIGHT_FAILED"
    if "prove batch-match guest locally" in value or "groth16" in value:
        return "GROTH16_PROVING_FAILED"
    if "parse prover input" in value or "invalid type" in value:
        return "INVALID_PROOF_INPUT"
    if "risc0_dev_mode" in value or "risc0_prover=" in value or "bonsai_api" in value:
        return "PROVER_CONFIGURATION_ERROR"
    return "PROVER_PROCESS_FAILED"


def report_failure(
    code: str,
    stage: str,
    message: str,
    error_trace: str | None = None,
    **details: object,
) -> dict:
    result = {
        "status": code,
        "error_code": code,
        "stage": stage,
        "message": message,
        **details,
    }
    print(json.dumps({"event": "pnlx_worker_failure", **result}, separators=(",", ":")))
    if error_trace is not None:
        result["error_trace"] = error_trace
    return result


def decode_output(value: str | bytes | None) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def check_auth(job_input: dict) -> None:
    if not AUTH_TOKEN:
        return
    if job_input.get("auth") != AUTH_TOKEN:
        raise RuntimeError("unauthorized")


def handler(job: dict) -> dict:
    job_input = job.get("input") or {}
    include_error_trace = job_input.get("include_error_trace") is True
    try:
        check_auth(job_input)
    except RuntimeError:
        return report_failure("UNAUTHORIZED", "auth", "worker authorization failed")

    input_json_b64 = job_input.get("input_json_b64")
    if not isinstance(input_json_b64, str) or not input_json_b64:
        return report_failure("INVALID_INPUT", "input_validation", "input_json_b64 is required")

    stage = "decode_input"
    started = None
    try:
        with tempfile.TemporaryDirectory(prefix="pnlx-job-") as workdir:
            input_path = os.path.join(workdir, "input.json")
            output_dir = os.path.join(workdir, "out")
            os.makedirs(output_dir, mode=0o700)
            input_bytes = base64.b64decode(input_json_b64, validate=True)
            stage = "write_input"
            with open(input_path, "wb") as handle:
                handle.write(input_bytes)
            os.chmod(input_path, 0o600)

            environment = dict(os.environ)
            environment["RISC0_PROVER"] = "local"
            environment["RISC0_DEV_MODE"] = "0"
            if include_error_trace:
                environment["RUST_BACKTRACE"] = "full"

            stage = "prover"
            started = time.monotonic()
            completed = subprocess.run(
                [PROVER, input_path, output_dir],
                capture_output=True,
                text=True,
                timeout=PROVER_TIMEOUT_SECONDS,
                env=environment,
            )
            duration_ms = int((time.monotonic() - started) * 1000)

            if completed.returncode != 0:
                process_trace = "\n".join(
                    value for value in [completed.stdout, completed.stderr] if value
                )
                return report_failure(
                    safe_failure_code(completed.stderr),
                    "prover",
                    "prover execution failed",
                    error_trace=process_trace if include_error_trace else None,
                    exit_code=completed.returncode,
                    duration_ms=duration_ms,
                    stderr_bytes=len(completed.stderr.encode("utf-8", errors="replace")),
                )

            stage = "read_proof_output"
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
    except subprocess.TimeoutExpired as error:
        duration_ms = int((time.monotonic() - started) * 1000) if started is not None else 0
        output = "\n".join(
            value
            for value in [decode_output(error.stdout), decode_output(error.stderr)]
            if value
        )
        return report_failure(
            "PROVER_TIMEOUT",
            stage,
            "prover deadline exceeded",
            error_trace=output if include_error_trace else None,
            duration_ms=duration_ms,
        )
    except Exception:
        duration_ms = int((time.monotonic() - started) * 1000) if started is not None else 0
        return report_failure(
            "WORKER_ERROR",
            stage,
            "worker execution failed",
            error_trace=traceback.format_exc() if include_error_trace else None,
            duration_ms=duration_ms,
        )


if __name__ == "__main__":
    import runpod

    runpod.serverless.start({"handler": handler})
