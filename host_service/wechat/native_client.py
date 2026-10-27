"""Bounded, read-only navigation of the selected WeChat client's media history.

No send/forward/delete/login operations; no guessed coordinates. A message's
file is accepted only by the resource reader's original group/hash binding.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
from pathlib import Path
import re
import time
import types

from .archive import ArchiveError


class ClientReadError(ArchiveError):
    pass


class ClientInterrupted(ClientReadError):
    pass


def clean_chat_name(name):
    return re.sub(r'(?:(?:长按|按住)鼠标\s*)?语音输入(?:文字)?$', '', name or '').strip()


def exact_group_results(rows, name):
    """Search history, people and approximate names are never group matches."""
    matches = {}
    for row in rows:
        if row['section'] == '群聊' and row['name'].split('\n', 1)[0].strip() == name:
            matches[row['aid']] = row
    if len(matches) != 1:
        raise ClientReadError('微信搜索未返回唯一的目标群，已停止客户端操作')
    return next(iter(matches.values()))


def history_matches(title, group_name):
    return bool(re.fullmatch(r'["“]?' + re.escape(group_name) + r'["”]?的聊天记录(?:\(\d+\)|（\d+）)?', title or ''))


class _SilentLog:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


@contextmanager
def temporary_accessibility(driver):
    """Use the existing upstream Qt bridge only in this verified process.

    Disable its global screen-reader flag and filesystem caches. Restore every
    changed runtime byte on exit. This never restarts WeChat or injects code.
    """
    source_path = Path(__file__).parent / 'vendor' / 'wechat_accessibility.py'
    raw = source_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != '045bbf826a1bab8410886090988a3e32afdec403b4beec6b64c0406c47830f38':
        raise ClientReadError('微信客户端读取组件校验失败')
    source = raw.decode('utf-8')
    for anchor in ('import uiautomation as auto', 'from wechatauto.logger import wxlog'):
        if source.count(anchor) != 1:
            raise ClientReadError('微信客户端读取组件结构变化')
        source = source.replace(anchor, '# supplied by isolated adapter')
    module = types.ModuleType('observe_wechat_accessibility')
    module.__file__ = str(source_path)
    module.auto = types.SimpleNamespace(ControlFromHandle=driver.control)
    module.wxlog = _SilentLog()
    exec(compile(source, str(source_path), 'exec'), module.__dict__)
    module._gate_cache = lambda: {}
    module._gate_cache_put = lambda *args, **kwargs: None
    gate = module.AccessibilityGate
    def deny_system_setting(*args, **kwargs):
        raise ClientReadError('客户端读取不允许更改系统读屏设置')
    gate._set_screen_reader_flag = staticmethod(deny_system_setting)
    original_pid = gate._pid_from_hwnd
    gate._pid_from_hwnd = staticmethod(lambda hwnd: driver.pid if hwnd == driver.hwnd and original_pid(hwnd) == driver.pid else None)
    original_write = gate._write_process_byte
    changed = {}
    def scoped_write(handle, address, value):
        current = gate._read_process_byte(handle, address)
        if current not in (0, 1) or value not in (0, 1):
            return False
        changed.setdefault(address, current)
        return original_write(handle, address, value)
    gate._write_process_byte = staticmethod(scoped_write)
    try:
        if not driver.tree_ready() and not gate._hot_activate_accessibility(driver.hwnd, verify=True, max_candidates=4):
            raise ClientReadError('微信控件树暂不可读取，已停止客户端补下载')
        yield
    finally:
        # The original HWND and process must still exist before restoring flags.
        if changed and original_pid(driver.hwnd) == driver.pid:
            import ctypes
            handle = ctypes.windll.kernel32.OpenProcess(0x0010 | 0x0400 | 0x0020 | 0x0008, False, driver.pid)
            if handle:
                try:
                    for address, value in changed.items():
                        original_write(handle, address, value)
                finally:
                    ctypes.windll.kernel32.CloseHandle(handle)


class WindowsClient:
    """UIA selectors with fresh identity/focus checks before every action."""
    def __init__(self, pid, config):
        import ctypes
        import comtypes.client
        import win32gui
        import win32process
        import win32api
        self.win = win32gui
        self.process = win32process
        self.api = win32api
        self.pid = pid
        self.config = config
        self.created = set()
        self.paused = False
        self.last_input = win32api.GetLastInputInfo()
        self.ctypes = ctypes
        self.com = comtypes.client.GetModule('UIAutomationCore.dll')
        self.uia = comtypes.client.CreateObject(self.com.CUIAutomation, interface=self.com.IUIAutomation)
        mains = [hwnd for hwnd, title in self.windows() if title in ('微信', 'Weixin')]
        if len(mains) != 1:
            raise ClientReadError('未找到指定微信进程的唯一主窗口，已停止补下载')
        self.hwnd = mains[0]
        if any(title == '图片和视频' for _, title in self.windows()):
            raise ClientReadError('请先关闭已有的微信图片查看窗口，再补取附件')
        if self.win.IsIconic(self.hwnd):
            self.win.ShowWindow(self.hwnd, 9)

    def windows(self):
        result = []
        def add(hwnd, _):
            if self.win.IsWindowVisible(hwnd) and self.process.GetWindowThreadProcessId(hwnd)[1] == self.pid:
                result.append((hwnd, self.win.GetWindowText(hwnd)))
        self.win.EnumWindows(add, None)
        return result

    def control(self, hwnd):
        outer = self
        class Control:
            def __init__(self, element): self.element = element
            @property
            def ClassName(self): return self.element.CurrentClassName
            def GetChildren(self):
                result = []
                walker = outer.uia.ControlViewWalker
                child = walker.GetFirstChildElement(self.element)
                while child:
                    result.append(Control(child))
                    if len(result) > 1000:
                        raise ClientReadError('微信控件数量异常，已停止补下载')
                    child = walker.GetNextSiblingElement(child)
                return result
        return Control(self.uia.ElementFromHandle(hwnd))

    def tree_ready(self):
        return any(str(node.CurrentClassName).startswith('mmui::') for node in self.nodes(self.hwnd))

    def nodes(self, hwnd, limit=2500):
        root = self.uia.ElementFromHandle(hwnd)
        queue = [root]
        walker = self.uia.ControlViewWalker
        count = 0
        while queue:
            node = queue.pop()
            count += 1
            if count > limit:
                raise ClientReadError('微信控件数量异常，已停止补下载')
            yield node
            children = []
            child = walker.GetFirstChildElement(node)
            while child:
                children.append(child)
                if len(children) > limit:
                    raise ClientReadError('微信控件数量异常，已停止补下载')
                child = walker.GetNextSiblingElement(child)
            queue.extend(reversed(children))

    def check(self, hwnd):
        if self.api.GetLastInputInfo() != self.last_input:
            self.paused = True
            raise ClientInterrupted('检测到电脑正在被操作，客户端补下载已暂停，已取得内容保留')
        if not self.win.IsWindow(hwnd) or self.process.GetWindowThreadProcessId(hwnd)[1] != self.pid:
            raise ClientReadError('微信窗口或进程发生变化，客户端补下载已停止')

    def select(self, hwnd, predicate, required=True):
        rows = [node for node in self.nodes(hwnd) if predicate(node)]
        if len(rows) != 1:
            if not rows and not required: return None
            raise ClientReadError('无法唯一定位微信读取控件，已停止补下载')
        return rows[0]

    def click(self, hwnd, node):
        self.check(hwnd)
        if node.CurrentProcessId != self.pid:
            raise ClientReadError('读取控件不属于指定微信进程')
        rectangle = node.CurrentBoundingRectangle
        left, top, right, bottom = rectangle.left, rectangle.top, rectangle.right, rectangle.bottom
        if right <= left or bottom <= top or node.CurrentIsOffscreen:
            raise ClientReadError('微信读取控件不可见，已停止补下载')
        self.win.SetForegroundWindow(hwnd)
        x, y = (left + right) // 2, (top + bottom) // 2
        point_window = self.win.WindowFromPoint((x, y))
        if self.win.GetAncestor(point_window, 2) != hwnd:
            raise ClientReadError('微信窗口被其他窗口遮挡，已暂停客户端补下载')
        self.api.SetCursorPos((x, y))
        self.api.mouse_event(2, 0, 0)
        self.api.mouse_event(4, 0, 0)
        time.sleep(.12)
        self.last_input = self.api.GetLastInputInfo()

    def key(self, hwnd, key, control=False):
        self.check(hwnd)
        self.win.SetForegroundWindow(hwnd)
        if self.win.GetForegroundWindow() != hwnd:
            raise ClientReadError('微信窗口未获得焦点，已停止补下载')
        if control: self.api.keybd_event(0x11, 0, 0, 0)
        self.api.keybd_event(key, 0, 0, 0)
        self.api.keybd_event(key, 0, 2, 0)
        if control: self.api.keybd_event(0x11, 0, 2, 0)
        time.sleep(.12)
        self.last_input = self.api.GetLastInputInfo()

    def wait(self, action, timeout=5):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            value = action()
            if value: return value
            time.sleep(.2)
        raise ClientReadError('微信读取窗口未就绪，已停止补下载')

    def current_group(self):
        matches = [n for n in self.nodes(self.hwnd)
                   if str(n.CurrentAutomationId).split('.')[-1] == 'chat_input_field']
        return clean_chat_name(matches[0].CurrentName) if len(matches) == 1 else None

    def open_group(self):
        name = self.config['group_name']
        if self.current_group() == name: return
        button = self.select(self.hwnd, lambda n: n.CurrentName == '搜索' and n.CurrentControlType == 50000, required=False)
        if button: self.click(self.hwnd, button)
        box = self.select(self.hwnd, lambda n: n.CurrentControlType == 50004
                          and n.CurrentName == '搜索' and str(n.CurrentAutomationId).split('.')[-1] != 'chat_input_field')
        self.check(self.hwnd)
        try:
            value = box.GetCurrentPattern(10002).QueryInterface(self.com.IUIAutomationValuePattern)
            value.SetValue(name)
        except Exception:
            # Never paste or type into an unverified focus as a fallback.
            raise ClientReadError('微信搜索框暂不可安全写入，已停止补下载') from None
        def results():
            section = ''
            result = []
            for node in self.nodes(self.hwnd):
                text, aid = node.CurrentName or '', node.CurrentAutomationId or ''
                if text.strip() in ('群聊', '联系人', '聊天记录', '最近使用', '最常使用') and not aid:
                    section = text.strip()
                if aid.startswith('search_item_'):
                    result.append({'name': text, 'aid': aid, 'section': section, 'node': node})
            return result
        rows = self.wait(results)
        selected = exact_group_results(rows, name)
        self.click(self.hwnd, selected['node'])
        self.wait(lambda: self.current_group() == name)

    def open_history(self, tab):
        self.open_group()
        before = {h for h, _ in self.windows()}
        # Ctrl+F is non-writing; no Enter/Return is ever sent by this driver.
        self.key(self.hwnd, 0x46, control=True)
        def find():
            rows = [h for h, title in self.windows() if history_matches(title, self.config['group_name'])]
            return rows[0] if len(rows) == 1 else None
        history = self.wait(find)
        self.created.update({history} - before)
        button = self.select(history, lambda n: n.CurrentName == tab and n.CurrentControlType in (50000, 50019, 50005))
        self.click(history, button)
        return history

    def download_images(self, pending, poll, limit, timeout=300):
        history = self.open_history('图片与视频')
        def pictures():
            candidates = []
            for node in self.nodes(history):
                rectangle = node.CurrentBoundingRectangle
                if (node.CurrentControlType == 50006 and not node.CurrentIsOffscreen
                        and rectangle.right - rectangle.left >= 64 and rectangle.bottom - rectangle.top >= 64):
                    candidates.append(node)
            return candidates
        candidates = self.wait(pictures)
        before = {h for h, _ in self.windows()}
        self.click(history, candidates[0])
        viewer = self.wait(lambda: next((h for h, title in self.windows() if title == '图片和视频' and h not in before), None))
        self.created.add(viewer)
        deadline = time.monotonic() + timeout
        visited = 0
        while pending() and visited < limit and time.monotonic() < deadline:
            self.check(viewer)
            original = self.select(viewer, lambda n: n.CurrentName in ('查看原图', '下载原图') and n.CurrentControlType == 50000, required=False)
            if original: self.click(viewer, original)
            # Wait for the client's own file writes; poll checks complete bytes.
            until = min(deadline, time.monotonic() + 2)
            while time.monotonic() < until:
                poll()
                if not pending(): break
                time.sleep(.25)
            visited += 1
            previous = self.select(viewer, lambda n: n.CurrentName in ('上一张', '上一个') and n.CurrentControlType == 50000, required=False)
            if previous:
                if not previous.CurrentIsEnabled: break
                self.click(viewer, previous)
            else:
                # The image viewer is bound to this group's history; Left can
                # only navigate media and is never sent to a chat edit box.
                focused = self.uia.GetFocusedElement()
                if focused and focused.CurrentControlType == 50004:
                    raise ClientReadError('图片窗口焦点发生变化，已停止补下载')
                self.key(viewer, 0x25)
        poll()
        return {'visited': visited, 'remaining': pending()}

    def close(self):
        if self.paused: return
        for hwnd in reversed(sorted(self.created)):
            if self.win.IsWindow(hwnd) and self.process.GetWindowThreadProcessId(hwnd)[1] == self.pid:
                self.win.PostMessage(hwnd, 0x0010, 0, 0)


@contextmanager
def desktop_lease():
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.windll.kernel32
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    handle = kernel.CreateMutexW(None, False, 'Local\\ObserveWechatResourceRead')
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    acquired = handle and kernel.WaitForSingleObject(handle, 0) in (0, 0x80)
    try:
        if not acquired: raise ClientReadError('已有微信客户端补下载正在执行')
        yield
    finally:
        if handle:
            kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
            kernel.CloseHandle.argtypes = [wintypes.HANDLE]
            if acquired: kernel.ReleaseMutex(handle)
            kernel.CloseHandle(handle)


def download_missing(config, messages, image_key=None, client_factory=WindowsClient):
    from .reader import active_pid, load_upstream
    from .resources import (load_resources, browser_resources, requirements, collect_one)
    from .archive import atomic_json
    pid = active_pid(config['pid'])
    # Verify that this exact process belongs to the already-selected account.
    identity = load_upstream().extract_master_key_from_cfg(pid)
    if not identity or identity[2] != config['account_id']:
        raise ClientReadError('指定微信进程与归档账号不一致，已停止客户端补下载')
    identity = None
    root = Path(config['data_dir'])
    inventory = load_resources(root, config)
    targets = [message for message in messages if any(r['kind'] == 'image' and r['status'] != 'ready'
                                                     for r in browser_resources(message, inventory))]
    if not targets: return {'visited': 0, 'remaining': 0}
    def pending():
        return sum(1 for message in targets if browser_resources(message, inventory)[0]['status'] != 'ready')
    def poll():
        from .storage import allocation
        try:
            with allocation(root,0):pass
        except ArchiveError as error:
            raise ClientReadError(str(error)) from None
        changed = False
        for message in targets:
            if browser_resources(message, inventory)[0]['status'] == 'ready': continue
            try:
                spec = requirements(message)[0]
                item = dict(collect_one(root, config, message, spec, image_key), status='ready', kind='image')
                inventory['messages'][message['platformMessageId']] = {'items': [item]}
                changed = True
            except ArchiveError:
                continue
        if changed: atomic_json(root / 'resources.json', inventory)
    with desktop_lease():
        client = client_factory(pid, config)
        try:
            with temporary_accessibility(client):
                image_count = sum(any(spec['kind'] == 'image' for spec in requirements(message)) for message in messages)
                return client.download_images(pending, poll, limit=min(image_count + 20, 1000))
        finally:
            client.close()
