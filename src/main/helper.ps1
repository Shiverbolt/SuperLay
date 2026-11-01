# SuperLay sensor helper.
# Runs under Windows PowerShell 5.1 (in-box .NET Framework), so SuperLay needs no native Node modules.
# Emits one JSON object per line on stdout; accepts line commands on stdin:
#   interval <ms>            change the tick interval
#   modules <id> <pid> <re>  list loaded modules whose file name matches <re>
#   procinfo <id> <pid>      exe path + version info for a process
#   versions <id> <p1>|<p2>  file versions for a list of paths
param([int]$IntervalMs = 1000)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

public static class SLHelper {
    public static int IntervalMs = 1000;

    // ---------- Win32 ----------
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    struct MEMSTAT {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx(ref MEMSTAT m);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder sb, ref int size);

    // ---------- D3DKMT (same source Task Manager uses for GPU temperature / clocks) ----------
    [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct ADAPTERINFO { public uint hAdapter; public LUID Luid; public uint NumOfSources; public int Precise; }
    [StructLayout(LayoutKind.Sequential)] struct ENUMADAPTERS2 { public uint NumAdapters; public IntPtr pAdapters; }
    [StructLayout(LayoutKind.Sequential)] struct QUERYADAPTERINFO { public uint hAdapter; public int Type; public IntPtr pData; public uint DataSize; }
    [DllImport("gdi32.dll")] static extern int D3DKMTEnumAdapters2(ref ENUMADAPTERS2 e);
    [DllImport("gdi32.dll")] static extern int D3DKMTQueryAdapterInfo(ref QUERYADAPTERINFO q);
    const int KMTQAITYPE_NODEPERFDATA = 61, KMTQAITYPE_ADAPTERPERFDATA = 62;

    static Dictionary<string, uint> kmt = new Dictionary<string, uint>();
    static PerformanceCounter cpuCounter;
    static Dictionary<string, CounterSample> prevEngine = new Dictionary<string, CounterSample>();
    static string gpuName = "";
    static ulong vramTotal = 0;
    static string gpuLuid = null;
    static bool isAdmin, isPerfLogUser;
    static volatile bool stdinClosed;
    static ConcurrentQueue<string> cmds = new ConcurrentQueue<string>();
    static readonly object outLock = new object();

    static void Init() {
        try {
            var id = WindowsIdentity.GetCurrent();
            var p = new WindowsPrincipal(id);
            isAdmin = p.IsInRole(WindowsBuiltInRole.Administrator);
            isPerfLogUser = p.IsInRole(new SecurityIdentifier("S-1-5-32-559"));
        } catch { }

        try {
            cpuCounter = new PerformanceCounter("Processor Information", "% Processor Utility", "_Total");
            cpuCounter.NextValue();
        } catch {
            try { cpuCounter = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpuCounter.NextValue(); } catch { }
        }

        // Largest-VRAM display adapter from the registry (WMI's AdapterRAM caps at 4 GB).
        try {
            using (var cls = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}")) {
                foreach (var sub in cls.GetSubKeyNames()) {
                    try {
                        using (var k = cls.OpenSubKey(sub)) {
                            if (k == null) continue;
                            object mem = k.GetValue("HardwareInformation.qwMemorySize");
                            ulong m = 0;
                            if (mem is long) m = (ulong)(long)mem;
                            else if (mem is byte[] && ((byte[])mem).Length >= 8) m = BitConverter.ToUInt64((byte[])mem, 0);
                            if (m > vramTotal) { vramTotal = m; gpuName = (k.GetValue("DriverDesc") as string) ?? ""; }
                        }
                    } catch { }
                }
            }
        } catch { }

        try {
            var e = new ENUMADAPTERS2();
            if (D3DKMTEnumAdapters2(ref e) == 0 && e.NumAdapters > 0) {
                int sz = Marshal.SizeOf(typeof(ADAPTERINFO));
                e.pAdapters = Marshal.AllocHGlobal(sz * (int)e.NumAdapters);
                if (D3DKMTEnumAdapters2(ref e) == 0) {
                    for (int i = 0; i < e.NumAdapters; i++) {
                        var a = (ADAPTERINFO)Marshal.PtrToStructure(new IntPtr(e.pAdapters.ToInt64() + i * sz), typeof(ADAPTERINFO));
                        kmt[LuidKey((uint)a.Luid.High, a.Luid.Low)] = a.hAdapter;
                    }
                }
            }
        } catch { }
    }

    static string LuidKey(uint high, uint low) { return ("luid_0x" + high.ToString("X8") + "_0x" + low.ToString("X8")).ToLowerInvariant(); }

