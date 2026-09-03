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

/** Empty fields are left off so the server's own defaults apply. */
function createApplication(fields, file) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== "" && value !== null && value !== undefined) {
      body.append(key, value);
    }
  }
  if (file) body.append("resume", file);

  return trackerRequest("/api/applications", { method: "POST", body });
}

/**
 * Attach the resume to a record that was created without one - the generated
 * file does not exist yet at send time, so it arrives on a later popup visit.
 */
function attachResume(id, file) {
  const body = new FormData();
  body.append("resume", file);
  return trackerRequest("/api/applications/" + encodeURIComponent(id), {
    method: "PUT",
    body,
  });
}
