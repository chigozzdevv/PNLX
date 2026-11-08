import base64
import io
import json
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import handler


class HandlerDiagnosticsTest(unittest.TestCase):
    def run_failed_prover(self, include_error_trace):
        job_input = {
            "input_json_b64": base64.b64encode(b"synthetic fixture").decode("ascii"),
            "auth": "test-token",
        }
        if include_error_trace:
            job_input["include_error_trace"] = True
        completed = CompletedProcess(
            args=["pnlx-risc0-batch-match-prover"],
            returncode=1,
            stdout="prover stage output",
            stderr="CUDA driver error: synthetic fixture trace",
        )
        log = io.StringIO()
        with patch.object(handler, "AUTH_TOKEN", "test-token"):
            with patch.object(handler.subprocess, "run", return_value=completed) as run:
                with redirect_stdout(log):
                    result = handler.handler({"input": job_input})
        return result, log.getvalue(), run.call_args.kwargs["env"]

    def test_full_error_trace_is_returned_only_for_diagnostic_requests(self):
        result, log, environment = self.run_failed_prover(True)
        self.assertEqual(result["error_code"], "GPU_RUNTIME_ERROR")
        self.assertEqual(
            result["error_trace"],
            "prover stage output\nCUDA driver error: synthetic fixture trace",
        )
        self.assertEqual(environment["RUST_BACKTRACE"], "full")
        self.assertNotIn("synthetic fixture trace", log)

    def test_normal_failure_does_not_return_or_log_process_output(self):
        result, log, environment = self.run_failed_prover(False)
        self.assertEqual(result["error_code"], "GPU_RUNTIME_ERROR")
        self.assertNotIn("error_trace", result)
        self.assertNotIn("synthetic fixture trace", log)
        self.assertNotIn("RUST_BACKTRACE", environment)

    def test_successful_prover_returns_a_succinct_receipt_not_a_seal(self):
        journal = b"batch journal bytes"
        receipt = b'{"succinct":true}'
        job_input = {
            "input_json_b64": base64.b64encode(b"synthetic fixture").decode("ascii"),
            "auth": "test-token",
        }

        def fake_prover(args, **kwargs):
            out = Path(args[3])
            out.mkdir(parents=True, exist_ok=True)
            (out / "journal.bin").write_bytes(journal)
            (out / "receipt.json").write_bytes(receipt)
            (out / "succinct.json").write_text(json.dumps({
                "image_id": "0x" + "ab" * 32,
                "journal_digest": "0x" + "bb" * 32,
                "receipt_digest": "0x" + "cc" * 32,
            }))
            return CompletedProcess(args=args, returncode=0, stdout="", stderr="")

        with patch.object(handler, "AUTH_TOKEN", "test-token"):
            with patch.object(handler.subprocess, "run", side_effect=fake_prover) as run:
                result = handler.handler({"input": job_input})
        self.assertEqual(run.call_args.args[0][1], "--prove-succinct")
        self.assertEqual(result["image_id"], "0x" + "ab" * 32)
        self.assertEqual(base64.b64decode(result["journal_b64"]), journal)
        self.assertEqual(base64.b64decode(result["receipt_b64"]), receipt)
        self.assertEqual(result["journal_digest"], "0x" + "bb" * 32)
        self.assertEqual(result["receipt_digest"], "0x" + "cc" * 32)
        self.assertNotIn("seal_b64", result)


if __name__ == "__main__":
    unittest.main()