    static IntPtr Query(uint h, int type, int size, Action<IntPtr> prep) {
        IntPtr buf = Marshal.AllocHGlobal(size);
        for (int i = 0; i < size; i++) Marshal.WriteByte(buf, i, 0);
        if (prep != null) prep(buf);
        var q = new QUERYADAPTERINFO { hAdapter = h, Type = type, pData = buf, DataSize = (uint)size };
        if (D3DKMTQueryAdapterInfo(ref q) != 0) { Marshal.FreeHGlobal(buf); return IntPtr.Zero; }
        return buf;
    }

    // ---------- tick ----------
    static string Tick() {
        var sb = new StringBuilder(512);
        sb.Append("{\"type\":\"tick\"");

        double cpu = -1;
        try { if (cpuCounter != null) cpu = Math.Min(100.0, cpuCounter.NextValue()); } catch { }
        sb.Append(",\"cpu\":").Append(N(cpu));

        var ms = new MEMSTAT(); ms.dwLength = (uint)Marshal.SizeOf(typeof(MEMSTAT));
        if (GlobalMemoryStatusEx(ref ms)) sb.Append(",\"ramUsed\":").Append(ms.ullTotalPhys - ms.ullAvailPhys).Append(",\"ramTotal\":").Append(ms.ullTotalPhys);

        // foreground window
        uint fgPid = 0;
        IntPtr fg = GetForegroundWindow();
        if (fg != IntPtr.Zero) {
            GetWindowThreadProcessId(fg, out fgPid);
            var t = new StringBuilder(256); GetWindowText(fg, t, 256);
            RECT r;
            if (DwmGetWindowAttribute(fg, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(fg, out r);
            sb.Append(",\"fg\":{\"pid\":").Append(fgPid).Append(",\"title\":").Append(J(t.ToString()))
              .Append(",\"minimized\":").Append(IsIconic(fg) ? "true" : "false")
              .Append(",\"x\":").Append(r.L).Append(",\"y\":").Append(r.T).Append(",\"w\":").Append(r.R - r.L).Append(",\"h\":").Append(r.B - r.T).Append("}");
        }

        // GPU engines (Task Manager method: per engine type, sum over processes, take the busiest type)
        var perType = new Dictionary<string, double>();
        var perLuid = new Dictionary<string, double>();
        double fgLoad = 0;
        try {
            var cat = new PerformanceCounterCategory("GPU Engine");
            var data = cat.ReadCategory()["utilization percentage"];
            var next = new Dictionary<string, CounterSample>();
            string fgTag = "pid_" + fgPid + "_";
            foreach (InstanceData inst in data.Values) {
                string name = inst.InstanceName;
                CounterSample s = inst.Sample;
                next[name] = s;
                CounterSample prev;
                if (!prevEngine.TryGetValue(name, out prev)) continue;
                double v = CounterSample.Calculate(prev, s);
                if (v <= 0 || double.IsNaN(v)) continue;
                int li = name.IndexOf("luid_"); int pi = name.IndexOf("_phys");
                int ei = name.IndexOf("engtype_");
                if (li < 0 || pi < 0 || ei < 0) continue;
                string luid = name.Substring(li, pi - li).ToLowerInvariant();
                string key = luid + "|" + name.Substring(ei + 8);
                double cur; perType.TryGetValue(key, out cur); perType[key] = cur + v;
                if (fgPid != 0 && name.StartsWith(fgTag) && name.EndsWith("engtype_3D")) fgLoad += v;
            }
            prevEngine = next;
        } catch { }

        // Pick the GPU: the adapter with the highest dedicated memory use (the discrete card on hybrid systems).
        ulong vramUsed = 0;
        try {
            var cat = new PerformanceCounterCategory("GPU Adapter Memory");
            var data = cat.ReadCategory()["dedicated usage"];
            ulong best = 0; string bestLuid = null;
            foreach (InstanceData inst in data.Values) {
                ulong v = (ulong)Math.Max(0, inst.RawValue);
                string name = inst.InstanceName.ToLowerInvariant();
                int li = name.IndexOf("luid_"); int pi = name.IndexOf("_phys");
                if (li < 0 || pi < 0) continue;
                if (v >= best) { best = v; bestLuid = name.Substring(li, pi - li); }
            }
            if (bestLuid != null) { gpuLuid = bestLuid; vramUsed = best; }
        } catch { }

        ulong fgVram = 0;
        try {
            if (fgPid != 0 && gpuLuid != null) {
                var cat = new PerformanceCounterCategory("GPU Process Memory");
                var data = cat.ReadCategory()["dedicated usage"];
                string tag = "pid_" + fgPid + "_" + gpuLuid;
                foreach (InstanceData inst in data.Values)
                    if (inst.InstanceName.ToLowerInvariant().StartsWith(tag)) fgVram += (ulong)Math.Max(0, inst.RawValue);
            }
        } catch { }

        double load = 0;
        foreach (var kv in perType) if (gpuLuid != null && kv.Key.StartsWith(gpuLuid + "|") && kv.Value > load) load = kv.Value;

        sb.Append(",\"gpu\":{\"name\":").Append(J(gpuName))
          .Append(",\"load\":").Append(N(Math.Min(100, load)))
          .Append(",\"vramUsed\":").Append(vramUsed)
          .Append(",\"vramTotal\":").Append(vramTotal);

        uint h;
        if (gpuLuid != null && kmt.TryGetValue(gpuLuid, out h)) {
            // D3DKMT_ADAPTER_PERFDATA is 64 bytes: Temperature is a ULONG in deci-Celsius, Power is tenths of a percent of TDP.
            IntPtr p = Query(h, KMTQAITYPE_ADAPTERPERFDATA, 64, null);
            if (p != IntPtr.Zero) {
                ulong memHz = (ulong)Marshal.ReadInt64(p, 8);
                uint fan = (uint)Marshal.ReadInt32(p, 48);
                uint power = (uint)Marshal.ReadInt32(p, 52);
                uint temp = (uint)Marshal.ReadInt32(p, 56);
                Marshal.FreeHGlobal(p);
                if (temp > 0 && temp < 2000) sb.Append(",\"temp\":").Append(N(temp / 10.0));
                if (power > 0 && power <= 2000) sb.Append(",\"power\":").Append(N(power / 10.0));
                if (fan > 0) sb.Append(",\"fan\":").Append(fan);
                if (memHz > 0) sb.Append(",\"memClock\":").Append(memHz / 1000000);
            }
            p = Query(h, KMTQAITYPE_NODEPERFDATA, 56, null);
            if (p != IntPtr.Zero) {
                ulong hz = (ulong)Marshal.ReadInt64(p, 8);
                Marshal.FreeHGlobal(p);
                if (hz > 0) sb.Append(",\"clock\":").Append(hz / 1000000);
            }
        }
        sb.Append("}");
        sb.Append(",\"fgGpu\":{\"load\":").Append(N(Math.Min(100, fgLoad))).Append(",\"vram\":").Append(fgVram).Append("}");
        sb.Append(",\"admin\":").Append(isAdmin ? "true" : "false");
        sb.Append(",\"perfLogUser\":").Append(isPerfLogUser ? "true" : "false");
        sb.Append("}");
        return sb.ToString();
    }

    // ---------- commands ----------
    static string Handle(string line) {
        string[] parts = line.Split(new[] { ' ' }, 4);
        string cmd = parts[0];
        if (cmd == "interval" && parts.Length > 1) { IntervalMs = Math.Max(100, int.Parse(parts[1])); return null; }
        if (cmd == "modules" && parts.Length > 3) return Modules(parts[1], int.Parse(parts[2]), parts[3]);
        if (cmd == "procinfo" && parts.Length > 2) return ProcInfo(parts[1], int.Parse(parts[2]));
        if ((cmd == "versions" || cmd == "mapped") && parts.Length > 2) {
            string rest = line.Substring(line.IndexOf(' ', line.IndexOf(' ') + 1) + 1);
            return cmd == "versions" ? Versions(parts[1], rest.Split('|')) : Mapped(parts[1], rest.Split('|'));
        }
        return null;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    // Anti-cheat protected games refuse module enumeration, but a DLL mapped as an image cannot be
    // opened for FILE_WRITE_DATA (ERROR_SHARING_VIOLATION). Nothing is written; the handle is closed at once.
    static string Mapped(string id, string[] paths) {
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"mapped\",\"id\":").Append(J(id)).Append(",\"files\":[");
        bool first = true;
        foreach (var p in paths) {
            if (p.Length == 0) continue;
            string state;
            IntPtr h = CreateFile(p, 0x2, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);
            if (h == new IntPtr(-1)) state = Marshal.GetLastWin32Error() == 32 ? "loaded" : "unknown";
            else { CloseHandle(h); state = "idle"; }
            if (!first) sb.Append(",");
            first = false;
            sb.Append("{\"path\":").Append(J(p)).Append(",\"state\":\"").Append(state).Append("\"}");
        }
        return sb.Append("]}").ToString();
    }

    static string Modules(string id, int pid, string pattern) {
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"modules\",\"id\":").Append(J(id)).Append(",\"pid\":").Append(pid);
        try {
            var re = new Regex(pattern, RegexOptions.IgnoreCase);
            var proc = Process.GetProcessById(pid);
            var list = new StringBuilder();
            foreach (ProcessModule m in proc.Modules) {
                if (!re.IsMatch(m.ModuleName)) continue;
                if (list.Length > 0) list.Append(",");
                string ver = "";
                try { var fv = m.FileVersionInfo; ver = VersionOf(fv); } catch { }
                list.Append("{\"name\":").Append(J(m.ModuleName)).Append(",\"path\":").Append(J(m.FileName)).Append(",\"version\":").Append(J(ver)).Append("}");
            }
            sb.Append(",\"ok\":true,\"modules\":[").Append(list).Append("]");
        } catch (Exception e) {
            sb.Append(",\"ok\":false,\"error\":").Append(J(e.Message));
        }
        return sb.Append("}").ToString();
    }

    static string VersionOf(FileVersionInfo fv) {
        if (fv.FileMajorPart != 0 || fv.FileMinorPart != 0 || fv.FileBuildPart != 0)
            return fv.FileMajorPart + "." + fv.FileMinorPart + "." + fv.FileBuildPart + "." + fv.FilePrivatePart;
        return fv.FileVersion ?? "";
    }

    static string ProcInfo(string id, int pid) {
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"procinfo\",\"id\":").Append(J(id)).Append(",\"pid\":").Append(pid);
        string path = null;
        IntPtr h = OpenProcess(0x1000, false, (uint)pid);
        if (h != IntPtr.Zero) {
            var s = new StringBuilder(1024); int n = 1024;
            if (QueryFullProcessImageName(h, 0, s, ref n)) path = s.ToString();
            CloseHandle(h);
        }
        sb.Append(",\"path\":").Append(J(path));
        if (path != null) {
            try {
                var fv = FileVersionInfo.GetVersionInfo(path);
                sb.Append(",\"product\":").Append(J(fv.ProductName)).Append(",\"description\":").Append(J(fv.FileDescription))
                  .Append(",\"company\":").Append(J(fv.CompanyName));
            } catch { }
        }
        return sb.Append("}").ToString();
    }

