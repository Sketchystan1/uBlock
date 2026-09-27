// version-shim.cpp — a version.dll proxy that makes a Windows Chromium browser
// treat the machine as domain-joined, so an off-store ExtensionInstallForcelist
// entry is honored instead of ignored. See README.md for the full trust chain.
//
// The spoof lives only in the launched browser's memory and dies with the DLL:
// nothing in the OS or the registry enrollment state changes. For local dev and
// sandboxed extension testing on a machine you own.
//
// No hooking library and no instruction decoder: nothing here calls the original
// bytes back, so no trampoline is needed. Exports and NetGetJoinInformation are
// redirected by overwriting their entry point with a jump; UpdateProcThreadAttribute
// is redirected by rewriting the import table slot, which hands us the real address.

#define NOMINMAX
#define _CRT_SECURE_NO_WARNINGS 1
#include <windows.h>
#include <lm.h>
#include <psapi.h>

#define DBG(msg) OutputDebugStringW(L"[netjoin] " msg)

#if defined(_M_X64)
#define JUMP_LEN 14   // FF 25 00000000 <addr64>   jmp qword ptr [rip+0]
#elif defined(_M_ARM64)
#define JUMP_LEN 16   // LDR x16,#8 ; BR x16 ; <addr64>
#else
#define JUMP_LEN 5    // E9 <rel32>
#endif

// ---------------------------------------------------------------------------
// The 17 version.dll exports. Each stub's entry point is overwritten at load with
// a jump to the real system version.dll, so the body is never executed — it only
// has to (a) stay at least JUMP_LEN bytes so WriteJump can't overrun into the next
// function and (b) stay byte-distinct so /OPT:ICF cannot fold two exports onto one
// address before we patch them. The volatile array seeded with a unique __COUNTER__
// guarantees both: the unique initializer defeats folding, the volatile stores keep
// the body large.
// ---------------------------------------------------------------------------

#define STUB(name) int name() { volatile int pad[8] = { __COUNTER__ }; return pad[0]; }

namespace hijack {
STUB(GetFileVersionInfoA)         STUB(GetFileVersionInfoByHandle)
STUB(GetFileVersionInfoExA)       STUB(GetFileVersionInfoExW)
STUB(GetFileVersionInfoSizeA)     STUB(GetFileVersionInfoSizeExA)
STUB(GetFileVersionInfoSizeExW)   STUB(GetFileVersionInfoSizeW)
STUB(GetFileVersionInfoW)         STUB(VerFindFileA)
STUB(VerFindFileW)                STUB(VerInstallFileA)
STUB(VerInstallFileW)             STUB(VerLanguageNameA)
STUB(VerLanguageNameW)            STUB(VerQueryValueA)
STUB(VerQueryValueW)
}  // namespace hijack

// Ordinals pinned to System32\version.dll so an ordinal import can't bind wrong.
#pragma comment(linker, "/export:GetFileVersionInfoA=?GetFileVersionInfoA@hijack@@YAHXZ,@1")
#pragma comment(linker, "/export:GetFileVersionInfoByHandle=?GetFileVersionInfoByHandle@hijack@@YAHXZ,@2")
#pragma comment(linker, "/export:GetFileVersionInfoExA=?GetFileVersionInfoExA@hijack@@YAHXZ,@3")
#pragma comment(linker, "/export:GetFileVersionInfoExW=?GetFileVersionInfoExW@hijack@@YAHXZ,@4")
#pragma comment(linker, "/export:GetFileVersionInfoSizeA=?GetFileVersionInfoSizeA@hijack@@YAHXZ,@5")
#pragma comment(linker, "/export:GetFileVersionInfoSizeExA=?GetFileVersionInfoSizeExA@hijack@@YAHXZ,@6")
#pragma comment(linker, "/export:GetFileVersionInfoSizeExW=?GetFileVersionInfoSizeExW@hijack@@YAHXZ,@7")
#pragma comment(linker, "/export:GetFileVersionInfoSizeW=?GetFileVersionInfoSizeW@hijack@@YAHXZ,@8")
#pragma comment(linker, "/export:GetFileVersionInfoW=?GetFileVersionInfoW@hijack@@YAHXZ,@9")
#pragma comment(linker, "/export:VerFindFileA=?VerFindFileA@hijack@@YAHXZ,@10")
#pragma comment(linker, "/export:VerFindFileW=?VerFindFileW@hijack@@YAHXZ,@11")
#pragma comment(linker, "/export:VerInstallFileA=?VerInstallFileA@hijack@@YAHXZ,@12")
#pragma comment(linker, "/export:VerInstallFileW=?VerInstallFileW@hijack@@YAHXZ,@13")
#pragma comment(linker, "/export:VerLanguageNameA=?VerLanguageNameA@hijack@@YAHXZ,@14")
#pragma comment(linker, "/export:VerLanguageNameW=?VerLanguageNameW@hijack@@YAHXZ,@15")
#pragma comment(linker, "/export:VerQueryValueA=?VerQueryValueA@hijack@@YAHXZ,@16")
#pragma comment(linker, "/export:VerQueryValueW=?VerQueryValueW@hijack@@YAHXZ,@17")

