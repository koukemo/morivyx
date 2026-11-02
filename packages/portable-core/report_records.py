"""Checked logical report records and YAML serialization without filesystem I/O."""

from canonical import digest
from report_validation import validate_report
from yaml_authoring import read_authoring_yaml
from yaml_records import write_yaml


REPORT_TYPES = {
    "morivyx.trace-report/0.1": "trace-report",
    "morivyx.semantic-diff/0.1": "semantic-diff",
    "morivyx.migration-semantic-diff/0.1": "migration-semantic-diff",
    "morivyx.external-artifact-report/0.1": "external-artifact-report",
}


def prepare_report(report):
    """Validate structure and calculate a digest, without authenticating content."""
    result = validate_report(report)
    return {"valid": True, **result, "digest": digest(result["type"], report)["digest"]}


def read_report_source(source):
    """Check bounded YAML authoring policies and the logical report record."""
    return prepare_report(read_authoring_yaml(source))


def serialize_report_yaml(report):
    """Return checked YAML; optional report ID remains optional outside a package."""
    prepare_report(report)
    return write_yaml(report)
