"""Exercise call ownership, comparison history, isolation and refusal ordering."""

import asyncio
import base64
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

from proposal_review_api import prepare_proposal_review
import package_records
from schema_validation import PackageError


_VECTORS = json.loads((Path(__file__).parent / "fixtures/proposal-review-file-api-vectors.json").read_text())


class ProposalReviewFileApiTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self, name="create"):
        row = next(row for row in _VECTORS["cases"] if row["name"] == name)
        temporary = tempfile.TemporaryDirectory(prefix="morivyx-proposal-unit-")
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for path, entry in row["files"].items():
            target = root / path
            if entry.get("directory"):
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(base64.b64decode(entry["bytes"]))
        return root, json.loads(json.dumps(row["input"], ensure_ascii=False).replace("$ROOT", str(root)))

    async def test_read_only_comparison_has_no_adoption_authority(self):
        root, value = self.fixture()
        before = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}
        original = deepcopy(value)
        result = await prepare_proposal_review(value)
        self.assertTrue(result["valid"])
        self.assertEqual(result["authorization"], "not-assessed")
        self.assertIs(result["persisted"], False)
        self.assertIsNone(result["comparison"][0]["before"])
        self.assertEqual(result["comparison"][0]["after"], value["candidateElements"][0])
        self.assertEqual(value, original)
        self.assertEqual(before, {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()})

    async def test_input_is_owned_at_call_before_await(self):
        _, value = self.fixture()
        expected = deepcopy(value)
        pending = prepare_proposal_review(value)
        value["candidateElements"][0]["attributes"]["rationale"] = "呼出し後"
        value["changeSet"]["provenance"]["actor"] = "changed"
        result = await pending
        self.assertEqual(result["changeSet"], expected["changeSet"])
        self.assertEqual(result["comparison"][0]["after"], expected["candidateElements"][0])

    async def test_first_read_starts_before_return_inside_running_loop(self):
        _, value = self.fixture()
        events = []
        original = package_records._package_api_io
        async def observed(operation, path):
            events.append(operation)
            return await original(operation, path)
        package_records._package_api_io = observed
        try:
            pending = prepare_proposal_review(value)
            self.assertEqual(events, ["lstat"])
            self.assertTrue((await pending)["valid"])
        finally:
            package_records._package_api_io = original

    def test_call_without_running_loop_can_be_passed_to_asyncio_run(self):
        _, value = self.fixture()
        with self.assertRaises(RuntimeError):
            asyncio.get_running_loop()
        self.assertTrue(asyncio.run(prepare_proposal_review(value))["valid"])

    async def test_returned_graph_preserves_internal_aliases_and_separates_input(self):
        _, value = self.fixture()
        original = deepcopy(value)
        result = await prepare_proposal_review(value)
        self.assertIs(result["comparison"][0]["operation"], result["changeSet"]["operations"][0])
        self.assertIsNot(result["comparison"][0]["after"], value["candidateElements"][0])
        result["comparison"][0]["after"]["attributes"]["rationale"] = "返却後"
        result["changeSet"]["provenance"]["actor"] = "changed"
        self.assertEqual(value, original)

    async def test_intermediate_history_is_preserved(self):
        _, value = self.fixture("revise-replace-retire-timeline")
        result = await prepare_proposal_review(value)
        steps = result["comparison"]
        self.assertEqual([s["operation"]["op"] for s in steps], ["revise", "replace", "retire"])
        self.assertEqual(steps[1]["before"], steps[0]["after"])
        self.assertEqual(steps[2]["before"], steps[1]["after"])
        self.assertIsNone(steps[2]["after"])

    async def test_host_getters_are_never_invoked(self):
        class Host:
            @property
            def basePath(self):
                raise AssertionError("host getter invoked")
        pending = prepare_proposal_review(Host())
        with self.assertRaises(PackageError) as caught:
            await pending
        self.assertEqual(caught.exception.code, "PROPOSAL_REVIEW_INPUT_INVALID")

    async def test_invalid_input_rejects_when_awaited(self):
        for value in [None, [], {}, {"basePath": "unused", "approve": True}]:
            with self.subTest(value=value):
                pending = prepare_proposal_review(value)
                with self.assertRaises(PackageError) as caught:
                    await pending
                self.assertEqual(caught.exception.path, "/")

    async def test_concurrent_reads_have_independent_results(self):
        _, left = self.fixture()
        _, right = self.fixture("revise-replace-retire-timeline")
        a, b = await asyncio.gather(prepare_proposal_review(left), prepare_proposal_review(right))
        self.assertEqual(len(a["comparison"]), 1)
        self.assertEqual(len(b["comparison"]), 3)
        self.assertIsNot(a["changeSet"], b["changeSet"])

    async def test_base_validation_precedes_invalid_proposal(self):
        _, value = self.fixture("base-schema-invalid")
        value["changeSet"] = None
        with self.assertRaises(PackageError) as caught:
            await prepare_proposal_review(value)
        self.assertEqual(caught.exception.code, "PROPOSAL_REVIEW_BASE_INVALID")


if __name__ == "__main__":
    unittest.main()