// Overwrite the entry point at `at` with a jump to `to`. The clobbered bytes are
// never run: our stubs are never called, and NetGetJoinInformation is synthesised.
static bool WriteJump(void* at, const void* to) {
  BYTE patch[JUMP_LEN] = {0};
#if defined(_M_X64)
  patch[0] = 0xFF; patch[1] = 0x25;
  *(const void**)(patch + 6) = to;
#elif defined(_M_ARM64)
  *(DWORD*)(patch + 0) = 0x58000050;   // ldr x16, #8
  *(DWORD*)(patch + 4) = 0xD61F0200;   // br  x16
  *(const void**)(patch + 8) = to;
#else
  patch[0] = 0xE9;
  *(INT32*)(patch + 1) = (INT32)((const BYTE*)to - ((const BYTE*)at + 5));
#endif
  DWORD old = 0;
  if (!VirtualProtect(at, JUMP_LEN, PAGE_EXECUTE_READWRITE, &old)) return false;
  memcpy(at, patch, JUMP_LEN);
  DWORD ignored = 0;
  VirtualProtect(at, JUMP_LEN, old, &ignored);
  FlushInstructionCache(GetCurrentProcess(), at, JUMP_LEN);
  return true;
}

// Redirect one import slot. Unlike the stubs, UpdateProcThreadAttribute does real
// work and must stay reachable — rewriting the IAT slot leaves the original address
// in `real`, so no trampoline is needed.
static void PatchModuleImport(HMODULE mod, const char* func, void* hook, void* real) {
  BYTE* base = (BYTE*)mod;
  auto dos = (IMAGE_DOS_HEADER*)base;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
  auto nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) return;
  auto& dir = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
  if (!dir.VirtualAddress) return;

  for (auto imp = (IMAGE_IMPORT_DESCRIPTOR*)(base + dir.VirtualAddress); imp->Name; imp++) {
    // OriginalFirstThunk is the name table; FirstThunk is the slot called through.
    // Some linkers omit the former, in which case they coincide.
    auto names = (IMAGE_THUNK_DATA*)(base + (imp->OriginalFirstThunk
                                             ? imp->OriginalFirstThunk : imp->FirstThunk));
    auto slots = (IMAGE_THUNK_DATA*)(base + imp->FirstThunk);
    for (; names->u1.AddressOfData; names++, slots++) {
      if (names->u1.Ordinal & IMAGE_ORDINAL_FLAG) continue;
      auto byName = (IMAGE_IMPORT_BY_NAME*)(base + names->u1.AddressOfData);
      if (lstrcmpA((LPCSTR)byName->Name, func) != 0) continue;
      if ((void*)slots->u1.Function == hook) return;              // already patched
      if (real && (void*)slots->u1.Function != real) continue;    // someone else owns it
      DWORD old = 0;
      if (!VirtualProtect(&slots->u1.Function, sizeof(void*), PAGE_READWRITE, &old)) continue;
      slots->u1.Function = (ULONG_PTR)hook;
      DWORD ignored = 0;
      VirtualProtect(&slots->u1.Function, sizeof(void*), old, &ignored);
      return;
    }
  }
}

static void PatchAllModules(const char* func, void* hook, void* real) {
  HMODULE mods[512];
  DWORD needed = 0;
  if (!EnumProcessModules(GetCurrentProcess(), mods, sizeof(mods), &needed)) return;
  DWORD count = needed / (DWORD)sizeof(HMODULE);
  if (count > 512) count = 512;
  for (DWORD i = 0; i < count; i++) PatchModuleImport(mods[i], func, hook, real);
}

// Resolved with GetProcAddress, not &UpdateProcThreadAttribute: taking the address
// of an imported function yields an import thunk, so the IAT comparison would never
// match and calling through it would recurse into our own hook via the patched slot.
using UpdateProcThreadAttributeFn = BOOL(WINAPI*)(LPPROC_THREAD_ATTRIBUTE_LIST, DWORD,
                                                  DWORD_PTR, PVOID, SIZE_T, PVOID, PSIZE_T);
static UpdateProcThreadAttributeFn RealUpdateProcThreadAttribute = nullptr;

// chrome.dll stamps BlockNonMicrosoftBinaries (bit 44; bit 45 is its audit variant)
// into child processes, which would then refuse to map this unsigned DLL and die
// with STATUS_INVALID_IMAGE_HASH. Clearing the bits here — before the call reaches
// the kernel — keeps the children alive. This is the only kernel API worth hooking.
static BOOL WINAPI MyUpdateProcThreadAttribute(
    LPPROC_THREAD_ATTRIBUTE_LIST list, DWORD flags, DWORD_PTR attr,
    PVOID value, SIZE_T size, PVOID prev, PSIZE_T ret) {
  if (attr == PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY && value && size >= sizeof(DWORD64))
    *(DWORD64*)value &= ~((1ui64 << 44) | (1ui64 << 45));
  return RealUpdateProcThreadAttribute(list, flags, attr, value, size, prev, ret);
}

