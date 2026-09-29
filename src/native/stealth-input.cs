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
        private const int WM_SYSKEYDOWN = 0x0104;

        private const int VK_BACK = 0x08;
        private const int VK_TAB = 0x09;
        private const int VK_RETURN = 0x0D;
        private const int VK_ESCAPE = 0x1B;
        private const int VK_SHIFT = 0x10;
        private const int VK_CONTROL = 0x11;
        private const int VK_MENU = 0x12; // Alt
        private const int VK_CAPITAL = 0x14; // Caps Lock
        private const int VK_LWIN = 0x5B;
        private const int VK_RWIN = 0x5C;

        private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
        private static LowLevelKeyboardProc _proc = HookCallback;
        private static IntPtr _hookID = IntPtr.Zero;
        private static volatile bool _capturing = false;

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

        static void Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;

            if (args.Length > 0 && args[0] == "--test")
            {
                byte[] keyState = new byte[256];
                StringBuilder sb = new StringBuilder(16);
                int rc = ToUnicode(0x41, 0x1E, keyState, sb, sb.Capacity, 0);
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

        private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0 && _capturing)
            {
                int msg = wParam.ToInt32();
                if (msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN)
                {
                    KBDLLHOOKSTRUCT hookStruct = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                    uint vk = hookStruct.vkCode;

                    bool ctrl = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;
                    bool alt = (GetAsyncKeyState(VK_MENU) & 0x8000) != 0;
                    bool win = (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 || (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;

                    // Pass through Windows key shortcuts and system combos like Alt+Tab, Ctrl+Alt+Del
                    if (win || (alt && vk == VK_TAB))
                    {
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }

                    // Alt+C toggles capture OFF
                    if (alt && (vk == 0x43 || vk == 0x63)) // 'C'
                    {
                        _capturing = false;
                        Console.WriteLine("{\"event\":\"toggle_off\"}");
                        Console.Out.Flush();
                        return (IntPtr)1; // swallow Alt+C
                    }

                    // Handle Escape: cancel/stop capture
                    if (vk == VK_ESCAPE)
                    {
                        _capturing = false;
                        Console.WriteLine("{\"event\":\"escape\"}");
                        Console.Out.Flush();
                        return (IntPtr)1; // swallow Escape
                    }

                    // Handle Enter: submit query
                    if (vk == VK_RETURN)
                    {
                        _capturing = false;
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
                        // Let other Ctrl combinations pass or swallow?
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }

                    // Translate to Unicode character
                    byte[] keyState = new byte[256];
                    bool shift = (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
                    bool caps = (GetKeyState(VK_CAPITAL) & 0x0001) != 0;

                    if (shift) keyState[VK_SHIFT] = 0x80;
                    if (caps) keyState[VK_CAPITAL] = 0x01;

                    StringBuilder sb = new StringBuilder(16);
                    int rc = ToUnicode(vk, hookStruct.scanCode, keyState, sb, sb.Capacity, 0);

                    if (rc > 0)
                    {
                        string str = sb.ToString();
                        string jsonChar = EscapeJson(str);
                        Console.WriteLine("{\"event\":\"char\",\"char\":\"" + jsonChar + "\"}");
                        Console.Out.Flush();
                        return (IntPtr)1; // swallow character key
                    }

                    // If it's a modifier key itself (Shift, Ctrl, Alt, Caps), pass through
                    if (vk == VK_SHIFT || vk == VK_CONTROL || vk == VK_MENU || vk == VK_CAPITAL)
                    {
                        return CallNextHookEx(_hookID, nCode, wParam, lParam);
                    }

                    // Swallow any other key while capturing to prevent leaking to background app
                    return (IntPtr)1;
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
