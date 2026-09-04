/**
 * Job tracker API client.
 *
 * The tracker is the `server/` project in this repo: Express on localhost with
 * no auth, so a record is just a multipart POST. The host is fixed here and in
 * the manifest's host_permissions - change both together.
 */

const TRACKER_API = "http://localhost:5000";

/** Where the popup points people when the API cannot be reached. */
const TRACKER_OFFLINE =
  "Job tracker is not running - start it with `npm run dev:server`.";

async function trackerRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(TRACKER_API + path, options);
  } catch {
    // fetch only rejects on a transport failure; a refused port lands here.
    throw new Error(TRACKER_OFFLINE);
  }

  const isJson = (response.headers.get("content-type") || "").includes(
    "application/json"
  );
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(
      (payload && payload.error) || "Tracker request failed (" + response.status + ")."
    );
  }
  return payload;
}

/**
 * The profile and status rosters live on the server, which rejects anything
 * outside them - so the popup's dropdowns are filled from here, never from the
 * resume template list, which is a different set of names.
 */
function fetchTrackerMeta() {
  return trackerRequest("/api/meta");
}

/**
 * Empty fields are left off so the server's own defaults apply. No documents
 * ride along: neither exists at send time, and both arrive later on the ZIP.
 */
function createApplication(fields) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== "" && value !== null && value !== undefined) {
      body.append(key, value);
    }
  }

  return trackerRequest("/api/applications", { method: "POST", body });
}

/**
 * Hand the generator's ZIP to the server, which unpacks it, fills the profile's
 * template with resume_content.json through resume_fill.py, and puts both the
 * resume and the cover letter on the record in one request.
 *
 * `data` is the archive itself, base64 encoded. When the browser could not read
 * the signed download cross-origin there is only a `url`, and the server
 * fetches it - node is not bound by the page's CORS rules.
 */
function uploadPackage(id, { name, data, url }, profileName) {
  const body = new FormData();
  if (profileName) body.append("profileName", profileName);
  if (data) {
    const blob = new Blob([base64ToBytes(data)], { type: "application/zip" });
    body.append("package", blob, name || "Resume_Package.zip");
  } else if (url) {
    body.append("packageUrl", url);
  } else {
    return Promise.reject(new Error("Nothing to upload - no ZIP bytes and no URL."));
  }

  return trackerRequest("/api/applications/" + encodeURIComponent(id) + "/package", {
    method: "POST",
    body,
  });
}
