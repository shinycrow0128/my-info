# Resume Tracker

Track every resume you send out: the `.docx` file itself, the job description, job title,
job link, and which of the three profiles it went out under — all in one table.

- **Frontend:** React 19 + Vite
- **Backend:** Express 5 on Node 24 (ESM)
- **Database:** MongoDB via Mongoose
- **Uploads:** stored on disk in `server/uploads/`, metadata in MongoDB
- **Documents:** a resume and a cover letter per application, both filed by the
  Chrome extension without a click - see [The automatic pipeline](#the-automatic-pipeline)

## Profiles

The roster is fixed in [`server/src/config.js`](server/src/config.js):

```
Adam Corey Everitte · Cody Tylor Wolfe · Russell Aaron Turner
```

The frontend loads it from `GET /api/meta`, so editing that one array updates the dropdown,
the filters, and server-side validation together.

These are the same names as `RESUME_TEMPLATES` in the Chrome extension
(`Chatgpt Extension/assets.js`) - a profile *is* a resume template. The
extension files each application under the template it sent, so renaming a
person means editing both lists, and renaming existing records to match.

## Setup

Requires Node 24+ and a MongoDB you can reach (a local `mongod` on the default port works).

Filing a generated ZIP also needs **Python with `python-docx`** on the machine
running the API, because that is what `resume_fill.py` uses to pour the generated
JSON into a template:

```bash
pip install python-docx
```

Nothing else in the app depends on it - without Python you can still upload the
two documents by hand.

```bash
npm run setup     # installs root, server and client dependencies
```

Copy the env file and adjust if your MongoDB is not on the default port:

```bash
cp server/.env.example server/.env
```

| Variable        | Default                                     | Purpose                        |
| --------------- | ------------------------------------------- | ------------------------------ |
| `MONGODB_URI`   | `mongodb://127.0.0.1:27017/resume_tracker`   | Connection string              |
| `PORT`          | `5000`                                       | API port                       |
| `CORS_ORIGIN`   | `http://localhost:5173,chrome-extension://*` | Allowed frontend origins (CSV). `chrome-extension://*` lets the Chrome extension file applications; replace it with the real `chrome-extension://<id>` to pin one extension |
| `UPLOAD_DIR`    | `uploads`                                    | Where resume files land        |
| `MAX_UPLOAD_MB` | `15`                                         | Upload size limit              |
| `MAX_PACKAGE_MB` | `25`                                        | Size limit for the generator ZIP |
| `PYTHON_BIN`    | `python` (win) / `python3`                   | Interpreter that runs `resume_fill.py` |
| `TEMPLATES_DIR` | `../Chatgpt Extension/Temp`                  | `Temp_<profile>.docx` templates |
| `RESUME_FILL_SCRIPT` | `../Chatgpt Extension/resume_fill.py`   | The filler script              |
| `PACKAGE_CONCURRENCY` | `3`                                    | How many fills may run at once |
| `PACKAGE_TIMEOUT_MS` | `120000`                                | Ceiling on a single fill       |

## Run

```bash
npm run dev       # API on :5000 and the React app on :5173 together
```

Open <http://127.0.0.1:5173>. Vite proxies `/api` to the backend, so there is no CORS setup
to do in development. The app has two pages: **Applications** (`/applications`) and
**Analytics** (`/analytics`).

Individually: `npm run dev:server` / `npm run dev:client`.
For production: `npm run build` (emits `client/dist/`) and `npm start`. Note that
`npm start` runs only the API - `client/dist/` still needs a static host, and because the
frontend uses real routes it needs an SPA fallback (serve `index.html` for any unmatched
path) or a deep link to `/analytics` will 404.

## What the app does

**Add application** opens a form with the profile dropdown, job title, company, job link,
job description, status, notes, and a drop box each for the resume and the cover letter -
drag a file onto one or click it to browse. Both are optional: most records are filed by
the extension before either document exists. On upload the server pulls the plain text out
of `.docx` files with `mammoth` and stores it alongside the record, so the search box also
matches text that only exists inside either document.

The table shows every record with:

- sortable columns (profile, job title, company, status, applied date)
- a live search box across job title, company, description, notes and resume text
- filters by profile and status, plus clickable per-profile count tiles
- expandable rows for the full job description and notes
- a resume and a cover letter cell per row: the stored file as a download link, and an
  **Upload**/**Replace** picker that files a document without opening the form
- edit/delete per row
- pagination, 25 rows per page

Deleting a record also deletes both files from disk; replacing a document on edit removes
the old file only after the new record is saved.

## The automatic pipeline

The Chrome extension in [`Chatgpt Extension/`](Chatgpt%20Extension/) turns one paste of a
job description into a filed application, with no step in between:

1. **Send.** The panel files the application - profile, job title, company, link, the JD -
   and sends the JD to ChatGPT with the profile's template DOCX and the generator prompt.
2. **Watch.** The content script watches that chat. The generator prompt contracts exactly
   one `Resume_Package_<Candidate>.zip` back, holding `resume_content.json` and
   `Cover_Letter_<Candidate>.docx`.
3. **Download.** When the reply finishes, the ZIP is clicked - so it lands in your Downloads
   folder as usual - and its bytes are read at the same time.
4. **Fill.** The ZIP is posted to `POST /api/applications/:id/package`. The server unpacks
   it and runs `resume_fill.py` to pour the JSON into `Temp_<profile>.docx`. **The resume
   DOCX is made here, not by ChatGPT** - that is why the prompt forbids one in the ZIP: the
   layout is this repo's, and only the content is generated.
5. **File.** The filled resume and the cover letter both land on the record, and their text
   is extracted so the search box reaches inside them.

**Several bids at once is the normal case.** Each send is one *job*, tied to its own record
and its own chat, and the panel lists them all with their state - waiting, watching,
downloading, filing, filed. The server gives every fill its own temp directory, so runs
never share a folder, and `PACKAGE_CONCURRENCY` caps how many Python processes exist at
once. Nothing is lost if a step fails: the ZIP stays on the job for a one-click retry, and
every row can take the two files by hand instead.

**Company peek (Ctrl+Shift+X).** Select a company name and press Ctrl+Shift+X to see every
application already filed under that company: the profile it went out under, the job title,
and its current status, with per-status counts across the whole match. Matching is a
case-insensitive substring, so selecting `acme` finds `Acme Corp` and `Acmetech Solutions`
both; exact company-name hits sort to the top. The panel then closes itself after five
seconds - the countdown starts when the result lands, not when the lookup is fired, and it
pauses while the pointer is over the panel so a long list can still be read.

It comes in two flavours. Inside the web app the shortcut works on any selection on the
page, including text inside a form field, and the popover is anchored to the selection.
The one that matters more is the **desktop** version in `desktop/`, which works in *any*
Windows application - a job board in the browser, a PDF, a spreadsheet - and does not need
the API or the web app running at all. See [Desktop company peek](#desktop-company-peek).

## API

| Method   | Route                          | Notes                                                        |
| -------- | ------------------------------ | ------------------------------------------------------------ |
| `GET`    | `/api/health`                  | Liveness plus DB connection state                             |
| `GET`    | `/api/meta`                    | Profile names and statuses                                    |
| `GET`    | `/api/applications`            | `page`, `limit`, `q`, `profileName`, `status`, `sortBy`, `sortDir` |
| `GET`    | `/api/applications/stats`      | Totals grouped by profile and status                          |
| `GET`    | `/api/applications/company-lookup` | `q` (2+ chars), `limit`; companies matching the selected text |
| `GET`    | `/api/analytics`               | `days` = `7` \| `30` \| `90` \| `365` \| `all` (default `30`)   |
| `GET`    | `/api/applications/:id`        | Single record                                                 |
| `GET`    | `/api/applications/:id/resume` | Downloads the stored resume under its original name           |
| `GET`    | `/api/applications/:id/cover-letter` | Downloads the stored cover letter                       |
| `POST`   | `/api/applications`            | `multipart/form-data`, file fields `resume` and `coverLetter` |
| `POST`   | `/api/applications/:id/package` | The generator ZIP, as file field `package` or as `packageUrl` for the server to fetch. Unzips it, fills the profile's template through `resume_fill.py`, and attaches both documents |
| `PUT`    | `/api/applications/:id`        | Partial update; send either file again to replace it          |
| `DELETE` | `/api/applications/:id`        | Removes the record and both files                             |

`profileName` and `jobTitle` are required on create; `profileName` and `status` are validated
against the fixed lists. Uploads are limited to `.docx`, `.doc` and `.pdf`.

`/package` answers `422` when the ZIP is not what the prompt contracted - no
`resume_content.json`, or a template placeholder the generated JSON has no value for. The
message names the missing keys, and it reaches the extension panel as-is, because that is
the one error worth reading in full.

## Desktop company peek

A global Windows hotkey. Select a company name in *any* application, press **Ctrl+Shift+X**,
and a small always-on-top panel opens at the mouse pointer with the profile name, job title
and status of every matching application - the same answer the in-app popover gives, but
without leaving whatever you were reading.

```bash
pip install -r desktop/requirements.txt
python desktop/peek.py
```

It talks to MongoDB directly with `pymongo`, so the Express API does not need to be running -
only `mongod`. The connection string comes from `MONGODB_URI`, then `server/.env`, then the
same `mongodb://127.0.0.1:27017/resume_tracker` default the server uses; `--uri` overrides all
three. Leave the console open and press Ctrl+C there to quit.

For a lookup without the hotkey or the window - handy for checking the query itself:

```bash
python desktop/peek.py --query "Acme Corp"
```

```
desktop/
  peek.py      hotkey listener, the Tk panel, and the --query CLI
  lookup.py    the MongoDB query (substring match, exact hits first, status counts)
  win32.py     RegisterHotKey, the selection grab, monitor geometry
```

**How the selection is read.** Another application will not hand over its selection, so the
hotkey asks for it: `win32.copy_selection()` releases the keys still held down from the
shortcut itself, sends Ctrl+C, waits for the clipboard *sequence number* to move, reads the
text, and puts the previous clipboard contents back. Watching the sequence number is what
distinguishes "nothing was selected" from "the clipboard already held something" - without
it, an empty selection would silently look up whatever you copied an hour ago.

Two things follow from that. The panel only sees text from applications that implement
Ctrl+C, which is nearly all of them but not quite. And your clipboard is restored, not
preserved byte for byte: non-text formats on the clipboard (an image, rich text) do not
survive a peek.

The panel closes itself five seconds after the result lands; Esc and the ✕ close it sooner,
and hovering over it holds it open. It deliberately does *not* close on losing focus, the way
the in-app popover does: the application you selected the text in usually takes focus straight
back, which would tear the panel down before it could be read.

## Analytics

`/analytics` answers "how am I doing" over a selectable range:

- **Stat tiles** - total bids, interviews, offers, rejections, still-awaiting, with reply
  and rejection rates and a bids-per-active-day pace.
- **Bids per day** - a stacked column per day; column height is that day's bid count and
  the segments are the four statuses, so volume and outcome read off one axis. Hover any
  column for the breakdown, or flip to the table view for the raw numbers. Ranges longer
  than 120 days roll up into weekly buckets, because 365 daily columns do not fit.
- **Interviews by profile** - which profile is pulling its weight, plus a breakdown table
  with each profile's reply rate.

**One caveat worth knowing:** an application stores only its *current* status, not a
history of status changes. So a day's "interview" count means *applications sent that day
that are now at interview stage* - not interviews that happened that day. Tracking true
daily transitions would need a status-history collection.

The chart palette is not arbitrary. The four status colors were checked with the dataviz
skill's `validate_palette.js` against this app's dark surface (`#171a21`): they sit in the
dark lightness band, clear the chroma floor and 3:1 contrast, and the worst adjacent pair
is CVD ΔE 8.4. The stack order in `client/src/lib/viz.js` is part of that result - it
keeps green (offer) away from red (rejected), which is the pair colorblind readers
confuse. **Re-run the validator if you reorder or recolor those statuses.**

## Layout

```
server/
  src/index.js                 Express app, error handling, startup
  src/config.js                env config, PROFILES, STATUSES
  src/db.js                    Mongoose connection
  src/models/Application.js    schema
  src/routes/applications.js   CRUD, search, stats, downloads, the ZIP endpoint
  src/routes/analytics.js      aggregation for the analytics page
  src/services/resumePackage.js  unzip, run resume_fill.py, store both documents
  src/middleware/upload.js     multer disk storage + file-type filter
  uploads/                     stored resume files (git-ignored)
client/
  src/App.jsx                  router shell and page tabs
  src/pages/ApplicationsPage.jsx       the table page: filters, paging
  src/pages/AnalyticsPage.jsx          the analytics page
  src/components/ApplicationForm.jsx   add/edit modal
  src/components/ApplicationTable.jsx  the data table
  src/components/CompanyPeek.jsx       Ctrl+Shift+X company peek popover
  src/components/DailyChart.jsx        stacked columns per day/week
  src/components/ProfileChart.jsx      interviews per profile
  src/lib/api.js               fetch wrappers
  src/lib/viz.js               validated chart palette + scale helpers
  src/styles.css               styling
desktop/
  peek.py                      Ctrl+Shift+X listener, Tk panel, --query CLI
  lookup.py                    company lookup straight against MongoDB
  win32.py                     hotkey, selection capture, monitor geometry
```