    static string Versions(string id, string[] paths) {
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"versions\",\"id\":").Append(J(id)).Append(",\"files\":[");
        bool first = true;
        foreach (var p in paths) {
            if (p.Length == 0) continue;
            string ver = "";
            try { ver = VersionOf(FileVersionInfo.GetVersionInfo(p)); } catch { }
            if (!first) sb.Append(",");
            first = false;
            sb.Append("{\"path\":").Append(J(p)).Append(",\"version\":").Append(J(ver)).Append("}");
        }
        return sb.Append("]}").ToString();
    }

    // ---------- plumbing ----------
    static string N(double v) { return v.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture); }
    static string J(string s) {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char c in s) {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }
    static void Emit(string s) { lock (outLock) { Console.Out.WriteLine(s); Console.Out.Flush(); } }

    static void ReadLoop() {
        try {
            string l;
            while ((l = Console.In.ReadLine()) != null) { l = l.Trim(); if (l.Length > 0) cmds.Enqueue(l); }
        } catch { }
        stdinClosed = true;
    }

    public static void Run(int interval) {
        IntervalMs = Math.Max(100, interval);
        Init();
        var t = new Thread(ReadLoop); t.IsBackground = true; t.Start();
        Emit("{\"type\":\"ready\",\"gpu\":" + J(gpuName) + ",\"kmtAdapters\":" + kmt.Count + "}");
        var sw = Stopwatch.StartNew();
        while (!stdinClosed) {
            long t0 = sw.ElapsedMilliseconds;
            try { Emit(Tick()); } catch (Exception e) { Emit("{\"type\":\"error\",\"msg\":" + J(e.Message) + "}"); }
            do {
                string c;
                while (cmds.TryDequeue(out c)) {
                    try { string r = Handle(c); if (r != null) Emit(r); }
                    catch (Exception e) { Emit("{\"type\":\"error\",\"msg\":" + J(e.Message) + "}"); }
                }
                if (stdinClosed) return;
                Thread.Sleep(10);
            } while (sw.ElapsedMilliseconds - t0 < IntervalMs);
        }
    }
}
'@

[SLHelper]::Run($IntervalMs)
