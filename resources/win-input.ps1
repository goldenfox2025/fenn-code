# Fenn Code's Windows input helper: stays running while computer control is in use.
# Reads one JSON request per line on stdin and writes one base64-encoded JSON
# reply per line on stdout. See src/main/computer/win.ts.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FennInput {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);

  static readonly Dictionary<string, int> Named = new Dictionary<string, int> {
    {"ctrl",0x11},{"shift",0x10},{"alt",0x12},{"cmd",0x5B},
    {"enter",0x0D},{"tab",0x09},{"escape",0x1B},{"backspace",0x08},{"delete",0x2E},{"space",0x20},
    {"left",0x25},{"up",0x26},{"right",0x27},{"down",0x28},{"home",0x24},{"end",0x23},
    {"pageup",0x21},{"pagedown",0x22},{"insert",0x2D},{"capslock",0x14},{"printscreen",0x2C},
    {"menu",0x5D},{"pause",0x13},{"numlock",0x90},{"scrolllock",0x91},
    {"volumeup",0xAF},{"volumedown",0xAE},{"volumemute",0xAD},
    {"mediaplaypause",0xB3},{"medianext",0xB0},{"mediaprevious",0xB1}
  };

  static void Send(params INPUT[] ins) {
    if (SendInput((uint)ins.Length, ins, Marshal.SizeOf(typeof(INPUT))) != ins.Length)
      throw new Exception("系统拒绝了模拟输入。目标窗口可能以管理员身份运行，Fenn Code 不能操作它。");
  }
  static INPUT M(uint flags, int data) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = unchecked((uint)data); return i;
  }
  static INPUT K(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i;
  }
  static bool Extended(int vk) {
    return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90;
  }

  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Button(string b, bool up) {
    uint f = b == "right" ? (up ? 0x10u : 0x08u) : b == "middle" ? (up ? 0x40u : 0x20u) : (up ? 0x04u : 0x02u);
    Send(M(f, 0));
  }
  public static void Click(int x, int y, string b, int n) {
    SetCursorPos(x, y);
    Thread.Sleep(15);
    for (int k = 0; k < n; k++) { Button(b, false); Button(b, true); Thread.Sleep(35); }
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); Thread.Sleep(20);
    Button("left", false);
    for (int i = 1; i <= 12; i++) { SetCursorPos(x1 + (x2 - x1) * i / 12, y1 + (y2 - y1) * i / 12); Thread.Sleep(12); }
    Button("left", true);
  }
  public static void Wheel(int dx, int dy) {
    if (dy != 0) Send(M(0x0800, -dy * 120));
    if (dx != 0) Send(M(0x1000, dx * 120));
  }
  public static void Key(int vk, bool up) {
    Send(K((ushort)vk, 0, (up ? 2u : 0u) | (Extended(vk) ? 1u : 0u)));
  }
  static int Vk(string k, ref bool shift) {
    int v;
    if (Named.TryGetValue(k, out v)) return v;
    if (k.Length > 1 && k[0] == 'f') { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return 0x6F + n; }
    if (k.Length == 1) {
      short s = VkKeyScan(k[0]);
      if (s != -1) { if ((s & 0x100) != 0) shift = true; return s & 0xff; }
    }
    throw new Exception("不认识的按键：" + k);
  }
  public static void KeyName(string k, bool up) { bool s = false; Key(Vk(k, ref s), up); }
  public static void Chord(string[] keys, int repeat, int holdMs) {
    List<int> vks = new List<int>();
    bool shift = false;
    foreach (string k in keys) vks.Add(Vk(k, ref shift));
    if (shift && !vks.Contains(0x10)) vks.Insert(0, 0x10);
    for (int r = 0; r < Math.Max(1, repeat); r++) {
      foreach (int v in vks) Key(v, false);
      Thread.Sleep(holdMs > 0 ? holdMs : 10);
      for (int i = vks.Count - 1; i >= 0; i--) Key(vks[i], true);
      Thread.Sleep(20);
    }
  }
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') { Key(0x0D, false); Key(0x0D, true); }
      else if (c == '\t') { Key(0x09, false); Key(0x09, true); }
      else Send(K(0, c, 4u), K(0, c, 4u | 2u));
      Thread.Sleep(4);
    }
  }
  public static string Cursor() { POINT p; GetCursorPos(out p); return p.X + "," + p.Y; }

  static string Describe(uint pid) {
    try {
      Process p = Process.GetProcessById((int)pid);
      string desc = null;
      try { desc = p.MainModule.FileVersionInfo.FileDescription; } catch { }
      return pid + "\t" + p.ProcessName + "\t" + (string.IsNullOrWhiteSpace(desc) ? p.ProcessName : desc.Trim());
    } catch { return null; }
  }
  static uint PidOf(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try {
      // Store apps live inside ApplicationFrameHost; the app itself owns a child window.
      if (Process.GetProcessById((int)pid).ProcessName.Equals("ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
        uint host = pid, inner = pid;
        EnumChildWindows(h, delegate (IntPtr c, IntPtr l) { uint cp; GetWindowThreadProcessId(c, out cp); if (cp != host) { inner = cp; return false; } return true; }, IntPtr.Zero);
        return inner;
      }
    } catch { }
    return pid;
  }
  static bool AppWindow(IntPtr h) { return IsWindowVisible(h) && GetWindowTextLength(h) > 0 && GetAncestor(h, 3) == h; }

  public static string Foreground() { IntPtr h = GetForegroundWindow(); return h == IntPtr.Zero ? null : Describe(PidOf(h)); }
  public static string AppAt(int x, int y) {
    POINT p = new POINT(); p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return null;
    return Describe(PidOf(GetAncestor(h, 2)));
  }
  public static string Apps() {
    HashSet<uint> seen = new HashSet<uint>();
    StringBuilder sb = new StringBuilder();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (AppWindow(h)) { uint pid = PidOf(h); if (seen.Add(pid)) { string d = Describe(pid); if (d != null) sb.Append(d).Append('\n'); } }
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }
  public static string Focus(string q) {
    q = q.ToLowerInvariant();
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!AppWindow(h)) return true;
      string d = Describe(PidOf(h));
      if (d == null) return true;
      string[] f = d.Split('\t');
      string id = f[1].ToLowerInvariant(), name = f[2].ToLowerInvariant();
      if (id == q || name == q || name.Contains(q)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return null;
    if (IsIconic(found)) ShowWindow(found, 9);
    // Windows only lets the process that has input bring a window forward; a tap of Alt counts as input.
    Key(0x12, false); Key(0x12, true);
    SetForegroundWindow(found);
    Thread.Sleep(150);
    return Describe(PidOf(found));
  }
}
'@
[FennInput]::SetProcessDPIAware() | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false
function S($b) { if ($b) { $utf8.GetString([Convert]::FromBase64String($b)) } else { '' } }
function Reply($o) { [Console]::Out.WriteLine([Convert]::ToBase64String($utf8.GetBytes(($o | ConvertTo-Json -Compress -Depth 4)))); [Console]::Out.Flush() }
function Open-App($q) {
  $r = [FennInput]::Focus($q)
  if ($r) { return $r }
  $before = [FennInput]::Foreground()
  $apps = @(Get-StartApps)
  $app = $apps | Where-Object { $_.Name -ieq $q } | Select-Object -First 1
  if (-not $app) { $p = '*' + [WildcardPattern]::Escape($q) + '*'; $app = $apps | Where-Object { $_.Name -like $p } | Select-Object -First 1 }
  if ($app) { Start-Process ('shell:AppsFolder\' + $app.AppID) }
  else {
    try { Start-Process $q } catch { throw ('找不到名为「' + $q + '」的程序。') }
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    $now = [FennInput]::Foreground()
    if ($now -and $now -ne $before) { return $now }
  }
  return [FennInput]::Foreground()
}
Reply @{ id = 0; ok = $true; r = 'ready' }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $q = $line | ConvertFrom-Json
  try {
    $r = $null
    switch ($q.op) {
      'move' { [FennInput]::Move($q.x, $q.y) }
      'click' {
        foreach ($m in @($q.mods)) { if ($m) { [FennInput]::KeyName($m, $false) } }
        try { [FennInput]::Click($q.x, $q.y, $q.b, $q.n) }
        finally { foreach ($m in @($q.mods)) { if ($m) { [FennInput]::KeyName($m, $true) } } }
      }
      'drag' { [FennInput]::Drag($q.x, $q.y, $q.x2, $q.y2) }
      'scroll' { [FennInput]::Move($q.x, $q.y); [FennInput]::Wheel($q.dx, $q.dy) }
      'type' { [FennInput]::TypeText((S $q.s)) }
      'key' { [FennInput]::Chord([string[]]@($q.keys), $q.n, $q.hold) }
      'cursor' { $r = [FennInput]::Cursor() }
      'front' { $r = [FennInput]::Foreground() }
      'at' { $r = [FennInput]::AppAt($q.x, $q.y) }
      'apps' { $r = [FennInput]::Apps() }
      'open' { $r = Open-App (S $q.s) }
      default { throw ('unknown op ' + $q.op) }
    }
    Reply @{ id = $q.id; ok = $true; r = $r }
  } catch {
    Reply @{ id = $q.id; ok = $false; e = $_.Exception.Message }
  }
}
