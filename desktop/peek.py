"""Company Peek - select a company name anywhere in Windows, press Ctrl+Shift+X.

A borderless panel opens at the mouse pointer listing every application filed
under a matching company: the profile it went out under, the job title and the
status it is at. Reads MongoDB directly, so the API does not need to be running.

The same panel doubles as a scratchpad for a job you are reading: select text and
press Alt+1 to keep it as the job description, Alt+2 the job link, Alt+3 the job
title, Alt+4 the company. Alt+0 shows what has been collected so far.

    python desktop/peek.py                 start listening for the hotkeys
    python desktop/peek.py --query Acme    one-off lookup printed to stdout
"""

import argparse
import queue
import sys
import threading
import tkinter as tk
import traceback

from lookup import Lookup
from win32 import (
    MOD_ALT,
    MOD_CONTROL,
    MOD_SHIFT,
    VK_0,
    VK_1,
    VK_2,
    VK_3,
    VK_4,
    VK_X,
    copy_selection,
    cursor_position,
    hotkey_loop,
    set_dpi_awareness,
    work_area,
)

HOTKEY_LABEL = "Ctrl+Shift+X"
MAX_TERM = 80
RESULT_LIMIT = 25
# The panel closes itself this long after the answer lands.
AUTO_HIDE_MS = 5000
# The draft panel is a confirmation, not a document: it flashes and goes. Hovering
# it holds it open, so there is still a way to read a long description.
DRAFT_HIDE_MS = 1000

# key, label, virtual key, the combo as the user sees it, keeps line breaks
CAPTURE_FIELDS = [
    ("description", "Job description", VK_1, "Alt+1", True),
    ("link", "Job link", VK_2, "Alt+2", False),
    ("title", "Job title", VK_3, "Alt+3", False),
    ("company", "Company", VK_4, "Alt+4", False),
]
FIELDS_BY_KEY = {field[0]: field for field in CAPTURE_FIELDS}
DRAFT_HINT = "Alt+1-4 capture   ·   Alt+0 show"

# Hotkey ids: the lookup, the draft panel, then one per capture field.
HOTKEY_PEEK = 1
HOTKEY_DRAFT = 2
HOTKEY_FIELD_BASE = 10

# A whole job description is worth keeping; the panel shows the first slice of it.
MAX_VALUE = 8000
VALUE_PREVIEW = 420

BG = "#171a21"
BG_ALT = "#1e222b"
BORDER = "#2a2f3a"
TEXT = "#e7eaf0"
MUTED = "#9aa3b2"
DANGER = "#ff6b6b"
ACCENT = "#93b2ff"

# Same status colours as the web app, flattened onto the panel background
# because Tk has no per-widget alpha.
STATUS_COLORS = {
    "applied": ("#212b42", "#93b2ff"),
    "interview": ("#3a3229", "#ffc978"),
    "offer": ("#203632", "#6fe0a4"),
    "rejected": ("#3a262c", "#ff8f8f"),
}

PANEL_WIDTH = 380
LIST_MAX_HEIGHT = 260
FONT = "Segoe UI"


def clean_term(raw):
    """First line of the selection, whitespace collapsed, length capped."""
    if not raw or not raw.strip():
        return ""
    return " ".join(raw.strip().splitlines()[0].split())[:MAX_TERM]


def clean_value(raw, multiline=False):
    """The selection as it should be stored: trimmed, capped, blank runs collapsed.

    A job description keeps its line breaks - it is prose, and paragraph shape is
    most of what makes it readable. Everything else is a single line.
    """
    if not raw or not raw.strip():
        return ""
    if not multiline:
        return " ".join(raw.strip().splitlines()[0].split())[:MAX_VALUE]

    lines = []
    for line in raw.strip().splitlines():
        line = " ".join(line.split())
        # One blank line between paragraphs, however many the source had.
        if line or (lines and lines[-1]):
            lines.append(line)
    return "\n".join(lines)[:MAX_VALUE]


def preview_value(value):
    """What fits in the panel, cut on a word boundary where there is one."""
    if len(value) <= VALUE_PREVIEW:
        return value
    cut = value[:VALUE_PREVIEW]
    space = cut.rfind(" ")
    if space > VALUE_PREVIEW - 60:
        cut = cut[:space]
    return cut.rstrip() + " …"


