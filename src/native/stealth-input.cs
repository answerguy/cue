using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CueStealthInput
{
    class Program
    {
        private const int WH_KEYBOARD_LL = 13;
        private const int WM_KEYDOWN = 0x0100;
        private const int WM_KEYUP = 0x0101;
        private const int WM_SYSKEYDOWN = 0x0104;
        private const int WM_SYSKEYUP = 0x0105;

        private const int VK_BACK = 0x08;
        private const int VK_TAB = 0x09;
        private const int VK_RETURN = 0x0D;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_SPACE = 0x20;
        private const int VK_PRIOR = 0x21; // Page Up
        private const int VK_NEXT = 0x22;  // Page Down
        private const int VK_END = 0x23;
        private const int VK_HOME = 0x24;
        private const int VK_LEFT = 0x25;
        private const int VK_UP = 0x26;
        private const int VK_RIGHT = 0x27;
        private const int VK_DOWN = 0x28;
        private const int VK_DELETE = 0x2E;
        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12; // Alt
        private const int VK_CAPITAL = 0x14; // Caps Lock
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;
        private const int VK_LSHIFT = 0xA0;
        private const int VK_RSHIFT = 0xA1;
        private const int VK_LCONTROL = 0xA2;
        private const int VK_RCONTROL = 0xA3;
        private const int VK_LMENU = 0xA4;
        private const int VK_RMENU = 0xA5;

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        private static LowLevelKeyboardProc _proc = HookCallback;
        private static IntPtr _hookID = IntPtr.Zero;
        private static volatile bool _capturing = false;

        private static long _lastAltCTicks = 0;
        private static long _lastAltVTicks = 0;
        private static volatile bool _transparencyMode = false;
        private static long _lastNoFocusTicks = 0;
        private static long _lastShortcutTicks = 0;
        private static readonly bool[] _swallowedKeys = new bool[256];

        private static volatile bool _leftShiftDown = false;
        private static volatile bool _rightShiftDown = false;
        private static volatile bool _shiftSwallowed = false;

        private static volatile bool _leftCtrlDown = false;
        private static volatile bool _rightCtrlDown = false;
        private static volatile bool _ctrlSwallowed = false;

        private static readonly IntPtr CUE_MAGIC = (IntPtr)0x43554531; // "CUE1"
        private static readonly object _altLock = new object();
        private static volatile bool _leftAltDown = false;
        private static volatile bool _rightAltDown = false;
        private static volatile bool _altPending = false;
        private static volatile bool _altFlushed = false;
        private static volatile bool _altSwallowed = false;
        private static uint _pendingAltVk = 0;
        private static uint _pendingAltScan = 0;
        private static uint _pendingAltFlags = 0;
        private static System.Threading.Timer _altTimer = null;
        private const int ALT_BUFFER_TIMEOUT_MS = 250;

        private static readonly object _ctrlLock = new object();
        private static volatile bool _ctrlPending = false;
        private static volatile bool _ctrlFlushed = false;
        private static uint _pendingCtrlVk = 0;
        private static uint _pendingCtrlScan = 0;
        private static uint _pendingCtrlFlags = 0;
        private static System.Threading.Timer _ctrlTimer = null;
        private const int CTRL_BUFFER_TIMEOUT_MS = 350;

        private static readonly object _shiftLock = new object();
        private static volatile bool _shiftPending = false;
        private static volatile bool _shiftFlushed = false;
        private static uint _pendingShiftVk = 0;
        private static uint _pendingShiftScan = 0;
        private static uint _pendingShiftFlags = 0;
        private static System.Threading.Timer _shiftTimer = null;
        private const int SHIFT_BUFFER_TIMEOUT_MS = 250;

        private static bool IsShiftKey(uint vk)
        {
            return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT;
        }

        private static bool IsControlKey(uint vk)
        {
            return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL;
        }

        private static bool IsMenuKey(uint vk)
        {
            return vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU;
        }

        private static bool IsModifierKey(uint vk)
        {
            return IsShiftKey(vk) || IsControlKey(vk) || IsMenuKey(vk) || vk == VK_CAPITAL || vk == VK_LWIN || vk == VK_RWIN;
        }

        private static bool IsShiftActive()
        {
            return _leftShiftDown || _rightShiftDown ||
                   (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_LSHIFT) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_RSHIFT) & 0x8000) != 0;
        }

        private static bool IsControlActive()
        {
            return _leftCtrlDown || _rightCtrlDown ||
                   (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0 ||
                   (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
        }

        private static void FlushPendingAlt()
        {
            lock (_altLock)
            {
                if (_altPending)
                {
                    _altPending = false;
                    _altFlushed = true;
                    try
                    {
                        if (_altTimer != null) _altTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingAltVk != 0 ? _pendingAltVk : VK_LMENU);
                    byte scan = (byte)_pendingAltScan;
                    uint flags = ((_pendingAltFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                }
            }
        }

        private static void FlushPendingAltTap()
        {
            lock (_altLock)
            {
                if (_altPending)
                {
                    _altPending = false;
                    _altFlushed = false;
                    try
                    {
                        if (_altTimer != null) _altTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingAltVk != 0 ? _pendingAltVk : VK_LMENU);
                    byte scan = (byte)_pendingAltScan;
                    uint flags = ((_pendingAltFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                    keybd_event(vk, scan, flags | 2, CUE_MAGIC); // KEYEVENTF_KEYUP = 2
                }
            }
        }

        private static void FlushPendingCtrl()
        {
            lock (_ctrlLock)
            {
                if (_ctrlPending)
                {
                    _ctrlPending = false;
                    _ctrlFlushed = true;
                    try
                    {
                        if (_ctrlTimer != null) _ctrlTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingCtrlVk != 0 ? _pendingCtrlVk : VK_LCONTROL);
                    byte scan = (byte)_pendingCtrlScan;
                    uint flags = ((_pendingCtrlFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                }
            }
        }

        private static void FlushPendingCtrlTap()
        {
            lock (_ctrlLock)
            {
                if (_ctrlPending)
                {
                    _ctrlPending = false;
                    _ctrlFlushed = false;
                    try
                    {
                        if (_ctrlTimer != null) _ctrlTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingCtrlVk != 0 ? _pendingCtrlVk : VK_LCONTROL);
                    byte scan = (byte)_pendingCtrlScan;
                    uint flags = ((_pendingCtrlFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                    keybd_event(vk, scan, flags | 2, CUE_MAGIC); // KEYEVENTF_KEYUP = 2
                }
            }
        }

        private static void FlushPendingShift()
        {
            lock (_shiftLock)
            {
                if (_shiftPending)
                {
                    _shiftPending = false;
                    _shiftFlushed = true;
                    try
                    {
                        if (_shiftTimer != null) _shiftTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingShiftVk != 0 ? _pendingShiftVk : VK_LSHIFT);
                    byte scan = (byte)_pendingShiftScan;
                    uint flags = ((_pendingShiftFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                }
            }
        }

        private static void FlushPendingShiftTap()
        {
            lock (_shiftLock)
            {
                if (_shiftPending)
                {
                    _shiftPending = false;
                    _shiftFlushed = false;
                    try
                    {
                        if (_shiftTimer != null) _shiftTimer.Change(Timeout.Infinite, Timeout.Infinite);
                    }
                    catch { }

                    byte vk = (byte)(_pendingShiftVk != 0 ? _pendingShiftVk : VK_LSHIFT);
                    byte scan = (byte)_pendingShiftScan;
                    uint flags = ((_pendingShiftFlags & 1) != 0) ? 1u : 0u;
                    keybd_event(vk, scan, flags, CUE_MAGIC);
                    keybd_event(vk, scan, flags | 2, CUE_MAGIC); // KEYEVENTF_KEYUP = 2
                }
            }
        }

        private static void ReleaseAllModifiers()
        {
            try
            {
                keybd_event((byte)VK_LMENU, 0x38, 2, CUE_MAGIC);
                keybd_event((byte)VK_RMENU, 0x38, 2 | 1, CUE_MAGIC);
                keybd_event((byte)VK_MENU, 0x38, 2, CUE_MAGIC);
                keybd_event((byte)VK_LCONTROL, 0x1D, 2, CUE_MAGIC);
                keybd_event((byte)VK_RCONTROL, 0x1D, 2 | 1, CUE_MAGIC);
                keybd_event((byte)VK_CONTROL, 0x1D, 2, CUE_MAGIC);
                keybd_event((byte)VK_LSHIFT, 0x2A, 2, CUE_MAGIC);
                keybd_event((byte)VK_RSHIFT, 0x36, 2, CUE_MAGIC);
                keybd_event((byte)VK_SHIFT, 0x2A, 2, CUE_MAGIC);
            }
            catch { }
        }

        private static void CleanUp()
        {
            try
            {
                if (_altTimer != null) { try { _altTimer.Dispose(); } catch { } }
                if (_ctrlTimer != null) { try { _ctrlTimer.Dispose(); } catch { } }
                if (_shiftTimer != null) { try { _shiftTimer.Dispose(); } catch { } }

                if (_hookID != IntPtr.Zero)
                {
                    UnhookWindowsHookEx(_hookID);
                    _hookID = IntPtr.Zero;
                }
                ReleaseAllModifiers();
            }
            catch { }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct KBDLLHOOKSTRUCT
        {
            public uint vkCode;
            public uint scanCode;
            public uint flags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public IntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool UnhookWindowsHookEx(IntPtr hhk);

        [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern IntPtr GetModuleHandle(string lpModuleName);

        [DllImport("user32.dll")]
        private static extern sbyte GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage([In] ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int vKey);

        [DllImport("user32.dll")]
        private static extern short GetKeyState(int vKey);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int ToUnicode(
            uint wVirtKey,
            uint wScanCode,
            byte[] lpKeyState,
            [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pwszBuff,
            int cchBuff,
            uint wFlags);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [DllImport("user32.dll")]
        private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            if (args.Length > 0 && args[0] == "--test")
            {
                byte[] keyState = new byte[256];
                keyState[VK_SHIFT] = 0x80;
                keyState[VK_LSHIFT] = 0x80;
                StringBuilder sb = new StringBuilder(16);
                int rc = ToUnicode(0x31, 0x02, keyState, sb, sb.Capacity, 0); // '1' shifted = '!'
                Console.WriteLine("{\"test\":true,\"char\":\"" + sb.ToString() + "\"}");
                return;
            }

            _altTimer = new System.Threading.Timer((state) =>
            {
                FlushPendingAlt();
            }, null, Timeout.Infinite, Timeout.Infinite);

            _ctrlTimer = new System.Threading.Timer((state) =>
            {
                FlushPendingCtrl();
            }, null, Timeout.Infinite, Timeout.Infinite);

            _shiftTimer = new System.Threading.Timer((state) =>
            {
                FlushPendingShift();
            }, null, Timeout.Infinite, Timeout.Infinite);

            AppDomain.CurrentDomain.ProcessExit += (s, e) => { CleanUp(); };

            // Thread for reading commands from stdin
            Thread stdinThread = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.ReadLine()) != null)
                    {
                        line = line.Trim();
                        if (line.Equals("START", StringComparison.OrdinalIgnoreCase))
                        {
                            _capturing = true;
                            _ctrlSwallowed = false;
                            _shiftSwallowed = false;
                            _ctrlPending = false;
                            _shiftPending = false;
                            _leftCtrlDown = (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0;
                            _rightCtrlDown = (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
                            _leftShiftDown = (GetAsyncKeyState(VK_LSHIFT) & 0x8000) != 0;
                            _rightShiftDown = (GetAsyncKeyState(VK_RSHIFT) & 0x8000) != 0;
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":true}");
                            Console.Out.Flush();
                        }
                        else if (line.Equals("STOP", StringComparison.OrdinalIgnoreCase))
                        {
                            _capturing = false;
                            _ctrlSwallowed = false;
                            _shiftSwallowed = false;
                            _ctrlPending = false;
                            _shiftPending = false;
                            _leftCtrlDown = false;
                            _rightCtrlDown = false;
                            _leftShiftDown = false;
                            _rightShiftDown = false;
                            _altSwallowed = false;
                            _altPending = false;
                            _leftAltDown = false;
                            _rightAltDown = false;
                            ReleaseAllModifiers();
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":false}");
                            Console.Out.Flush();
                        }
                        else if (line.StartsWith("SET_TRANSPARENCY", StringComparison.OrdinalIgnoreCase))
                        {
                            string[] parts = line.Split(' ');
                            bool enable = parts.Length > 1 && parts[1].Equals("true", StringComparison.OrdinalIgnoreCase);
                            _transparencyMode = enable;
                            if (!_transparencyMode)
                            {
                                _altSwallowed = false;
                                _altPending = false;
                                _leftAltDown = false;
                                _rightAltDown = false;
                                ReleaseAllModifiers();
                            }
                            Console.WriteLine("{\"event\":\"transparency_state\",\"enabled\":" + (_transparencyMode ? "true" : "false") + "}");
                            Console.Out.Flush();
                        }
                        else if (line.Equals("QUIT", StringComparison.OrdinalIgnoreCase) ||
                                 line.Equals("EXIT", StringComparison.OrdinalIgnoreCase))
                        {
                            CleanUp();
                            Environment.Exit(0);
                        }
                    }
                    CleanUp();
                    Environment.Exit(0);
                }
                catch
                {
                    CleanUp();
                    Environment.Exit(0);
                }
            });
            stdinThread.IsBackground = true;
            stdinThread.Start();

            _hookID = SetHook(_proc);
            Console.WriteLine("{\"event\":\"ready\"}");
            Console.Out.Flush();

            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            UnhookWindowsHookEx(_hookID);
        }

        private static IntPtr SetHook(LowLevelKeyboardProc proc)
        {
            using (Process curProcess = Process.GetCurrentProcess())
            using (ProcessModule curModule = curProcess.MainModule)
            {
                return SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(curModule.ModuleName), 0);
            }
        }

        private const uint LLKHF_ALTDOWN = 0x20;

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                KBDLLHOOKSTRUCT hookStruct = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));

                // Recursion guard: synthetic keys injected by CUE bypass all interception
                if ((hookStruct.flags & 0x10) != 0 || hookStruct.dwExtraInfo == CUE_MAGIC)
                {
                    return CallNextHookEx(_hookID, nCode, wParam, lParam);
                }

                int msg = wParam.ToInt32();
                bool isKeyDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
                bool isKeyUp = (msg == WM_KEYUP || msg == WM_SYSKEYUP);

                if (isKeyDown || isKeyUp)
                {
                    uint vk = hookStruct.vkCode;

                    // Update modifier state tracking
                    if (vk == VK_LSHIFT) _leftShiftDown = isKeyDown;
                    else if (vk == VK_RSHIFT) _rightShiftDown = isKeyDown;
                    else if (vk == VK_SHIFT)
                    {
                        if (isKeyDown) { _leftShiftDown = true; }
                        else { _leftShiftDown = false; _rightShiftDown = false; }
                    }

                    if (vk == VK_LCONTROL) _leftCtrlDown = isKeyDown;
                    else if (vk == VK_RCONTROL) _rightCtrlDown = isKeyDown;
                    else if (vk == VK_CONTROL)
                    {
                        if (isKeyDown) { _leftCtrlDown = true; }
                        else { _leftCtrlDown = false; _rightCtrlDown = false; }
                    }

                    if (vk == VK_LMENU) _leftAltDown = isKeyDown;
                    else if (vk == VK_RMENU) _rightAltDown = isKeyDown;
                    else if (vk == VK_MENU)
                    {
                        if (isKeyDown) { _leftAltDown = true; }
                        else { _leftAltDown = false; _rightAltDown = false; }
                    }

                    bool ctrl = IsControlActive();
                    bool alt = _leftAltDown || _rightAltDown ||
                               ((hookStruct.flags & LLKHF_ALTDOWN) != 0 && (GetAsyncKeyState(VK_MENU) & 0x8000) != 0);
                    bool win = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                    bool shift = IsShiftActive();

                    bool isMenu = IsMenuKey(vk);
                    bool isC = (vk == 0x43 || vk == 0x63); // 'C' key
                    bool isV = (vk == 0x56 || vk == 0x76); // 'V' key

                    // A. In focus/stealth mode (_capturing == true), consume Shift and Ctrl keypresses completely!
                    if (_capturing && IsShiftKey(vk))
                    {
                        if (isKeyDown)
                        {
                            _shiftSwallowed = true;
                        }
                        else if (isKeyUp)
                        {
                            if (!_leftShiftDown && !_rightShiftDown)
                            {
                                _shiftSwallowed = false;
                                _shiftPending = false;
                            }
                        }
                        return (IntPtr)1; // Consume / Swallow Shift down and up!
                    }
                    if (_capturing && IsControlKey(vk))
                    {
                        if (isKeyDown)
                        {
                            _ctrlSwallowed = true;
                        }
                        else if (isKeyUp)
                        {
                            if (!_leftCtrlDown && !_rightCtrlDown)
                            {
                                _ctrlSwallowed = false;
                                _ctrlPending = false;
                            }
                        }
                        return (IntPtr)1; // Consume / Swallow Ctrl down and up!
                    }

                    // B. Modifier keyups: handle pending taps and cleanly swallow consumed releases
                    if (isKeyUp && IsShiftKey(vk))
                    {
                        if (!_leftShiftDown && !_rightShiftDown)
                        {
                            lock (_shiftLock)
                            {
                                if (_shiftPending)
                                {
                                    FlushPendingShiftTap();
                                    return (IntPtr)1;
                                }
                                if (_shiftSwallowed)
                                {
                                    _shiftSwallowed = false;
                                    return (IntPtr)1;
                                }
                                if (_shiftFlushed)
                                {
                                    _shiftFlushed = false;
                                    return CallNextHookEx(_hookID, nCode, wParam, lParam);
                                }
                            }
                        }
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }
                    if (isKeyUp && IsControlKey(vk))
                    {
                        if (!_leftCtrlDown && !_rightCtrlDown)
                        {
                            lock (_ctrlLock)
                            {
                                if (_ctrlPending)
                                {
                                    FlushPendingCtrlTap();
                                    return (IntPtr)1;
                                }
                                if (_ctrlSwallowed)
                                {
                                    _ctrlSwallowed = false;
                                    return (IntPtr)1;
                                }
                                if (_ctrlFlushed)
                                {
                                    _ctrlFlushed = false;
                                    return CallNextHookEx(_hookID, nCode, wParam, lParam);
                                }
                            }
                        }
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }

                    // 1. Buffer Alt keydown when pressed alone (without Ctrl or Win)
                    if (isKeyDown && isMenu && !ctrl && !win)
                    {
                        lock (_altLock)
                        {
                            if (_altSwallowed)
                            {
                                // Alt was consumed as part of Alt+C or Alt+V: keep swallowed on all auto-repeats!
                                return (IntPtr)1;
                            }
                            if (!_altPending)
                            {
                                _altPending = true;
                                _altFlushed = false;
                                _pendingAltVk = vk;
                                _pendingAltScan = hookStruct.scanCode;
                                _pendingAltFlags = hookStruct.flags;
                                if (_altTimer != null)
                                {
                                    _altTimer.Change(ALT_BUFFER_TIMEOUT_MS, Timeout.Infinite);
                                }
                                return (IntPtr)1; // Swallow initial Alt down into buffer!
                            }
                            else
                            {
                                // Repeated Alt down while already pending: keep swallowed
                                return (IntPtr)1;
                            }
                        }
                    }

                    // 2. Alt keyup handling
                    if (isKeyUp && isMenu)
                    {
                        if (!_leftAltDown && !_rightAltDown)
                        {
                            lock (_altLock)
                            {
                                if (_altPending)
                                {
                                    // User released Alt alone before timeout: flush down + up tap
                                    FlushPendingAltTap();
                                    return (IntPtr)1;
                                }
                                if (_altSwallowed)
                                {
                                    // Alt was consumed as part of Alt+C or Alt+V: swallow Alt up completely!
                                    _altSwallowed = false;
                                    if (_altFlushed)
                                    {
                                        _altFlushed = false;
                                        byte avk = (byte)(_pendingAltVk != 0 ? _pendingAltVk : VK_LMENU);
                                        byte ascan = (byte)_pendingAltScan;
                                        uint aflags = ((_pendingAltFlags & 1) != 0) ? 1u : 0u;
                                        keybd_event(avk, ascan, aflags | 2, CUE_MAGIC);
                                    }
                                    ReleaseAllModifiers();
                                    return (IntPtr)1;
                                }
                                if (_altFlushed)
                                {
                                    _altFlushed = false;
                                    return CallNextHookEx(_hookID, nCode, wParam, lParam);
                                }
                            }
                        }
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }

                    // 3. 'C' key pressed while Alt is pending or Alt is held (Alt+C toggle)
                    if (isC && (alt || _altPending) && !ctrl && !win)
                    {
                        if (isKeyDown)
                        {
                            lock (_altLock)
                            {
                                if (_altPending)
                                {
                                    _altPending = false;
                                    if (_altTimer != null) _altTimer.Change(Timeout.Infinite, Timeout.Infinite);
                                }
                                if (_altFlushed)
                                {
                                    _altFlushed = false;
                                    byte avk = (byte)(_pendingAltVk != 0 ? _pendingAltVk : VK_LMENU);
                                    byte ascan = (byte)_pendingAltScan;
                                    uint aflags = ((_pendingAltFlags & 1) != 0) ? 1u : 0u;
                                    keybd_event(avk, ascan, aflags | 2, CUE_MAGIC);
                                }
                                _altSwallowed = true; // Mark Alt completely swallowed!
                            }

                            // Auto-repeat check: ignore repeating keydown while key is held down
                            if (vk < 256 && _swallowedKeys[vk])
                            {
                                return (IntPtr)1;
                            }
                            if (vk < 256) _swallowedKeys[vk] = true;

                            long nowTicks = DateTime.UtcNow.Ticks;
                            if (nowTicks - _lastAltCTicks > TimeSpan.FromMilliseconds(150).Ticks)
                            {
                                _lastAltCTicks = nowTicks;
                                _capturing = !_capturing;
                                if (!_capturing)
                                {
                                    _leftShiftDown = false;
                                    _rightShiftDown = false;
                                    _leftCtrlDown = false;
                                    _rightCtrlDown = false;
                                    _ctrlSwallowed = false;
                                    _shiftSwallowed = false;
                                    _ctrlPending = false;
                                    _shiftPending = false;
                                    _altSwallowed = false;
                                    _altPending = false;
                                    _leftAltDown = false;
                                    _rightAltDown = false;
                                    ReleaseAllModifiers();
                                }
                                Console.WriteLine("{\"event\":\"toggle\",\"capturing\":" + (_capturing ? "true" : "false") + "}");
                                Console.WriteLine("{\"event\":\"state\",\"capturing\":" + (_capturing ? "true" : "false") + "}");
                                Console.Out.Flush();
                            }
                        }
                        else if (isKeyUp)
                        {
                            if (vk < 256) _swallowedKeys[vk] = false;
                        }
                        return (IntPtr)1; // Swallow 'C' down and up completely!
                    }

                    // 3b. 'V' key pressed while Alt is pending or Alt is held (Alt+V transparency toggle)
                    if (isV && (alt || _altPending) && !ctrl && !win)
                    {
                        if (isKeyDown)
                        {
                            lock (_altLock)
                            {
                                if (_altPending)
                                {
                                    _altPending = false;
                                    if (_altTimer != null) _altTimer.Change(Timeout.Infinite, Timeout.Infinite);
                                }
                                if (_altFlushed)
                                {
                                    _altFlushed = false;
                                    byte avk = (byte)(_pendingAltVk != 0 ? _pendingAltVk : VK_LMENU);
                                    byte ascan = (byte)_pendingAltScan;
                                    uint aflags = ((_pendingAltFlags & 1) != 0) ? 1u : 0u;
                                    keybd_event(avk, ascan, aflags | 2, CUE_MAGIC);
                                }
                                _altSwallowed = true; // Mark Alt completely swallowed!
                            }

                            // Auto-repeat check: ignore repeating keydown while key is held down
                            if (vk < 256 && _swallowedKeys[vk])
                            {
                                return (IntPtr)1;
                            }
                            if (vk < 256) _swallowedKeys[vk] = true;

                            long nowTicks = DateTime.UtcNow.Ticks;
                            if (nowTicks - _lastAltVTicks > TimeSpan.FromMilliseconds(150).Ticks)
                            {
                                _lastAltVTicks = nowTicks;
                                _transparencyMode = !_transparencyMode;
                                if (!_transparencyMode)
                                {
                                    ReleaseAllModifiers();
                                }
                                Console.WriteLine("{\"event\":\"transparency_toggle\",\"enabled\":" + (_transparencyMode ? "true" : "false") + "}");
                                Console.WriteLine("{\"event\":\"transparency_state\",\"enabled\":" + (_transparencyMode ? "true" : "false") + "}");
                                Console.Out.Flush();
                            }
                        }
                        else if (isKeyUp)
                        {
                            if (vk < 256) _swallowedKeys[vk] = false;
                        }
                        return (IntPtr)1; // Swallow 'V' down and up completely!
                    }

                    // 4. Any other key arrived while Alt is pending: flush buffered Alt down immediately!
                    if (_altPending && !isMenu)
                    {
                        if (!_capturing && !_transparencyMode)
                        {
                            FlushPendingAlt();
                        }
                        else
                        {
                            lock (_altLock)
                            {
                                _altPending = false;
                                if (_altTimer != null) { try { _altTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                _altSwallowed = true;
                            }
                        }
                    }

                    // 5. Buffer Ctrl keydown when pressed alone (without Alt or Win)
                    if (isKeyDown && IsControlKey(vk) && !alt && !win)
                    {
                        lock (_ctrlLock)
                        {
                            if (_ctrlSwallowed)
                            {
                                return (IntPtr)1;
                            }
                            if (!_ctrlPending)
                            {
                                _ctrlPending = true;
                                _ctrlFlushed = false;
                                _pendingCtrlVk = vk;
                                _pendingCtrlScan = hookStruct.scanCode;
                                _pendingCtrlFlags = hookStruct.flags;
                                if (_ctrlTimer != null) _ctrlTimer.Change(CTRL_BUFFER_TIMEOUT_MS, Timeout.Infinite);
                                return (IntPtr)1; // Swallow initial Ctrl down into buffer!
                            }
                            else
                            {
                                return (IntPtr)1;
                            }
                        }
                    }

                    // 6. Buffer Shift keydown when Ctrl is pending/swallowed, or pressed alone
                    if (isKeyDown && IsShiftKey(vk) && !alt && !win)
                    {
                        lock (_shiftLock)
                        {
                            if (_shiftSwallowed)
                            {
                                return (IntPtr)1;
                            }
                            if (!_shiftPending)
                            {
                                _shiftPending = true;
                                _shiftFlushed = false;
                                _pendingShiftVk = vk;
                                _pendingShiftScan = hookStruct.scanCode;
                                _pendingShiftFlags = hookStruct.flags;
                                if (_shiftTimer != null) _shiftTimer.Change(SHIFT_BUFFER_TIMEOUT_MS, Timeout.Infinite);
                                return (IntPtr)1; // Swallow Shift down into buffer!
                            }
                            else
                            {
                                return (IntPtr)1;
                            }
                        }
                    }

                    // 7. Global shortcuts: Ctrl+Return (say), Ctrl+Shift+Return (assist), Ctrl+H (leetcode), Ctrl+Shift+F (nofocus)
                    // These keybinds must NEVER leak while cue is running, whether in focus mode or not.
                    bool isCtrlEffective = (ctrl || _ctrlPending) && IsControlActive();
                    bool isShiftEffective = (shift || _shiftPending) && IsShiftActive();

                    if (isCtrlEffective && !alt && !win)
                    {
                        string shortcutAction = null;
                        if (vk == VK_RETURN)
                        {
                            shortcutAction = isShiftEffective ? "assist" : "say";
                        }
                        else if (!isShiftEffective && (vk == 0x48 || vk == 0x68)) // 'H' key
                        {
                            shortcutAction = "leetcode";
                        }
                        else if (isShiftEffective && (vk == 0x46 || vk == 0x66)) // 'F' key
                        {
                            shortcutAction = "nofocus_toggle";
                        }

                        if (shortcutAction != null)
                        {
                            lock (_ctrlLock)
                            {
                                if (_ctrlPending)
                                {
                                    _ctrlPending = false;
                                    if (_ctrlTimer != null) { try { _ctrlTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                }
                                _ctrlSwallowed = true;
                                if (_ctrlFlushed)
                                {
                                    _ctrlFlushed = false;
                                    byte cvk = (byte)(_pendingCtrlVk != 0 ? _pendingCtrlVk : VK_LCONTROL);
                                    byte cscan = (byte)_pendingCtrlScan;
                                    uint cflags = ((_pendingCtrlFlags & 1) != 0) ? 1u : 0u;
                                    keybd_event(cvk, cscan, cflags | 2, CUE_MAGIC); // Release flushed Ctrl before shortcut!
                                }
                            }

                            lock (_shiftLock)
                            {
                                if (_shiftPending)
                                {
                                    _shiftPending = false;
                                    if (_shiftTimer != null) { try { _shiftTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                }
                                if (isShiftEffective)
                                {
                                    _shiftSwallowed = true;
                                    if (_shiftFlushed)
                                    {
                                        _shiftFlushed = false;
                                        byte svk = (byte)(_pendingShiftVk != 0 ? _pendingShiftVk : VK_LSHIFT);
                                        byte sscan = (byte)_pendingShiftScan;
                                        uint sflags = ((_pendingShiftFlags & 1) != 0) ? 1u : 0u;
                                        keybd_event(svk, sscan, sflags | 2, CUE_MAGIC); // Release flushed Shift before shortcut!
                                    }
                                }
                            }

                            if (isKeyDown)
                            {
                                long nowTicks = DateTime.UtcNow.Ticks;
                                if (nowTicks - _lastShortcutTicks > TimeSpan.FromMilliseconds(300).Ticks)
                                {
                                    _lastShortcutTicks = nowTicks;
                                    if (_capturing)
                                    {
                                        _capturing = false;
                                        Console.WriteLine("{\"event\":\"state\",\"capturing\":false}");
                                    }
                                    if (shortcutAction == "nofocus_toggle")
                                    {
                                        Console.WriteLine("{\"event\":\"nofocus_toggle\"}");
                                    }
                                    else
                                    {
                                        Console.WriteLine("{\"event\":\"shortcut\",\"action\":\"" + shortcutAction + "\"}");
                                    }
                                    Console.Out.Flush();
                                }
                                if (vk < 256) _swallowedKeys[vk] = true;
                            }
                            else if (isKeyUp)
                            {
                                if (vk < 256) _swallowedKeys[vk] = false;
                            }
                            return (IntPtr)1; // Completely swallow and mask the shortcut!
                        }
                    }

                    // Flush pending modifiers on any other non-modifier key
                    if (!IsControlKey(vk) && !IsShiftKey(vk) && !IsMenuKey(vk))
                    {
                        if (!_capturing)
                        {
                            if (_ctrlPending) FlushPendingCtrl();
                            if (_shiftPending) FlushPendingShift();
                        }
                        else
                        {
                            if (_ctrlPending)
                            {
                                lock (_ctrlLock)
                                {
                                    _ctrlPending = false;
                                    if (_ctrlTimer != null) { try { _ctrlTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                    _ctrlSwallowed = true;
                                }
                            }
                            if (_shiftPending)
                            {
                                lock (_shiftLock)
                                {
                                    _shiftPending = false;
                                    if (_shiftTimer != null) { try { _shiftTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                    _shiftSwallowed = true;
                                }
                            }
                        }
                    }

                    // If this key was swallowed on keydown, swallow its keyup as well
                    if (isKeyUp && vk < 256 && _swallowedKeys[vk])
                    {
                        _swallowedKeys[vk] = false;
                        return (IntPtr)1;
                    }

                    // STRICT ARROW KEY & PAGE KEY RESERVATION:
                    // Up and Down arrow keys (as well as Page Up/Down) are strictly reserved for Cue
                    // whenever Cue is running in either stealth typing mode or transparency mode.
                    if (_capturing || _transparencyMode)
                    {
                        if (vk == VK_UP || vk == VK_DOWN || vk == VK_PRIOR || vk == VK_NEXT)
                        {
                            if (isKeyDown)
                            {
                                string evt = null;
                                if (vk == VK_UP) evt = "arrow_up";
                                else if (vk == VK_DOWN) evt = "arrow_down";
                                else if (vk == VK_PRIOR) evt = "page_up";
                                else if (vk == VK_NEXT) evt = "page_down";

                                if (evt != null)
                                {
                                    Console.WriteLine("{\"event\":\"" + evt + "\"}");
                                    Console.Out.Flush();
                                }
                            }
                            return (IntPtr)1; // Strictly swallow both keydown and keyup! Never escape!
                        }
                    }

                    // 8. While capturing stealth input, process and swallow keystrokes
                    if (_capturing)
                    {
                        // Pass through OS shortcuts like Alt+Tab, Alt+F4, Alt+Esc, Win+...
                        if (win || (alt && !ctrl && (vk == VK_TAB || vk == 0x73 /* F4 */ || vk == VK_ESCAPE)))
                        {
                            return CallNextHookEx(_hookID, nCode, wParam, lParam);
                        }

                        // Pass through pure modifier keys alone (Caps, Win) so keyboard state works
                        // Note: Shift and Ctrl are consumed above, Alt is controlled by Alt state machine above!
                        if (vk == VK_CAPITAL || vk == VK_LWIN || vk == VK_RWIN)
                        {
                            return CallNextHookEx(_hookID, nCode, wParam, lParam);
                        }

                        // On keyup during capture, swallow non-modifier keys so nothing leaks
                        if (isKeyUp)
                        {
                            if (vk < 256) _swallowedKeys[vk] = false;
                            return (IntPtr)1;
                        }

                        // All subsequent handling is for keydown while capturing
                        if (vk < 256) _swallowedKeys[vk] = true;

                        // Handle Escape: cancel/stop capture
                        if (vk == VK_ESCAPE)
                        {
                            _capturing = false;
                            _ctrlSwallowed = false;
                            _shiftSwallowed = false;
                            _ctrlPending = false;
                            _shiftPending = false;
                            _leftCtrlDown = false;
                            _rightCtrlDown = false;
                            _leftShiftDown = false;
                            _rightShiftDown = false;
                            _altSwallowed = false;
                            _altPending = false;
                            _leftAltDown = false;
                            _rightAltDown = false;
                            ReleaseAllModifiers();
                            Console.WriteLine("{\"event\":\"escape\"}");
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":false}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Escape
                        }

                        // Handle Enter: submit query (or newline if Shift+Enter)
                        if (vk == VK_RETURN)
                        {
                            if (shift)
                            {
                                Console.WriteLine("{\"event\":\"char\",\"char\":\"\\n\"}");
                                Console.Out.Flush();
                                return (IntPtr)1;
                            }
                            _capturing = false;
                            _ctrlSwallowed = false;
                            _shiftSwallowed = false;
                            _ctrlPending = false;
                            _shiftPending = false;
                            _leftCtrlDown = false;
                            _rightCtrlDown = false;
                            _leftShiftDown = false;
                            _rightShiftDown = false;
                            _altSwallowed = false;
                            _altPending = false;
                            _leftAltDown = false;
                            _rightAltDown = false;
                            ReleaseAllModifiers();
                            Console.WriteLine("{\"event\":\"enter\"}");
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":false}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Enter
                        }

                        // Handle Backspace: remove character before caret
                        if (vk == VK_BACK)
                        {
                            Console.WriteLine("{\"event\":\"backspace\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Backspace
                        }

                        // Handle Delete: delete character after caret
                        if (vk == VK_DELETE)
                        {
                            Console.WriteLine("{\"event\":\"delete\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Delete
                        }

                        // Handle Left/Right arrow, Home, End for caret navigation
                        if (vk == VK_LEFT)
                        {
                            Console.WriteLine("{\"event\":\"arrow_left\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Left
                        }
                        if (vk == VK_RIGHT)
                        {
                            Console.WriteLine("{\"event\":\"arrow_right\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Right
                        }
                        if (vk == VK_HOME)
                        {
                            Console.WriteLine("{\"event\":\"home\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Home
                        }
                        if (vk == VK_END)
                        {
                            Console.WriteLine("{\"event\":\"end\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow End
                        }

                        // For Ctrl shortcuts (like Ctrl+A, Ctrl+V, etc.)
                        bool isCtrlActive = IsControlActive();
                        if (isCtrlActive)
                        {
                            lock (_ctrlLock)
                            {
                                if (_ctrlPending)
                                {
                                    _ctrlPending = false;
                                    if (_ctrlTimer != null) { try { _ctrlTimer.Change(Timeout.Infinite, Timeout.Infinite); } catch { } }
                                }
                                _ctrlSwallowed = true;
                            }

                            if (vk == 0x56) // Ctrl+V paste
                            {
                                Console.WriteLine("{\"event\":\"paste\"}");
                                Console.Out.Flush();
                                return (IntPtr)1;
                            }
                            if (vk == 0x41) // Ctrl+A select all
                            {
                                Console.WriteLine("{\"event\":\"select_all\"}");
                                Console.Out.Flush();
                                return (IntPtr)1;
                            }
                            // Swallow other Ctrl combinations during capture so nothing leaks to background app
                            return (IntPtr)1;
                        }

                        // Translate to Unicode character
                        byte[] keyState = new byte[256];
                        bool isShift = IsShiftActive();
                        bool isCaps = (GetKeyState(VK_CAPITAL) & 0x0001) != 0;

                        if (isShift)
                        {
                            keyState[VK_SHIFT] = 0x80;
                            keyState[VK_LSHIFT] = 0x80;
                            keyState[VK_RSHIFT] = 0x80;
                        }
                        if (isCaps) keyState[VK_CAPITAL] = 0x01;

                        uint scanCode = hookStruct.scanCode;
                        if (scanCode == 0) scanCode = MapVirtualKey(vk, 0);

                        StringBuilder sb = new StringBuilder(16);
                        // Use 0x04 flag on Windows 10/11 to avoid altering dead key buffer
                        int rc = ToUnicode(vk, scanCode, keyState, sb, sb.Capacity, 0x04);
                        if (rc <= 0)
                        {
                            rc = ToUnicode(vk, scanCode, keyState, sb, sb.Capacity, 0);
                        }

                        if (rc > 0)
                        {
                            string str = sb.ToString();
                            string jsonChar = EscapeJson(str);
                            Console.WriteLine("{\"event\":\"char\",\"char\":\"" + jsonChar + "\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow character key
                        }

                        // Swallow any other key while capturing to prevent leaking to background app
                        return (IntPtr)1;
                    }

                    // 9. When in transparency mode and typing mode is off:
                    // Arrow keys and page keys scroll through the returned answer (strictly swallowed above).
                    // Escape exits transparency mode.
                    // All other keys pass through cleanly to the foreground application.
                    if (_transparencyMode)
                    {
                        if (vk == VK_ESCAPE)
                        {
                            if (isKeyDown)
                            {
                                _transparencyMode = false;
                                ReleaseAllModifiers();
                                Console.WriteLine("{\"event\":\"transparency_state\",\"enabled\":false}");
                                Console.Out.Flush();
                            }
                            return (IntPtr)1; // swallow Escape
                        }
                    }
                }
            }

            return CallNextHookEx(_hookID, nCode, wParam, lParam);
        }

        private static string EscapeJson(string s)
        {
            StringBuilder sb = new StringBuilder();
            foreach (char c in s)
            {
                if (c == '\\') sb.Append("\\\\");
                else if (c == '"') sb.Append("\\\"");
                else if (c == '\b') sb.Append("\\b");
                else if (c == '\f') sb.Append("\\f");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
