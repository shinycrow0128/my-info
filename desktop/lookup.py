"""Company lookup straight against MongoDB - no Express in the loop.

The desktop peek runs next to the tracker, not inside it, so it talks to the same
database the API writes to (collection `applications`, from the Mongoose model
`Application`).
"""

import os
import re
from pathlib import Path

from pymongo import MongoClient

DEFAULT_URI = "mongodb://127.0.0.1:27017/resume_tracker"
STATUS_ORDER = ["applied", "interview", "offer", "rejected"]


def read_uri():
    """MONGODB_URI wins, then server/.env, then the same default the server uses."""
    if os.environ.get("MONGODB_URI"):
        return os.environ["MONGODB_URI"]

    env_file = Path(__file__).resolve().parent.parent / "server" / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == "MONGODB_URI":
                return value.strip().strip('"').strip("'")
    return DEFAULT_URI


class Lookup:
    def __init__(self, uri=None, timeout_ms=4000):
        self.uri = uri or read_uri()
        self._client = MongoClient(self.uri, serverSelectionTimeoutMS=timeout_ms)
        # The database name rides in the URI, exactly as the server reads it.
        self._db = self._client.get_database()
        self.collection = self._db["applications"]

    @property
    def db_name(self):
        return self._db.name

    def ping(self):
        self._client.admin.command("ping")

    def close(self):
        self._client.close()

    def companies(self, term, limit=25):
        """Applications whose company contains `term`, case-insensitively.

        Exact company-name hits sort above the merely-similar ones, then newest first.
        """
        term = " ".join(term.split())
        if len(term) < 2:
            raise ValueError("Select at least 2 characters of a company name")

        escaped = re.escape(term)
        match = {"company": {"$regex": escaped, "$options": "i"}}

        rows = list(
            self.collection.aggregate(
                [
                    {"$match": match},
                    {
                        "$addFields": {
                            "exact": {
                                "$regexMatch": {
                                    "input": {"$ifNull": ["$company", ""]},
                                    "regex": "^" + escaped + "$",
                                    "options": "i",
                                }
                            }
                        }
                    },
                    {"$sort": {"exact": -1, "appliedAt": -1}},
                    {"$limit": limit},
                    {
                        "$project": {
                            "profileName": 1,
                            "jobTitle": 1,
                            "company": 1,
                            "status": 1,
                            "appliedAt": 1,
                            "jobLink": 1,
                            "exact": 1,
                        }
                    },
                ]
            )
        )

        total = self.collection.count_documents(match)
        counts = {
            doc["_id"]: doc["count"]
            for doc in self.collection.aggregate(
                [{"$match": match}, {"$group": {"_id": "$status", "count": {"$sum": 1}}}]
            )
        }
        by_status = {s: counts[s] for s in STATUS_ORDER if s in counts}
        # Anything non-standard still shows rather than silently vanishing.
        by_status.update({k: v for k, v in counts.items() if k not in by_status})

        names = sorted(n for n in self.collection.distinct("company", match) if n)

        for row in rows:
            row["id"] = str(row.pop("_id"))

        return {
            "term": term,
            "total": total,
            "shown": len(rows),
            "companies": names,
            "byStatus": by_status,
            "items": rows,
        }