// chrome.dll / msedge.dll aren't loaded yet when this DLL starts, and children
// spawn seconds later, so retry the patch briefly. Patching a patched slot is a
// no-op; failing to land is no worse than not hooking.
static DWORD WINAPI PatchLoop(LPVOID) {
  for (int i = 0; i < 60; i++) {   // ~1.5s total
    if (RealUpdateProcThreadAttribute)
      PatchAllModules("UpdateProcThreadAttribute",
                      (void*)MyUpdateProcThreadAttribute, (void*)RealUpdateProcThreadAttribute);
    Sleep(25);
  }
  return 0;
}

// Report the machine as domain-joined. The reply is synthesised, not delegated:
// the caller's NetApiBufferFree works because the name uses the matching allocator,
// and the only field compiled-in Chromium reads is the join type.
using NetApiBufferAllocateFn = NET_API_STATUS(WINAPI*)(DWORD, LPVOID*);
static NetApiBufferAllocateFn pNetApiBufferAllocate = nullptr;

static NET_API_STATUS WINAPI HookNetGetJoinInformation(
    LPCWSTR server, LPWSTR* nameBuf, PNETSETUP_JOIN_STATUS type) {
  if (type) *type = NetSetupDomainName;
  if (nameBuf) {
    *nameBuf = nullptr;
    LPWSTR mock = nullptr;
    if (pNetApiBufferAllocate &&
        pNetApiBufferAllocate((DWORD)sizeof(L"WORKGROUP"), (LPVOID*)&mock) == NERR_Success && mock) {
      lstrcpyW(mock, L"WORKGROUP");
      *nameBuf = mock;
    }
  }
  return NERR_Success;
}

static void InstallNetJoinHook() {
  HMODULE net = LoadLibraryW(L"netapi32.dll");
  if (!net) { DBG(L"netapi32 load failed"); return; }
  pNetApiBufferAllocate = (NetApiBufferAllocateFn)GetProcAddress(net, "NetApiBufferAllocate");
  // netapi32 only re-exports this from wkscli, so the jump lands on wkscli's code
  // and catches every caller regardless of how it resolved the symbol.
  void* target = (void*)GetProcAddress(net, "NetGetJoinInformation");
  if (!target) { DBG(L"NetGetJoinInformation not found"); return; }
  if (!WriteJump(target, (void*)HookNetGetJoinInformation)) DBG(L"netjoin hook failed");
}

// Point each of our exports at the matching function in the real System32 version.dll.
static void ForwardExports(HMODULE self) {
  BYTE* base = (BYTE*)self;
  auto dos = (IMAGE_DOS_HEADER*)base;
  if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
  auto nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
  if (nt->Signature != IMAGE_NT_SIGNATURE) return;
  auto exp = (IMAGE_EXPORT_DIRECTORY*)(base +
      nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_EXPORT].VirtualAddress);
  DWORD* rvaNames = (DWORD*)(base + exp->AddressOfNames);
  DWORD* rvaFuncs = (DWORD*)(base + exp->AddressOfFunctions);
  WORD*  ordinals = (WORD*)(base + exp->AddressOfNameOrdinals);

  wchar_t sys[MAX_PATH + 16];
  if (!GetSystemDirectoryW(sys, MAX_PATH)) return;
  lstrcatW(sys, L"\\version.dll");
  HMODULE real = LoadLibraryExW(sys, nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!real) { DBG(L"system version.dll load failed"); return; }

  for (DWORD i = 0; i < exp->NumberOfNames; i++) {
    void* target = (void*)GetProcAddress(real, (char*)(base + rvaNames[i]));
    if (target) WriteJump(base + rvaFuncs[ordinals[i]], target);
  }
}

// Children (--type=...) never evaluate enterprise policy, so leave netapi32 alone
// there. The leading space keeps a URL or --app= argument that contains "--type="
// from being mistaken for the switch.
static bool IsBrowserProcess() {
  LPCWSTR cmd = GetCommandLineW();
  return !cmd || !wcsstr(cmd, L" --type=");
}

BOOL WINAPI DllMain(HINSTANCE hModule, DWORD reason, LPVOID) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  DisableThreadLibraryCalls(hModule);
  // Synchronous on purpose: chrome_elf.dll touches version APIs from its own DllMain,
  // so a lazy installer could block on the loader lock it is already under.
  __try {
    ForwardExports(hModule);
    if (IsBrowserProcess()) InstallNetJoinHook();

    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    RealUpdateProcThreadAttribute =
        (UpdateProcThreadAttributeFn)GetProcAddress(k32, "UpdateProcThreadAttribute");
    if (RealUpdateProcThreadAttribute) {
      HANDLE t = CreateThread(nullptr, 0, PatchLoop, nullptr, 0, nullptr);
      if (t) CloseHandle(t);
    }
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    DBG(L"install faulted");
  }
  return TRUE;
}
