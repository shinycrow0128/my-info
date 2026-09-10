"""The tracker's HTTP API, for the writes the peek cannot make on its own.

Lookups go straight to MongoDB, but filing an application does not: the server
names the upload on disk, pulls the text out of the DOCX so the body is
searchable, and validates the profile against its own roster. So a new
application is POSTed to Express exactly as the web app posts it.

Hand-rolled multipart over urllib rather than requests: this keeps the desktop's
dependencies at pymongo alone.
"""

import json
import mimetypes
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid

from env import read_env

DEFAULT_PORT = 5000
TIMEOUT = 30


class ApiError(Exception):
    """A request the server refused, or one that never reached it."""


def base_url():
    """PEEK_API_URL wins, then the port the server is configured to listen on."""
    explicit = read_env("PEEK_API_URL")
    if explicit:
        return explicit.rstrip("/")
    return f"http://127.0.0.1:{read_env('PORT', DEFAULT_PORT)}"


def _multipart(fields, files):
    """Encode fields and files as multipart/form-data - what multer parses."""
    boundary = f"----PeekBoundary{uuid.uuid4().hex}"
    body = bytearray()

    for name, value in fields.items():
        body += f"--{boundary}\r\n".encode()
        body += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        body += str(value).encode("utf-8") + b"\r\n"

    for name, path in files.items():
        filename = os.path.basename(path)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        with open(path, "rb") as handle:
            content = handle.read()
        body += f"--{boundary}\r\n".encode()
        body += (
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
        ).encode("utf-8")
        body += f"Content-Type: {content_type}\r\n\r\n".encode()
        body += content + b"\r\n"

    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def _send(request):
    """Do the call and hand back the parsed JSON, or raise a readable ApiError.

    The server answers a rejection with `{"error": "..."}`, which is worth far
    more on the panel than "HTTP 400", so it is dug out of the error body.
    """
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = json.loads(err.read().decode("utf-8")).get("error", "")
        except Exception:  # noqa: BLE001 - a non-JSON error body is still an error
            pass
        raise ApiError(detail or f"The server answered {err.code}.") from err
    except urllib.error.URLError as err:
        # The address actually dialled, which is not always the default one.
        host = urllib.parse.urlsplit(request.full_url).netloc
        raise ApiError(f"Could not reach the API at {host} - is the server running?") from err
    except (OSError, ValueError) as err:
        raise ApiError(str(err)) from err


class Api:
    def __init__(self, url=None):
        self.url = (url or base_url()).rstrip("/")

    def meta(self):
        """The profile and status rosters, so the panel offers what the API accepts."""
        return _send(urllib.request.Request(f"{self.url}/api/meta"))

    def create_application(self, fields, files=None):
        """POST /api/applications - the same multipart the web form sends."""
        body, content_type = _multipart(fields, files or {})
        request = urllib.request.Request(
            f"{self.url}/api/applications",
            data=body,
            method="POST",
            headers={"Content-Type": content_type, "Content-Length": str(len(body))},
        )
        return _send(request)
