import copy
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from canonical import digest
from schema_validation import CORE_DIGEST, ValidationError, load_core_schema, validate_graph_element, validate_schema_definition
from yaml_records import read_yaml


FIXTURES = Path(__file__).resolve().parents[1] / "kernel/test/fixtures"
ELEMENT = json.loads((FIXTURES / "revision-id-vector.json").read_text())["cases"][0]["element"]


class SchemaValidationTests(unittest.TestCase):
    def test_bundled_core_is_identical_and_digest_pinned(self):
        bundled = Path(__file__).with_name("core-schema.yaml").read_bytes()
        original = Path(__file__).resolve().parents[2] / "docs/schema/morivyx.core@0.1.yaml"
        self.assertEqual(bundled, original.read_bytes())
        schema = load_core_schema()
        self.assertEqual(digest("schema", schema)["digest"], CORE_DIGEST)
        self.assertEqual((len(schema["entityTypes"]), len(schema["relationTypes"])), (16, 22))
        changed = bundled.replace(b'morivyx.core"', b'morivyx.test"', 1)
        with patch("schema_validation.Path.open", return_value=io.BytesIO(changed)), self.assertRaises(ValidationError) as error:
            load_core_schema()
        self.assertEqual(error.exception.code, "SCHEMA_DEFINITION_DIGEST_MISMATCH")

    def test_valid_definitions_and_elements_are_unchanged(self):
        custom = json.loads((FIXTURES / "schema-definition-digest-vector.json").read_text())["schemaDefinition"]
        for value in [load_core_schema(), custom]:
            before = copy.deepcopy(value)
            self.assertIs(validate_schema_definition(value), value)
            self.assertEqual(value, before)
        value = copy.deepcopy(ELEMENT)
        before = copy.deepcopy(value)
        self.assertIs(validate_graph_element(value), value)
        self.assertEqual(value, before)

    def test_schema_headers_and_unknown_fields(self):
        for field, value in [("format", "unknown"), ("schemaId", "invalid"), ("version", "v1"),
                             ("stableIdScheme", "new"), ("digestAlgorithm", "sha512"),
                             ("reviewStates", []), ("reviewStates", ["z", "a"]),
                             ("reviewStates", ["é", "e\u0301"]), ("unknown", 1)]:
            schema = load_core_schema()
            schema[field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError) as error:
                validate_schema_definition(schema)
            self.assertEqual(error.exception.code, "SCHEMA_DEFINITION_INVALID")

    def test_entity_declarations_and_order_definitions(self):
        for field, value in [("typeId", "invalid"), ("requiredAttributes", None),
                             ("optionalAttributes", []), ("optionalAttributes", ["actorKind"]),
                             ("lifecycle", []), ("unknown", 1)]:
            schema = load_core_schema()
            schema["entityTypes"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError):
                validate_schema_definition(schema)
        for transform in [lambda s: s["entityTypes"].reverse(),
                          lambda s: s["entityTypes"].append(copy.deepcopy(s["entityTypes"][0])),
                          lambda s: s["authoringOrders"].update(root=[]),
                          lambda s: s["authoringOrders"].update(root=["é", "e\u0301"]),
                          lambda s: s["authoringOrders"].update(unknown=[]),
                          lambda s: s["authoringOrders"].pop("attributes")]:
            schema = load_core_schema()
            transform(schema)
            with self.assertRaises(ValidationError):
                validate_schema_definition(schema)

    def test_relation_declarations_and_numeric_types(self):
        for field, value in [("predicate", ""), ("sourceTypes", []), ("sourceTypes", ["invalid"]),
                             ("targetTypes", ["z.t", "a.t"]), ("minCount", -1),
                             ("minCount", True), ("minCount", 1.5), ("maxCount", False),
                             ("cycle", "unknown"), ("unknown", 1)]:
            schema = load_core_schema()
            schema["relationTypes"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError):
                validate_schema_definition(schema)
        schema = load_core_schema()
        schema["relationTypes"][0].update(minCount=2, maxCount=1)
        with self.assertRaises(ValidationError):
            validate_schema_definition(schema)
        schema["relationTypes"][0].update(minCount=1.0, maxCount=2.0)
        validate_schema_definition(schema)

    def test_element_root_and_required_structure(self):
        for field, value in [("format", "unknown"), ("kind", "unknown"), ("id", "invalid"),
                             ("type", "invalid"), ("typeVersion", ""), ("revision", "sha256:wrong"),
                             ("lifecycle", ""), ("reviewState", "unknown"), ("attributes", []),
                             ("provenance", None), ("extensions", []), ("unknown", 1)]:
            element = copy.deepcopy(ELEMENT)
            element[field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError) as error:
                validate_graph_element(element)
            self.assertEqual(error.exception.code, "GRAPH_ELEMENT_INVALID")
        for field in ["format", "kind", "id", "type", "typeVersion", "revision", "lifecycle",
                      "reviewState", "attributes", "provenance"]:
            element = copy.deepcopy(ELEMENT)
            del element[field]
            with self.subTest(missing=field), self.assertRaises(ValidationError):
                validate_graph_element(element)

    def test_provenance_dates_and_extension_names(self):
        for field, value in [("method", ""), ("actor", "invalid"),
                             ("recordedAt", "2026-02-29T00:00:00Z"),
                             ("recordedAt", "2026-01-01T00:00:00+14:01"),
                             ("recordedAt", "not-a-date")]:
            element = copy.deepcopy(ELEMENT)
            element["provenance"][field] = value
            with self.subTest(field=field), self.assertRaises(ValidationError):
                validate_graph_element(element)
        for key in ["missing-namespace", "a/b/c", "a /b", "/empty"]:
            element = copy.deepcopy(ELEMENT)
            element["extensions"] = {key: {}}
            with self.subTest(key=key), self.assertRaises(ValidationError):
                validate_graph_element(element)

    def test_structure_is_not_full_graph_or_revision_validation(self):
        element = copy.deepcopy(ELEMENT)
        element["attributes"] = {"unknown": "not checked against a type yet"}
        element["lifecycle"] = "not-a-declared-lifecycle"
        element["revision"] = "sha256:" + "0" * 64
        validate_graph_element(element)
        self.assertNotEqual(digest("revision", element)["digest"], element["revision"])


if __name__ == "__main__":
    unittest.main()
