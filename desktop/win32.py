"""The Windows bits: a global hotkey, the current selection, and where to draw.

Grabbing a selection out of another process means asking that process to copy it:
the hotkey releases the keys the user is holding, sends Ctrl+C, waits for the
clipboard sequence number to move, reads it, and puts the old clipboard back.
"""

import ctypes
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32", use_last_error=True)

MOD_ALT = 0x0001
MOD_CONTROL = 0x0002
MOD_SHIFT = 0x0004
MOD_NOREPEAT = 0x4000
WM_HOTKEY = 0x0312

VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_C = 0x43
VK_X = 0x58
# The number row - VK_0 through VK_9 are contiguous from 0x30.
VK_0 = 0x30
VK_1 = 0x31
VK_2 = 0x32
VK_3 = 0x33
VK_4 = 0x34
VK_5 = 0x35
VK_6 = 0x36

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
CF_UNICODETEXT = 13
# A file copied in Explorer arrives as a drop list, never as text.
CF_HDROP = 15
GMEM_MOVEABLE = 0x0002
MONITOR_DEFAULTTONEAREST = 2

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


# Without explicit restypes ctypes truncates 64-bit handles to int.
user32.GetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.restype = wintypes.HANDLE
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.MonitorFromPoint.restype = wintypes.HANDLE
user32.GetClipboardSequenceNumber.restype = wintypes.DWORD
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.restype = wintypes.LPVOID
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
shell32.DragQueryFileW.restype = wintypes.UINT
shell32.DragQueryFileW.argtypes = [
    wintypes.HANDLE,
    wintypes.UINT,
    wintypes.LPWSTR,
    wintypes.UINT,
]


def set_dpi_awareness():
    """Keep cursor coordinates and Tk coordinates in the same units."""
    try:
        ctypes.WinDLL("shcore").SetProcessDpiAwareness(1)  # system DPI aware
        return True
    except Exception:
        try:
            return bool(user32.SetProcessDPIAware())
        except Exception:
            return False


def _key(vk, up):
    flags = KEYEVENTF_KEYUP if up else 0
    return INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0))


def _send(*inputs):
    array = (INPUT * len(inputs))(*inputs)
    user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))


def _open_clipboard(attempts=10):
    """Another app may hold the clipboard for a moment; wait it out."""
    for _ in range(attempts):
        if user32.OpenClipboard(None):
            return True
        time.sleep(0.02)
    return False


def get_clipboard_text():
    if not _open_clipboard():
        return None
    try:
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return None
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return None
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return None
        try:
            return ctypes.c_wchar_p(pointer).value
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def set_clipboard_text(text):
    if text is None:
        return False
    if not _open_clipboard():
        return False
    try:
        user32.EmptyClipboard()
        buffer = ctypes.create_unicode_buffer(text)
        size = ctypes.sizeof(buffer)
        handle = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        if not handle:
            return False
        pointer = kernel32.GlobalLock(handle)
        ctypes.memmove(pointer, buffer, size)
        kernel32.GlobalUnlock(handle)
        # On success the clipboard owns the block, so it must not be freed here.
        return bool(user32.SetClipboardData(CF_UNICODETEXT, handle))
    finally:
        user32.CloseClipboard()


def get_clipboard_files():
    """The clipboard's file drop list - full paths, in the order they were copied.

    Explorer does not put a copied file on the clipboard as text: it publishes
    CF_HDROP, a list of paths, which is why reading the clipboard as text after
    copying a file comes back empty. Returns [] when the clipboard holds no files.
    """
    if not _open_clipboard():
        return []
    try:
        if not user32.IsClipboardFormatAvailable(CF_HDROP):
            return []
        handle = user32.GetClipboardData(CF_HDROP)
        if not handle:
            return []
        # Index 0xFFFFFFFF asks how many files there are rather than for one path.
        count = shell32.DragQueryFileW(handle, 0xFFFFFFFF, None, 0)
        paths = []
        for index in range(count):
            # The first call sizes the path, the second fills it: the returned
            # length excludes the terminator, so the buffer is one wider.
            length = shell32.DragQueryFileW(handle, index, None, 0)
            buffer = ctypes.create_unicode_buffer(length + 1)
            if shell32.DragQueryFileW(handle, index, buffer, length + 1):
                paths.append(buffer.value)
        return paths
    finally:
        user32.CloseClipboard()


