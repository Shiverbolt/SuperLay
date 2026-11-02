# Writes a frame-rate cap into an RTSS profile through RTSS's own profile API (RTSSHooks64.dll),
# the same calls MSI Afterburner uses. Runs elevated: RTSS keeps its profiles under Program Files.
# The result goes to -Result as JSON because an elevated process can't pipe stdout back to SuperLay.
param(
  [Parameter(Mandatory)] [string]$Dll,
  [Parameter(Mandatory)] [string]$ProfileName,
  [Parameter(Mandatory)] [int]$Limit,
  [int]$Denominator = 1,
  [int]$Mode = -1,
  [Parameter(Mandatory)] [string]$Result
)
$ErrorActionPreference = 'Stop'

function Done($ok, $msg) {
  @{ ok = $ok; message = $msg } | ConvertTo-Json -Compress | Set-Content -LiteralPath $Result -Encoding UTF8
  exit ([int](-not $ok))
}

try {
  Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class RtssApi {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string p);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr m, string n);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate bool NameFn([MarshalAs(UnmanagedType.LPStr)] string p);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate bool SetFn([MarshalAs(UnmanagedType.LPStr)] string n, ref uint v, uint size);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void VoidFn();
  static NameFn load, save; static SetFn set; static VoidFn update;
  static T Fn<T>(IntPtr h, string n) where T : class {
    IntPtr p = GetProcAddress(h, n);
    if (p == IntPtr.Zero) throw new Exception("RTSSHooks64.dll has no export " + n);
    return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
  }
  public static void Init(string dll) {
    IntPtr h = LoadLibrary(dll);
    if (h == IntPtr.Zero) throw new Exception("Could not load " + dll + " (" + Marshal.GetLastWin32Error() + ")");
    load = Fn<NameFn>(h, "LoadProfile"); save = Fn<NameFn>(h, "SaveProfile");
    set = Fn<SetFn>(h, "SetProfileProperty"); update = Fn<VoidFn>(h, "UpdateProfiles");
  }
  public static bool Load(string p) { return load(p); }
  public static bool Save(string p) { return save(p); }
  public static bool Set(string n, uint v) { return set(n, ref v, 4); }
  public static void Update() { update(); }
}
'@
  [RtssApi]::Init($Dll)
  # A game without its own profile starts from the global one, as it does when added in RTSS's UI.
  if (-not [RtssApi]::Load($ProfileName)) {
    if (-not [RtssApi]::Load('')) { Done $false 'Could not load the RTSS global profile.' }
  }
  if (-not [RtssApi]::Set('FramerateLimit', [uint32]$Limit)) { Done $false 'RTSS rejected FramerateLimit.' }
  if (-not [RtssApi]::Set('FramerateLimitDenominator', [uint32][Math]::Max(1, $Denominator))) { Done $false 'RTSS rejected FramerateLimitDenominator.' }
  if ($Mode -ge 0 -and -not [RtssApi]::Set('SyncLimiter', [uint32]$Mode)) { Done $false 'RTSS rejected SyncLimiter.' }
  # SaveProfile's return value isn't meaningful (it reports failure after writing successfully);
  # SuperLay verifies by reading the profile file back instead.
  [void][RtssApi]::Save($ProfileName)
  [RtssApi]::Update()
  Done $true 'Saved.'
} catch {
  Done $false $_.Exception.Message
}
