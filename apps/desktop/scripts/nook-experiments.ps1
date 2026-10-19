<#
The two P1 experiments that need the owner's own desktop and eyes (docs/nook-wm.md, "### P1"),
plus a visual check of the third. P1's tests ran the rest on a private desktop.

It SHOWS WINDOWS ON YOUR DESKTOP: three small windows of its own, for about a minute. It never
touches any other window, opens no process and changes no setting. Run it only when you want to
look, and close nothing else while it runs:

  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy',
    'Bypass', '-File', 'apps\desktop\scripts\nook-experiments.ps1'

1. Click activation. A bar-like strip at the top-left of your main monitor, made the way Nook's
   bar will be (WS_EX_NOACTIVATE, topmost, a tool window). Click it a few times within 30 s. The
   result says whether the window in front changed when you clicked; it shouldn't.
2. Acrylic. A panel beside it asks for the acrylic backdrop without ever being activated. Look:
   does it show blurred acrylic, or a flat colour? Write down which.
3. Transitions. A third window turns off its own DWM transitions, then minimizes and restores
   itself twice. The private-desktop test found Windows accepts the call from another process
   (S_OK); this is where you see whether the animation is really gone.

Results: nook-experiments-<time>.txt in your temp folder (the path is the last line of the run).
#>
[CmdletBinding()]
param([int]$Seconds = 30)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NookExperiments {
    delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASS {
        public uint style; public WndProc proc; public int cls; public int wnd; public IntPtr inst;
        public IntPtr icon; public IntPtr cursor; public IntPtr brush; public string menu; public string name;
    }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w; public IntPtr l; public uint t; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)] struct MARGINS { public int l, r, t, b; }

    [DllImport("user32", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
    [DllImport("user32", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr p);
    [DllImport("user32")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32")] static extern bool DestroyWindow(IntPtr h);
    [DllImport("user32")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32")] static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
    [DllImport("user32")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32")] static extern IntPtr DispatchMessageW(ref MSG m);
    [DllImport("user32")] static extern uint MsgWaitForMultipleObjects(uint n, IntPtr[] h, bool all, uint ms, uint mask);
    [DllImport("user32", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("kernel32")] static extern IntPtr GetModuleHandleW(IntPtr name);
    [DllImport("dwmapi")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
    [DllImport("dwmapi")] static extern int DwmExtendFrameIntoClientArea(IntPtr h, ref MARGINS m);

    const uint WS_POPUP = 0x80000000, WS_CAPTION = 0x00C00000, WS_SYSMENU = 0x00080000, WS_OVERLAPPEDWINDOW = 0x00CF0000;
    const uint WS_EX_NOACTIVATE = 0x08000000, WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80;
    const uint WM_MOUSEACTIVATE = 0x21, WM_LBUTTONDOWN = 0x201, WM_LBUTTONUP = 0x202;
    const int MA_NOACTIVATE = 3, SW_SHOWNOACTIVATE = 4, SW_MINIMIZE = 6, SW_RESTORE = 9;
    const int DWMWA_TRANSITIONS_FORCEDISABLED = 3, DWMWA_SYSTEMBACKDROP_TYPE = 38, DWMSBT_TRANSIENTWINDOW = 3;

    static IntPtr bar, before;
    static int clicks, moved;
    static StringBuilder log = new StringBuilder();
    static WndProc keep;

    static string Name(IntPtr h) {
        var s = new StringBuilder(256);
        GetClassNameW(h, s, 256);
        return string.Format("{0:x} ({1})", h.ToInt64(), s);
    }

    static IntPtr Proc(IntPtr h, uint m, IntPtr w, IntPtr l) {
        if (h == bar && m == WM_MOUSEACTIVATE) return new IntPtr(MA_NOACTIVATE);
        if (h == bar && m == WM_LBUTTONDOWN) before = GetForegroundWindow();
        if (h == bar && m == WM_LBUTTONUP) {
            clicks++;
            IntPtr after = GetForegroundWindow();
            if (after != before) moved++;
            log.AppendLine(string.Format("click {0}: foreground {1} -> {2}", clicks, Name(before), Name(after)));
        }
        return DefWindowProcW(h, m, w, l);
    }

    static void Pump(int ms) {
        var until = Environment.TickCount + ms;
        while (true) {
            MSG msg;
            while (PeekMessageW(out msg, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
            int left = until - Environment.TickCount;
            if (left <= 0) return;
            MsgWaitForMultipleObjects(0, null, false, (uint)Math.Min(left, 500), 0x04FF);
        }
    }

    public static string Run(int seconds) {
        keep = Proc;
        var inst = GetModuleHandleW(IntPtr.Zero);
        var wc = new WNDCLASS { proc = keep, inst = inst, name = "NookExperiment", brush = new IntPtr(6) };
        RegisterClassW(ref wc);
        bar = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW, "NookExperiment",
            "Nook experiment: click me", WS_POPUP, 0, 0, 480, 28, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
        var acrylic = CreateWindowExW(WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW, "NookExperiment",
            "Nook experiment: acrylic", WS_POPUP | WS_CAPTION, 500, 40, 360, 240, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
        var margins = new MARGINS { l = -1, r = -1, t = -1, b = -1 };
        int backdrop = DWMSBT_TRANSIENTWINDOW;
        log.AppendLine(string.Format("acrylic: DwmExtendFrameIntoClientArea {0:x8}, DWMWA_SYSTEMBACKDROP_TYPE {1:x8}",
            DwmExtendFrameIntoClientArea(acrylic, ref margins),
            DwmSetWindowAttribute(acrylic, DWMWA_SYSTEMBACKDROP_TYPE, ref backdrop, 4)));
        ShowWindow(bar, SW_SHOWNOACTIVATE);
        ShowWindow(acrylic, SW_SHOWNOACTIVATE);
        log.AppendLine("foreground at start: " + Name(GetForegroundWindow()));
        Pump(seconds * 1000);
        log.AppendLine(string.Format("clicks: {0}, of which moved the foreground: {1}", clicks, moved));

        var plain = CreateWindowExW(0, "NookExperiment", "Nook experiment: transitions off",
            WS_OVERLAPPEDWINDOW, 900, 40, 420, 300, IntPtr.Zero, IntPtr.Zero, inst, IntPtr.Zero);
        int off = 1;
        log.AppendLine(string.Format("transitions: DWMWA_TRANSITIONS_FORCEDISABLED on its own window {0:x8}",
            DwmSetWindowAttribute(plain, DWMWA_TRANSITIONS_FORCEDISABLED, ref off, 4)));
        ShowWindow(plain, SW_SHOWNOACTIVATE);
        for (int i = 0; i < 2; i++) {
            Pump(1500); ShowWindow(plain, SW_MINIMIZE);
            Pump(1500); ShowWindow(plain, SW_RESTORE);
        }
        Pump(1500);
        DestroyWindow(plain);
        DestroyWindow(acrylic);
        DestroyWindow(bar);
        return log.ToString();
    }
}
'@

$text = [NookExperiments]::Run($Seconds)
$file = Join-Path $env:TEMP ("nook-experiments-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
@(
  "Nook experiments, $(Get-Date -Format o)"
  $text
  'Still to write down by eye: did the acrylic panel look blurred or flat, and did the third'
  "window's minimize and restore animate?"
) | Set-Content -Path $file -Encoding utf8
$file
