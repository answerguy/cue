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
        private static long _lastNoFocusTicks = 0;
        private static readonly bool[] _swallowedKeys = new bool[256];

        private static volatile bool _leftShiftDown = false;
        private static volatile bool _rightShiftDown = false;

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
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":true}");
                            Console.Out.Flush();
                        }
                        else if (line.Equals("STOP", StringComparison.OrdinalIgnoreCase))
                        {
                            _capturing = false;
                            Console.WriteLine("{\"event\":\"state\",\"capturing\":false}");
                            Console.Out.Flush();
                        }
                        else if (line.Equals("QUIT", StringComparison.OrdinalIgnoreCase) ||
                                 line.Equals("EXIT", StringComparison.OrdinalIgnoreCase))
                        {
                            Environment.Exit(0);
                        }
                    }
                }
                catch
                {
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
                int msg = wParam.ToInt32();
                bool isKeyDown = (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN);
                bool isKeyUp = (msg == WM_KEYUP || msg == WM_SYSKEYUP);

                if (isKeyDown || isKeyUp)
                {
                    KBDLLHOOKSTRUCT hookStruct = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    uint vk = hookStruct.vkCode;

                    // Update shift state tracking on any Shift key event
                    if (vk == VK_LSHIFT) _leftShiftDown = isKeyDown;
                    else if (vk == VK_RSHIFT) _rightShiftDown = isKeyDown;
                    else if (vk == VK_SHIFT)
                    {
                        if (isKeyDown) { _leftShiftDown = true; }
                        else { _leftShiftDown = false; _rightShiftDown = false; }
                    }

                    bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 ||
                                (GetAsyncKeyState(VK_LCONTROL) & 0x8000) != 0 ||
                                (GetAsyncKeyState(VK_RCONTROL) & 0x8000) != 0;
                    bool alt = (hookStruct.flags & LLKHF_ALTDOWN) != 0 ||
                               (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 ||
                               (GetAsyncKeyState(VK_LMENU) & 0x8000) != 0 ||
                               (GetAsyncKeyState(VK_RMENU) & 0x8000) != 0 ||
                               msg == WM_SYSKEYDOWN || msg == WM_SYSKEYUP;
                    bool win = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
                    bool shift = IsShiftActive();

                    // 1. Alt+C keybind: Toggle stealth typing ON/OFF
                    // Must be swallowed completely on BOTH keydown and keyup so foreground apps never see it
                    if (alt && !ctrl && !win && (vk == 0x43 || vk == 0x63)) // 'C' key
                    {
                        if (isKeyDown)
                        {
                            long nowTicks = DateTime.UtcNow.Ticks;
                            if (nowTicks - _lastAltCTicks > TimeSpan.FromMilliseconds(250).Ticks)
                            {
                                _lastAltCTicks = nowTicks;
                                _capturing = !_capturing;
                                if (!_capturing)
                                {
                                    _leftShiftDown = false;
                                    _rightShiftDown = false;
                                }
                                Console.WriteLine("{\"event\":\"toggle\",\"capturing\":" + (_capturing ? "true" : "false") + "}");
                                Console.Out.Flush();
                            }
                            if (vk < 256) _swallowedKeys[vk] = true;
                        }
                        else if (isKeyUp)
                        {
                            if (vk < 256) _swallowedKeys[vk] = false;
                        }
                        return (IntPtr)1; // Consume / Swallow Alt+C completely!
                    }

                    // 2. Ctrl+Shift+F keybind: Toggle No-Focus mode
                    if (ctrl && shift && !alt && !win && (vk == 0x46 || vk == 0x66)) // 'F' key
                    {
                        if (isKeyDown)
                        {
                            long nowTicks = DateTime.UtcNow.Ticks;
                            if (nowTicks - _lastNoFocusTicks > TimeSpan.FromMilliseconds(250).Ticks)
                            {
                                _lastNoFocusTicks = nowTicks;
                                Console.WriteLine("{\"event\":\"nofocus_toggle\"}");
                                Console.Out.Flush();
                            }
                            if (vk < 256) _swallowedKeys[vk] = true;
                        }
                        else if (isKeyUp)
                        {
                            if (vk < 256) _swallowedKeys[vk] = false;
                        }
                        return (IntPtr)1; // Consume / Swallow Ctrl+Shift+F completely!
                    }

                    // 3. If this key was swallowed on keydown, swallow its keyup as well
                    if (isKeyUp && vk < 256 && _swallowedKeys[vk])
                    {
                        _swallowedKeys[vk] = false;
                        return (IntPtr)1;
                    }

                    // 4. While capturing stealth input, process and swallow keystrokes
                    if (_capturing)
                    {
                        // Pass through OS shortcuts like Alt+Tab, Alt+F4, Win+...
                        if (win || (alt && !ctrl))
                        {
                            return CallNextHookEx(_hookID, nCode, wParam, lParam);
                        }

                        // Pass through pure modifier keys alone (Shift, Ctrl, Alt, Caps) so keyboard state works
                        if (IsModifierKey(vk))
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
                            _leftShiftDown = false;
                            _rightShiftDown = false;
                            Console.WriteLine("{\"event\":\"escape\"}");
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
                            _leftShiftDown = false;
                            _rightShiftDown = false;
                            Console.WriteLine("{\"event\":\"enter\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Enter
                        }

                        // Handle Backspace: remove last character
                        if (vk == VK_BACK)
                        {
                            Console.WriteLine("{\"event\":\"backspace\"}");
                            Console.Out.Flush();
                            return (IntPtr)1; // swallow Backspace
                        }

                        // For Ctrl shortcuts (like Ctrl+A, Ctrl+V, etc.)
                        if (ctrl)
                        {
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
                            return CallNextHookEx(_hookID, nCode, wParam, lParam);
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
