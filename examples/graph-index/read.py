"""Read a package and derive an in-memory index using only the portable modules."""

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages" / "portable-core"))
from graph_index import build_graph_index, graph_index_snapshot
from package_records import read_package

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", help="explicit .morivyx directory")
parser.add_argument("type")
parser.add_argument("element_id")
args = parser.parse_args()
contents = read_package(args.directory)
# Rebuild from the source instead of consuming cached element bodies.
index = build_graph_index({"graphRevision": contents["revision"]["id"], "elements": contents["elements"]})
print(json.dumps({"valid": True, "index": graph_index_snapshot(index), "query": {
    "type": args.type, "focusId": args.element_id, "focusExists": args.element_id in index["byId"],
    "elementIds": index["byType"].get(args.type, []),
    "outgoingRelationIds": index["outgoing"].get(args.element_id, []),
    "incomingRelationIds": index["incoming"].get(args.element_id, []),
}}, ensure_ascii=False, separators=(",", ":")))
