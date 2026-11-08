/* Pusat konfigurasi XBypass.
   Menambah provider baru: (1) buat api/bypass-xxx.js, (2) tambah satu object di BYPASS_PROVIDERS, (3) taruh logo di assets/logo-bypass/.
   Semua nama provider & label proses di UI dibaca dari sini. */

export const BYPASS_PROVIDERS = [
  {
    id: "sub2unlock-me",
    name: "Sub2Unlock.me",
    domains: ["sub2unlock.me"],
    endpoint: "/api/bypass-sub2unlock-me",
    processingLabel: "Sub2Unlock-me",
    icon: "/assets/logo-bypass/sub2unlock.webp",
    enabled: true
  },
  {
    id: "sub2unlock-io",
    name: "Sub2Unlock.io",
    domains: ["sub2unlock.io"],
    endpoint: "/api/bypass-sub2unlock-io",
    processingLabel: "Sub2Unlock-io",
    icon: "/assets/logo-bypass/sub2unlock-io.png",
    enabled: true
  },
  {
    id: "Bicolink",
    name: "Bicolink.com",
    domains: ["bicolink.com"],
    endpoint: "/api/bypass-bicolink",
    processingLabel: "Bicolink",
    icon: "/assets/logo-bypass/bicolink.jpg",
    enabled: true
  },
  {
    id: "pastelink",
    name: "pastelink.net",
    domains: ["pastelink.net"],
    endpoint: "/api/bypass-pastelink",
    processingLabel: "Pastelink",
    icon: "/assets/logo-bypass/pastelink.png",
    enabled: true
  },
  {
    id: "Pastelink-id",
    name: "Pastelink.id",
    domains: ["pastelink.id"],
    endpoint: "/api/bypass-pastelink-id",
    processingLabel: "Pastelink-id",
    icon: "/assets/logo-bypass/pastelink-id.png",
    enabled: true
  },
  {
    id: "shrinkme",
    name: "shrinkme.io",
    domains: ["shrinkme.io"],
    endpoint: "/api/bypass-shrinkme",
    processingLabel: "Shrinkme",
    icon: "/assets/logo-bypass/shrinkme.jpg",
    enabled: true
  },
  {
    id: "safelinku",
    name: "SFL",
    domains: ["safelinku.com"],
    endpoint: "/api/bypass-sfl",
    processingLabel: "Safelinku",
    icon: "/assets/logo-bypass/safelinku.png",
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
    id: "sub4unlock-id",
    name: "Sub4unlock.id",
    domains: ["sub4unlock.id"],
    endpoint: "/api/bypass-sub4unlock-id",
    processingLabel: "Sub4Unlock-id",
    icon: "/assets/logo-bypass/sub4unlock-id.webp",
    enabled: true
  },
  {
    id: "sub4unlock-pro",
    name: "Sub4Unlock-pro",
    domains: ["sub4unlock.pro"],
    endpoint: "/api/bypass-sub4unlock-pro",
    processingLabel: "Sub4Unlock-pro",
    icon: "/assets/logo-bypass/sub4unlock-pro.png",
    enabled: true
  },
  {
    id: "sub4unlock-com",
    name: "Sub4Unlock.com",
    domains: ["sub4unlock.com"],
    endpoint: "/api/bypass-sub4unlock-com",
    processingLabel: "Sub4Unlock",
    icon: "/assets/logo-bypass/sub4unlock.png",
    enabled: true
  },
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
