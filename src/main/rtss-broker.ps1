# SuperLay's elevated RTSS broker. Started once per SuperLay session (one UAC prompt), it applies
# frame-rate caps through RTSS's profile API (RTSSHooks64.dll, as MSI Afterburner does), because RTSS
# keeps its profiles under Program Files.
#
# Locked down on purpose:
#   - the pipe's ACL admits only the user who started it;
#   - every request must carry the random token SuperLay passed at launch (an elevated process's
#     command line isn't readable from a normal-integrity process);
#   - it can do exactly one thing: set FramerateLimit / FramerateLimitDenominator / SyncLimiter on a
#     profile named like "game.exe";
#   - it exits when SuperLay exits.
#
# Request (one line):  <token>|<profile.exe>|<limit>|<denominator>|<mode>
# Response (one line): ok | err <message>
param(
  [Parameter(Mandatory)] [string]$Dll,
  [Parameter(Mandatory)] [string]$Pipe,
  [Parameter(Mandatory)] [string]$Token,
  [Parameter(Mandatory)] [int]$ParentPid
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;
using System.Threading;

public static class RtssBroker {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string p);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr m, string n);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate bool NameFn([MarshalAs(UnmanagedType.LPStr)] string p);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate bool SetFn([MarshalAs(UnmanagedType.LPStr)] string n, ref uint v, uint size);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void VoidFn();
    static NameFn load, save; static SetFn set; static VoidFn update;
    static readonly Regex ProfileName = new Regex(@"^[^\\/:*?""<>|]{1,200}\.exe$", RegexOptions.IgnoreCase);

    static T Fn<T>(IntPtr h, string n) where T : class {
        IntPtr p = GetProcAddress(h, n);
        if (p == IntPtr.Zero) throw new Exception("RTSSHooks64.dll has no export " + n);
        return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
    }

    static string Apply(string profile, uint limit, uint den, int mode) {
        // A game without its own profile starts from the global one, as when it's added in RTSS's UI.
        if (!load(profile) && !load("")) return "err Could not load the RTSS profile.";
        uint v = limit; if (!set("FramerateLimit", ref v, 4)) return "err RTSS rejected FramerateLimit.";
        v = Math.Max(1u, den); if (!set("FramerateLimitDenominator", ref v, 4)) return "err RTSS rejected FramerateLimitDenominator.";
        if (mode >= 0) { v = (uint)mode; if (!set("SyncLimiter", ref v, 4)) return "err RTSS rejected SyncLimiter."; }
        save(profile);   // return value isn't meaningful; SuperLay verifies by reading the profile file back
        update();
        return "ok";
    }

    static string Handle(string line, string token) {
        string[] f = line.Split('|');
        if (f.Length != 5 || f[0] != token) return "err Unauthorized.";
        uint limit, den; int mode;
        if (!ProfileName.IsMatch(f[1])) return "err Invalid profile name.";
        if (!uint.TryParse(f[2], out limit) || limit > 100000) return "err Invalid limit.";
        if (!uint.TryParse(f[3], out den) || den < 1 || den > 1000) return "err Invalid denominator.";
        if (!int.TryParse(f[4], out mode) || mode < -1 || mode > 2) return "err Invalid mode.";
        try { return Apply(f[1], limit, den, mode); } catch (Exception e) { return "err " + e.Message.Replace('\n', ' '); }
    }

    public static void Run(string dll, string pipe, string token, int parentPid) {
        IntPtr h = LoadLibrary(dll);
        if (h == IntPtr.Zero) throw new Exception("Could not load " + dll);
        load = Fn<NameFn>(h, "LoadProfile"); save = Fn<NameFn>(h, "SaveProfile");
        set = Fn<SetFn>(h, "SetProfileProperty"); update = Fn<VoidFn>(h, "UpdateProfiles");

        // Exit with SuperLay.
        var watcher = new Thread(() => {
            try { Process.GetProcessById(parentPid).WaitForExit(); } catch { }
            Environment.Exit(0);
        });
        watcher.IsBackground = true;
        watcher.Start();

        var sec = new PipeSecurity();
        sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        while (true) {
            using (var srv = new NamedPipeServerStream(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, sec)) {
                srv.WaitForConnection();
                try {
                    var r = new StreamReader(srv);
                    var w = new StreamWriter(srv);
                    w.AutoFlush = true;
                    string line;
                    while ((line = r.ReadLine()) != null) w.WriteLine(Handle(line.Trim(), token));
                } catch (IOException) { /* client went away */ }
            }
        }
    }
}
'@

[RtssBroker]::Run($Dll, $Pipe, $Token, $ParentPid)
