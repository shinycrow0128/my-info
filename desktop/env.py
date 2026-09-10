"""Settings the desktop tools share with the server, read the way it reads them.

The peek runs beside the tracker rather than inside it, so it takes the same
`server/.env` the API does. Nothing here is Windows-specific.
"""

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / "server" / ".env"


def read_env(key, default=None):
    """`key` from the real environment, then from server/.env, then `default`.

    A deliberately small parser: `KEY=value` lines, `#` comments, optional
    quotes. dotenv's full syntax is not worth a dependency for two settings.
    """
    if os.environ.get(key):
        return os.environ[key]

    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == key:
                return value.strip().strip('"').strip("'")
    return default