def _press_copy(hotkey_vk):
    """Let go of the hotkey the user is holding, then send a clean Ctrl+C."""
    _send(_key(hotkey_vk, True), _key(VK_SHIFT, True), _key(VK_LWIN, True), _key(VK_RWIN, True))
    time.sleep(0.04)
    # Ctrl goes down before Alt comes up: the capture hotkeys are Alt+digit, and a
    # lone Alt release reads as an Alt tap, which drops focus into the app's menu bar.
    _send(_key(VK_CONTROL, False), _key(VK_MENU, True))
    _send(_key(VK_C, False), _key(VK_C, True), _key(VK_CONTROL, True))


def _await_clipboard(before_seq, read, timeout):
    """Wait for the copy to land, then read it. None if the clipboard never moved.

    Watching the sequence number is what tells an empty selection apart from a
    successful copy, and keeps a stale clipboard from being read as a fresh one.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.03)
        if user32.GetClipboardSequenceNumber() != before_seq:
            return read()
    return None


def copy_selection_files(timeout=0.7, hotkey_vk=VK_X):
    """Ctrl+C the foreground app's selection and hand back the file paths.

    For Explorer, where the selection is a file rather than text. The copy is
    left on the clipboard, so the file can still be pasted into a folder.

    Returns [] when nothing was selected, or when the selection was not files.
    """
    before_seq = user32.GetClipboardSequenceNumber()
    _press_copy(hotkey_vk)
    return _await_clipboard(before_seq, get_clipboard_files, timeout) or []


def copy_selection(timeout=0.7, hotkey_vk=VK_X, keep_clipboard=False):
    """Ctrl+C the foreground app's selection and hand back the text.

    `hotkey_vk` is the non-modifier key of the hotkey that fired; it is still
    physically down, as are its modifiers, and Ctrl+Shift+C or Ctrl+Alt+C mean
    something else entirely in most editors.

    `keep_clipboard` leaves the copied selection on the clipboard instead of
    putting back what was there before, so the capture hotkeys double as a plain
    copy and the text can be pasted elsewhere.

    Returns None when nothing was selected - detected by the clipboard sequence
    number never moving, which also keeps a stale clipboard from being mistaken
    for a fresh selection.
    """
    before_seq = user32.GetClipboardSequenceNumber()
    previous = None if keep_clipboard else get_clipboard_text()

    _press_copy(hotkey_vk)
    text = _await_clipboard(before_seq, get_clipboard_text, timeout)

    if previous is not None and text is not None:
        time.sleep(0.03)
        set_clipboard_text(previous)

    return text


def cursor_position():
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def work_area(x, y):
    """Usable bounds of the monitor under (x, y) - taskbar excluded."""
    monitor = user32.MonitorFromPoint(wintypes.POINT(x, y), MONITOR_DEFAULTTONEAREST)
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        return 0, 0, user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    r = info.rcWork
    return r.left, r.top, r.right, r.bottom


def hotkey_loop(bindings, on_press, on_error=None):
    """Register every hotkey and pump messages. Runs until the thread is killed.

    `bindings` is a list of (hotkey_id, modifiers, vk); `on_press` is called with
    the id of whichever fired. A key another application already owns is reported
    through `on_error` and skipped, so one clash does not cost all the others.

    RegisterHotKey binds to the calling thread, so this owns a thread of its own
    and hands work back to the UI thread through `on_press`.
    """
    registered = []
    for hotkey_id, modifiers, vk in bindings:
        if user32.RegisterHotKey(None, hotkey_id, modifiers | MOD_NOREPEAT, vk):
            registered.append(hotkey_id)
        elif on_error is not None:
            on_error(hotkey_id, ctypes.get_last_error())

    if not registered:
        raise OSError(
            "Could not register any hotkey. Another application probably already owns them."
        )

    known = set(registered)
    message = wintypes.MSG()
    try:
        while user32.GetMessageW(ctypes.byref(message), None, 0, 0) != 0:
            if message.message == WM_HOTKEY and message.wParam in known:
                on_press(message.wParam)
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))
    finally:
        for hotkey_id in registered:
            user32.UnregisterHotKey(None, hotkey_id)
