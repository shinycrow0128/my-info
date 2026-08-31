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

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
CF_UNICODETEXT = 13
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


def copy_selection(timeout=0.7):
    """Ctrl+C the foreground app's selection and hand back the text.

    Returns None when nothing was selected - detected by the clipboard sequence
    number never moving, which also keeps a stale clipboard from being mistaken
    for a fresh selection.
    """
    before_seq = user32.GetClipboardSequenceNumber()
    previous = get_clipboard_text()

    # The hotkey itself is Ctrl+Shift+X, so those keys are still physically down;
    # Ctrl+Shift+C means something else entirely in most editors.
    _send(_key(VK_X, True), _key(VK_SHIFT, True), _key(VK_MENU, True), _key(VK_LWIN, True), _key(VK_RWIN, True))
    time.sleep(0.04)
    _send(_key(VK_CONTROL, False), _key(VK_C, False), _key(VK_C, True), _key(VK_CONTROL, True))

    deadline = time.time() + timeout
    text = None
    while time.time() < deadline:
        time.sleep(0.03)
        if user32.GetClipboardSequenceNumber() != before_seq:
            text = get_clipboard_text()
            break

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


def hotkey_loop(on_press, modifiers=MOD_CONTROL | MOD_SHIFT, vk=VK_X, hotkey_id=1):
    """Register the hotkey and pump messages. Runs until the thread is killed.

    RegisterHotKey binds to the calling thread, so this owns a thread of its own
    and hands work back to the UI thread through `on_press`.
    """
    if not user32.RegisterHotKey(None, hotkey_id, modifiers | MOD_NOREPEAT, vk):
        raise OSError(
            f"Could not register the hotkey (error {ctypes.get_last_error()}). "
            "Another application probably already owns it."
        )

    message = wintypes.MSG()
    try:
        while user32.GetMessageW(ctypes.byref(message), None, 0, 0) != 0:
            if message.message == WM_HOTKEY and message.wParam == hotkey_id:
                on_press()
            user32.TranslateMessage(ctypes.byref(message))
            user32.DispatchMessageW(ctypes.byref(message))
    finally:
        user32.UnregisterHotKey(None, hotkey_id)
