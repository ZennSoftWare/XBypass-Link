/* Pusat konfigurasi XBypass.
   Menambah provider baru: (1) buat api/bypass-xxx.js, (2) tambah satu object di BYPASS_PROVIDERS, (3) taruh logo di assets/logo-bypass/.
   Semua nama provider & label proses di UI dibaca dari sini. */

export const BYPASS_PROVIDERS = [
  {
    id: "sub2unlock.me",
    name: "Sub2Unlock.me",
    domains: ["sub2unlock.me"],
    endpoint: "/api/bypass-sub2unlock",
    processingLabel: "Sub2Unlock",
    icon: "/assets/logo-bypass/sub2unlock.png",
    enabled: true
  },
  {
    id: "sub4unlock",
    name: "Sub4Unlock",
    domains: ["sub4unlock.pro", "sub4unlock.id", "sub4unlock.com"],
    endpoint: "/api/bypass-sub4unlock",
    processingLabel: "Sub4Unlock",
    icon: "/assets/logo-bypass/sub4unlock.png",
    enabled: true
  },
  {
    id: "sfl",
    name: "SFL",
    domains: ["sfl.gl"],
    endpoint: "/api/bypass-sfl",
    processingLabel: "Safelink",
    icon: "/assets/logo-bypass/sfl.png",
    enabled: true
  },
  {
    id: "linkvertise",
    name: "Linkvertise",
    domains: ["linkvertise.com"],
    endpoint: "/api/bypass-linkvertise",
    processingLabel: "Linkvertise",
    icon: "/assets/logo-bypass/linkvertise.png",
    enabled: true
  },
  {
    id: "shrinkme",
    name: "ShrinkMe",
    domains: ["shrinkme.click"],
    endpoint: "/api/bypass-shrinkme",
    processingLabel: "ShrinkMe",
    icon: "/assets/logo-bypass/shrinkme.png",
    enabled: true
  },
  {
    id: "paste",
    name: "Paste",
    domains: ["paste.link", "pastelink.net"],
    endpoint: "/api/bypass-paste",
    processingLabel: "Paste Link",
    icon: "/assets/logo-bypass/paste.png",
    enabled: true
  }
];

/* Lima tahapan. {provider} diganti processingLabel provider yang cocok. */
export const BYPASS_STAGES = {
  providerFallback: "Provider",
  items: [
    { id: "read",     icon: "read",   label: "Membaca URL" },
    { id: "validate", icon: "shield", label: "Memvalidasi URL" },
    { id: "connect",  icon: "server", label: "Menghubungkan Server" },
    { id: "process",  icon: "bolt",   label: "Memproses {provider}" },
    { id: "result",   icon: "unlock", label: "Bypass Berhasil", failLabel: "Bypass Gagal" }
  ]
};

export const BYPASS_SETTINGS = {
  timeoutMs: 25000,     // batas waktu request
  stepDelayMs: 280,     // jeda visual untuk tahap lokal (membaca & validasi)
  toastMs: 2600,
  maxDots: 56,          // batas partikel background
  dotSpeed: 9,          // px/detik
  marqueeSpeed: 34      // px/detik
};

export const BYPASS_MESSAGES = {
  EMPTY_URL: "Link masih kosong. Tempel atau ketik link terlebih dahulu.",
  INVALID_URL: "Format link tidak valid. Gunakan alamat yang diawali http:// atau https://.",
  UNSUPPORTED_DOMAIN: "Domain ini belum didukung. Cek daftar Bypass yang Didukung di bawah.",
  PROVIDER_DISABLED: "Provider untuk domain ini sedang dinonaktifkan.",
  API_UNAVAILABLE: "API belum terintegrasi untuk provider ini.",
  NETWORK_ERROR: "Koneksi terputus atau server tidak dapat dijangkau.",
  TIMEOUT: "Permintaan melewati batas waktu. Coba lagi.",
  HTTP_ERROR: "Server mengembalikan status {status}.",
  INVALID_JSON: "Respons server bukan JSON yang valid.",
  INVALID_RESPONSE: "Format respons server tidak dikenali.",
  NO_TARGET_URL: "Respons sukses, tetapi tidak berisi link tujuan.",
  INVALID_TARGET: "Link tujuan dari server bukan URL http/https yang valid.",
  BYPASS_FAILED: "URL gagal diproses.",
  UNKNOWN: "Terjadi kesalahan tak terduga."
};