def format_date(value):
    if not value:
        return ""
    try:
        return value.strftime("%b %d, %Y")
    except AttributeError:
        return str(value)[:10]


class Peek:
    def __init__(self, lookup):
        self.lookup = lookup
        self.events = queue.Queue()
        self.request_id = 0
        self.anchor = (0, 0)
        self._hide_job = None
        self._hide_delay = AUTO_HIDE_MS
        # Captured field values, held for the life of the process.
        self.draft = {}
        self.hotkey_fields = {
            HOTKEY_FIELD_BASE + index: field for index, field in enumerate(CAPTURE_FIELDS)
        }

        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("Company Peek")

        self.panel = tk.Toplevel(self.root, bg=BORDER)
        self.panel.withdraw()
        self.panel.overrideredirect(True)
        self.panel.attributes("-topmost", True)
        self.panel.bind("<Escape>", lambda _e: self.hide())
        # Deliberately no <FocusOut> close: the app the text was selected in often
        # takes focus straight back, which would tear the panel down in milliseconds.
        # The auto-hide timer, Escape and the close button are the ways out.

        # One pixel of BORDER shows around the frame as the panel's outline.
        self.body = tk.Frame(self.panel, bg=BG)
        self.body.pack(fill="both", expand=True, padx=1, pady=1)
        self._build()

    # ---------- layout ----------

    def _build(self):
        head = tk.Frame(self.body, bg=BG)
        head.pack(fill="x", padx=12, pady=(10, 8))

        close = tk.Label(head, text="✕", bg=BG, fg=MUTED, font=(FONT, 11), cursor="hand2")
        close.pack(side="right")
        close.bind("<Button-1>", lambda _e: self.hide())

        titles = tk.Frame(head, bg=BG)
        titles.pack(side="left", fill="x", expand=True)
        self.term_label = tk.Label(
            titles, text="", bg=BG, fg=TEXT, font=(FONT, 11, "bold"), anchor="w", justify="left"
        )
        self.term_label.pack(fill="x")
        self.count_label = tk.Label(titles, text="", bg=BG, fg=MUTED, font=(FONT, 8), anchor="w")
        self.count_label.pack(fill="x")

        tk.Frame(self.body, bg=BORDER, height=1).pack(fill="x")

        self.status_bar = tk.Frame(self.body, bg=BG)
        self.status_bar.pack(fill="x")
        self.status_rule = tk.Frame(self.body, bg=BORDER, height=1)

        # Canvas + inner frame so a long result list scrolls instead of growing.
        self.canvas = tk.Canvas(self.body, bg=BG, highlightthickness=0, bd=0)
        self.canvas.pack(fill="both", expand=True)
        self.rows = tk.Frame(self.canvas, bg=BG)
        self.canvas.create_window((0, 0), window=self.rows, anchor="nw", width=PANEL_WIDTH - 2)
        self.rows.bind("<Configure>", self._on_rows_resize)
        self.panel.bind("<MouseWheel>", self._on_wheel)

        tk.Frame(self.body, bg=BORDER, height=1).pack(fill="x")
        self.foot = tk.Label(
            self.body, text=HOTKEY_LABEL, bg=BG_ALT, fg=MUTED, font=(FONT, 8), anchor="w", padx=12, pady=5
        )
        self.foot.pack(fill="x")

    def _on_rows_resize(self, _event):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))

    def _on_wheel(self, event):
        self.canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")

    def _clear(self):
        for widget in list(self.status_bar.winfo_children()) + list(self.rows.winfo_children()):
            widget.destroy()
        self.status_rule.pack_forget()

    def _note(self, message, color=MUTED):
        tk.Label(
            self.rows,
            text=message,
            bg=BG,
            fg=color,
            font=(FONT, 9),
            anchor="w",
            justify="left",
            wraplength=PANEL_WIDTH - 34,
        ).pack(fill="x", padx=12, pady=12)

    def _chip(self, parent, text, bg, fg):
        return tk.Label(parent, text=text, bg=bg, fg=fg, font=(FONT, 8), padx=7, pady=2)

    def _add_row(self, item):
        row = tk.Frame(self.rows, bg=BG)
        row.pack(fill="x", padx=12, pady=(8, 0))

        top = tk.Frame(row, bg=BG)
        top.pack(fill="x")
        self._chip(top, item.get("profileName", "?"), BG_ALT, TEXT).pack(side="left")
        status = item.get("status", "")
        bg, fg = STATUS_COLORS.get(status, (BG_ALT, MUTED))
        self._chip(top, status, bg, fg).pack(side="right")

        tk.Label(
            row,
            text=item.get("jobTitle", ""),
            bg=BG,
            fg=TEXT,
            font=(FONT, 9, "bold"),
            anchor="w",
            justify="left",
            wraplength=PANEL_WIDTH - 34,
        ).pack(fill="x", pady=(3, 0))

        company = item.get("company") or "No company"
        date = format_date(item.get("appliedAt"))
        meta = company + ("  ·  " + date if date else "")
        tk.Label(
            row,
            text=meta,
            bg=BG,
            # An exact company hit reads brighter than a mere substring match.
            fg=TEXT if item.get("exact") else MUTED,
            font=(FONT, 8),
            anchor="w",
        ).pack(fill="x", pady=(1, 0))

        tk.Frame(self.rows, bg=BORDER, height=1).pack(fill="x", pady=(8, 0))

    def _add_field(self, field, highlight=False):
        """One captured value: its label, its hotkey, and what is in it."""
        key, label, _vk, combo, _multiline = field
        value = self.draft.get(key, "")

        row = tk.Frame(self.rows, bg=BG)
        row.pack(fill="x", padx=12, pady=(8, 0))

        head = tk.Frame(row, bg=BG)
        head.pack(fill="x")
        tk.Label(
            head,
            text=label,
            bg=BG,
            # The field just captured is picked out so the panel confirms the hotkey.
            fg=ACCENT if highlight else MUTED,
            font=(FONT, 8, "bold"),
        ).pack(side="left")
        tk.Label(head, text=combo, bg=BG, fg=MUTED, font=(FONT, 8)).pack(side="right")

        tk.Label(
            row,
            text=preview_value(value) if value else "nothing captured yet",
            bg=BG,
            fg=TEXT if value else MUTED,
            font=(FONT, 9) if value else (FONT, 9, "italic"),
            anchor="w",
            justify="left",
            wraplength=PANEL_WIDTH - 34,
        ).pack(fill="x", pady=(3, 0))

        tk.Frame(self.rows, bg=BORDER, height=1).pack(fill="x", pady=(8, 0))

    # ---------- showing ----------

    def _place(self):
        self.panel.update_idletasks()
        height = self.body.winfo_reqheight() + 2
        x, y = self.anchor
        left, top, right, bottom = work_area(x, y)

        px = min(max(x + 12, left + 8), max(left + 8, right - PANEL_WIDTH - 8))
        py = y + 18
        # Flip above the pointer when the panel would run off the bottom.
        if py + height > bottom - 8:
            py = max(top + 8, y - height - 12)
        self.panel.geometry(f"{PANEL_WIDTH}x{height}+{int(px)}+{int(py)}")

    def _show(self, auto_hide=True, delay=AUTO_HIDE_MS):
        self._place()
        self.panel.deiconify()
        self.panel.lift()
        self.panel.focus_force()
        self._cancel_auto_hide()
        # No countdown while the answer is still on its way - it starts when
        # there is something to read.
        if auto_hide:
            self._hide_delay = delay
            self._hide_job = self.root.after(delay, self._auto_hide)

    def _cancel_auto_hide(self):
        if self._hide_job is not None:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None

    def _pointer_inside(self):
        px, py = self.panel.winfo_pointerxy()
        x, y = self.panel.winfo_rootx(), self.panel.winfo_rooty()
        return x <= px < x + self.panel.winfo_width() and y <= py < y + self.panel.winfo_height()

    def _auto_hide(self):
        self._hide_job = None
        # Reading the list keeps it open; the timer restarts once you move off.
        if self._pointer_inside():
            self._hide_job = self.root.after(self._hide_delay, self._auto_hide)
            return
        self.hide()

    def hide(self):
        self._cancel_auto_hide()
        self.request_id += 1
        self.panel.withdraw()

    def show_message(
        self, term, message, color=MUTED, auto_hide=True, foot=HOTKEY_LABEL, delay=AUTO_HIDE_MS
    ):
        self._clear()
        self.term_label.config(text=term or "Company Peek")
        self.count_label.config(text="")
        self.foot.config(text=foot)
        self._note(message, color)
        self.rows.update_idletasks()
        self.canvas.configure(height=self.rows.winfo_reqheight())
        self._show(auto_hide, delay)

    @staticmethod
    def _spread(data):
        """Name the companies behind the hits when they are not just the term itself."""
        names = data["companies"]
        if len(names) > 1:
            return f"across {len(names)} companies"
        if names and names[0].lower() != data["term"].lower():
            return names[0]
        return ""

    def show_result(self, data):
        self._clear()
        self.term_label.config(text=data["term"])
        total = data["total"]
        self.count_label.config(text=f"{total} application" + ("" if total == 1 else "s"))

        for status, count in data["byStatus"].items():
            bg, fg = STATUS_COLORS.get(status, (BG_ALT, MUTED))
            self._chip(self.status_bar, f"{status} {count}", bg, fg).pack(
                side="left", padx=(12, 0), pady=8
            )
        if data["byStatus"]:
            self.status_rule.pack(fill="x", before=self.canvas)

        if not data["items"]:
            self._note("No applications filed under a company matching this.")
        else:
            for item in data["items"]:
                self._add_row(item)

        foot = f"showing {data['shown']} of {total}" if data["shown"] < total else HOTKEY_LABEL
        spread = self._spread(data)
        if spread:
            foot += "   ·   " + spread
        self.foot.config(text=foot)

        self.rows.update_idletasks()
        self.canvas.configure(height=min(self.rows.winfo_reqheight(), LIST_MAX_HEIGHT))
        self.canvas.yview_moveto(0)
        self._show()

    def show_draft(self, saved=None):
        """Everything captured so far, in the order the hotkeys are numbered."""
        self._clear()
        self.term_label.config(text="Job draft")
        filled = sum(1 for field in CAPTURE_FIELDS if self.draft.get(field[0]))
        self.count_label.config(text=f"{filled} of {len(CAPTURE_FIELDS)} fields captured")

        for field in CAPTURE_FIELDS:
            self._add_field(field, highlight=field[0] == saved)

        self.foot.config(text=DRAFT_HINT)
        self.rows.update_idletasks()
        # No cap and so no scrolling: four fields is a bounded amount of text, and
        # a list you have to scroll is unreadable behind a one-second timer.
        self.canvas.configure(height=self.rows.winfo_reqheight())
        self.canvas.yview_moveto(0)
        self._show(delay=DRAFT_HIDE_MS)

    # ---------- wiring ----------

    def on_hotkey(self, hotkey_id):
        """Runs on the hotkey thread: grab the selection, hand it to the UI."""
        anchor = cursor_position()
        # Alt+0 reads back what is already held - nothing to copy out of the app.
        if hotkey_id == HOTKEY_DRAFT:
            self.events.put(("draft", anchor, None, None))
            return

        field = self.hotkey_fields.get(hotkey_id)
        try:
            text = copy_selection(hotkey_vk=VK_X if field is None else field[2])
        except Exception as err:  # noqa: BLE001 - never kill the hotkey thread
            self.events.put(("error", anchor, None, str(err)))
            return

        if field is None:
            self.events.put(("term", anchor, clean_term(text), None))
        else:
            self.events.put(("capture", anchor, field[0], clean_value(text, field[4])))

    def _query(self, request_id, term):
        try:
            data = self.lookup.companies(term, limit=RESULT_LIMIT)
            self.events.put(("result", None, request_id, data))
        except Exception as err:  # noqa: BLE001 - surfaced in the panel
            self.events.put(("failed", None, request_id, str(err)))

    def _handle(self, kind, anchor, payload, extra):
        if kind == "term":
            self.anchor = anchor
            self.request_id += 1
            if not payload:
                self.show_message(
                    "", f"No text selected. Highlight a company name, then press {HOTKEY_LABEL}."
                )
            elif len(payload) < 2:
                self.show_message(payload, "Select at least 2 characters of a company name.")
            else:
                self.show_message(payload, "Looking up…", auto_hide=False)
                threading.Thread(
                    target=self._query, args=(self.request_id, payload), daemon=True
                ).start()
        elif kind == "capture":
            self.anchor = anchor
            # Any lookup still in flight must not paint over the draft panel.
            self.request_id += 1
            field = FIELDS_BY_KEY[payload]
            if not extra:
                self.show_message(
                    "",
                    f"No text selected. Highlight the {field[1].lower()}, then press {field[3]}.",
                    foot=DRAFT_HINT,
                    delay=DRAFT_HIDE_MS,
                )
            else:
                self.draft[payload] = extra
                self.show_draft(saved=payload)
        elif kind == "draft":
            self.anchor = anchor
            self.request_id += 1
            self.show_draft()
        elif kind == "error":
            self.anchor = anchor
            self.show_message("", extra, DANGER)
        # A stale reply from a lookup the user has already replaced is dropped.
        elif kind == "result" and payload == self.request_id:
            self.show_result(extra)
        elif kind == "failed" and payload == self.request_id:
            self.show_message(self.term_label.cget("text"), extra, DANGER)

    def _pump(self):
        try:
            while True:
                self._handle(*self.events.get_nowait())
        except queue.Empty:
            pass
        # Also the tick that lets Ctrl+C reach the interpreter.
        self.root.after(60, self._pump)

    def run(self):
        self.anchor = cursor_position()

        bindings = [
            (HOTKEY_PEEK, MOD_CONTROL | MOD_SHIFT, VK_X),
            (HOTKEY_DRAFT, MOD_ALT, VK_0),
        ] + [
            (HOTKEY_FIELD_BASE + index, MOD_ALT, field[2])
            for index, field in enumerate(CAPTURE_FIELDS)
        ]
        labels = {HOTKEY_PEEK: HOTKEY_LABEL, HOTKEY_DRAFT: "Alt+0"}
        labels.update({key: field[3] for key, field in self.hotkey_fields.items()})

        def unavailable(hotkey_id, error):
            print(
                f"[peek] {labels.get(hotkey_id, hotkey_id)} is unavailable "
                f"(error {error}); another application owns it.",
                file=sys.stderr,
            )

        def listen():
            try:
                hotkey_loop(bindings, self.on_hotkey, unavailable)
            except OSError as err:
                print(f"[peek] {err}", file=sys.stderr)

        threading.Thread(target=listen, daemon=True).start()
        self.root.after(60, self._pump)
        print(f"[peek] watching for {HOTKEY_LABEL}  (database: {self.lookup.db_name})")
        print("[peek] select a company name in any window, then press the hotkey.")
        for field in CAPTURE_FIELDS:
            print(f"[peek] {field[3]}  capture the selection as the {field[1].lower()}")
        print("[peek] Alt+0  show what has been captured")
        print("[peek] Ctrl+C here to quit.")
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            pass


