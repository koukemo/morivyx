import copy
from pathlib import Path
import tempfile
import unittest

from canonical import digest
from package_records import read_package, read_package_files, write_package_files
from schema_registry import resolve_schema_registry
from schema_validation import load_core_schema
from test_package_records import inputs
from yaml_records import write_yaml


NAME = "morivyx.core@0.1.yaml"
SOURCE = Path(__file__).with_name("core-schema.yaml").read_text()
LOCK = {"schemas": [{"schemaId": "morivyx.core", "version": "0.1", "digest": digest("schema", load_core_schema())["digest"]}]}


class SchemaRegistryTests(unittest.TestCase):
    def test_explicit_binding_and_no_input_mutation(self):
        sources = {NAME: SOURCE}
        original = copy.deepcopy((LOCK, sources))
        result = resolve_schema_registry(LOCK, sources)
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["schemas"]["morivyx.core@0.1"], load_core_schema())
        self.assertEqual((LOCK, sources), original)

    def test_missing_schema_never_uses_bundled_fallback(self):
        result = resolve_schema_registry(LOCK, {})
        self.assertEqual(result["schemas"], {})
        self.assertEqual(result["issues"][0]["code"], "SCHEMA_LOCK_MISSING")

    def test_conflicting_names_versions_digests_and_sources(self):
        for source in [SOURCE.replace("morivyx.core", "example.other"), SOURCE.replace('version: "0.1"', 'version: "0.2"'),
                       "{}\n", "not: [valid\n", b"\xff\n"]:
            with self.subTest(source=source[:20]):
                self.assertEqual(resolve_schema_registry(LOCK, {NAME: source})["issues"][0]["code"], "SCHEMA_LOCK_CONFLICT")
        lock = copy.deepcopy(LOCK)
        lock["schemas"][0]["digest"] = "sha256:" + "0" * 64
        self.assertEqual(resolve_schema_registry(lock, {NAME: SOURCE})["issues"][0]["code"], "SCHEMA_LOCK_CONFLICT")

    def test_unlocked_files_and_unsafe_names(self):
        result = resolve_schema_registry(LOCK, {"z.yaml": "{}\n", "a~.yaml": "{}\n"})
        self.assertEqual([i["path"] for i in result["issues"]], ["/schemas/a~0.yaml", "/schemas/z.yaml", "/schemas/morivyx.core@0.1"])
        for name in ["../bad.yaml", "nested/bad.yaml", "bad\\name.yaml", "bad\x00.yaml"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                resolve_schema_registry(LOCK, {name: SOURCE})

    def test_schema_sources_survive_package_read_write_and_disk_read(self):
        files = {**inputs(), "schemas/" + NAME: SOURCE.encode()}
        package = read_package_files(files)
        self.assertFalse(package["validation"]["schemaValidated"])
        self.assertEqual(package["schemaSources"], {NAME: SOURCE})
        written = write_package_files(package)
        self.assertEqual(written["schemas/" + NAME], SOURCE)
        self.assertEqual(read_package_files(written)["schemaSources"], package["schemaSources"])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            for path, source in written.items():
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(source)
            self.assertEqual(read_package(root)["schemaSources"], {NAME: SOURCE})
            (root / "schemas" / NAME).unlink()
            (root / "schemas" / NAME).symlink_to(Path(__file__).with_name("core-schema.yaml"))
            with self.assertRaises(OSError):
                read_package(root)

    def test_invalid_yaml_is_preserved_for_explicit_registry_diagnosis(self):
        package = read_package_files({**inputs(), "schemas/" + NAME: b"bad: [\n"})
        self.assertEqual(write_package_files(package)["schemas/" + NAME], "bad: [\n")
        self.assertEqual(resolve_schema_registry(LOCK, package["schemaSources"])["issues"][0]["code"], "SCHEMA_LOCK_CONFLICT")


if __name__ == "__main__":
    unittest.main()