def print_result(data):
    print(f"{data['term']}: {data['total']} application(s)")
    if data["byStatus"]:
        print("  " + "  ".join(f"{k}={v}" for k, v in data["byStatus"].items()))
    if data["companies"]:
        print("  companies: " + ", ".join(data["companies"]))
    for item in data["items"]:
        mark = "*" if item.get("exact") else " "
        profile = item.get("profileName", "?")
        title = item.get("jobTitle", "")
        status = item.get("status", "")
        print(
            f"  {mark} {profile:<18} {title:<28} {status:<10} "
            f"{item.get('company', '')}  {format_date(item.get('appliedAt'))}"
        )


def main():
    parser = argparse.ArgumentParser(description="Company Peek - Ctrl+Shift+X company lookup")
    parser.add_argument("--query", help="run one lookup, print it, and exit (no hotkey, no window)")
    parser.add_argument("--uri", help="MongoDB URI (default: MONGODB_URI, then server/.env)")
    args = parser.parse_args()

    try:
        lookup = Lookup(args.uri)
        lookup.ping()
    except Exception as err:  # noqa: BLE001
        print(f"[peek] cannot reach MongoDB: {err}", file=sys.stderr)
        return 2

    if args.query:
        try:
            print_result(lookup.companies(args.query, limit=RESULT_LIMIT))
        except ValueError as err:
            print(f"[peek] {err}", file=sys.stderr)
            return 1
        return 0

    set_dpi_awareness()
    try:
        Peek(lookup).run()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
