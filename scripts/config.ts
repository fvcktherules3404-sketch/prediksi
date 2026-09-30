const env = process.env;
// Liga yang diprediksi (ID API-Football). Ubah lewat env LEAGUE_IDS="39,140" atau ALL_LEAGUES=true
const DEFAULT_LEAGUES = [
  // URUTAN = PRIORITAS (dipakai untuk jatah odds): liga terbesar di atas.
  // top 5 Eropa + kompetisi klub Eropa + liga besar lain
  39,140,135,78,61,2,3,848,88,94,144,203,179,235,
  // Amerika & Asia populer untuk parlay
  71,128,253,262,98,292,307,274,188,169,13,11,17,
  // tim nasional: event besar, kualifikasi, friendly (10 = timnas, 667 = klub)
  1,4,5,6,9,22,29,30,31,32,33,34,35,36,10,667,
  // Asia: Gulf Cup (25), FIFA Asean Cup (1247)
  25,1247,
  // kasta 2-3 & piala domestik
  40,41,42,141,136,79,80,62,63,89,95,145,204,180,72,129,99,293,
  45,48,143,137,81,66,
  // liga Eropa lain (kasta 1)
  103,106,113,119,197,207,218,333,345,210,286,283,
  // Amerika lain
  239,265,242,268,281
];
export const CFG = {
  tzOffsetHours: 7,               // WIB
  windowStartHourWIB: 6,          // (lama, tidak dipakai lagi) diganti sesi di bawah
  // v4: dua sesi per hari. Sesi 'pagi' berjalan 06:00 WIB -> menjelang 21:00 (laga jam 19-20 ikut). Sesi 'malam' 21:00 -> 05:59 WIB.
  slotHoursWIB: { pagi: 6, malam: 21 },
  footballBase: 'https://v3.football.api-sports.io',
  dailyRequestLimit: Number(env.FOOTBALL_DAILY_LIMIT ?? 100), // free tier API-Football
  requestReserve: 8,              // sisa request yang tidak boleh dipakai
  maxStandingsRequests: 60,
  fixturesTtlH: 5, standingsTtlH: 20, maxStaleH: 72,
  // v4.1: default SEMUA liga (kecuali putra-junior/wanita/cadangan, lihat scripts/filter.ts). ALL_LEAGUES=false -> hanya DEFAULT_LEAGUES.
  allLeagues: env.ALL_LEAGUES !== 'false',
  leagues: env.LEAGUE_IDS ? env.LEAGUE_IDS.split(',').map(Number).filter(Boolean) : DEFAULT_LEAGUES,
  geminiModel: env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite', // jika 404, otomatis dicari lewat ListModels
  geminiBatchSize: 12, geminiMaxCalls: 8, // ringkasan AI untuk SEMUA laga (maks 96)
  useInjuries: env.USE_INJURIES !== 'false',  // endpoint injuries API-Football (1 request/tanggal)
  useNews: env.GEMINI_NEWS !== 'false',        // Gemini + Google Search: cedera/skorsing/susunan
  newsBatchSize: 5, newsMaxCalls: 4, newsTtlH: 6,
  dataDir: 'public/data', cacheDir: 'data/cache', resultsFile: 'data/results.json',
  // --- Sumber klasemen (prioritas: resmi football-data.org > API-Football standings (opsional) > hasil sendiri > Gemini) ---
  footballDataBase: 'https://api.football-data.org/v4', fdTtlH: 20,
  // ID liga API-Football -> kode kompetisi football-data.org (paket gratis)
  fdCompetitions: { 39: 'PL', 40: 'ELC', 140: 'PD', 135: 'SA', 78: 'BL1', 61: 'FL1', 88: 'DED', 94: 'PPL', 71: 'BSA', 2: 'CL', 4: 'EC', 1: 'WC' } as Record<number, string>,
  useApiStandings: env.USE_API_STANDINGS === 'true', // endpoint klasemen API-Football (paket gratis biasanya diblokir utk musim berjalan)
  // Paket gratis API-Football hanya boleh tanggal kemarin..besok -> lookback 1. Paket berbayar: set RESULT_LOOKBACK_DAYS=7 dst.
  resultLookbackDays: Number(env.RESULT_LOOKBACK_DAYS ?? 1),
  resultRefetchDays: Number(env.RESULT_REFETCH_DAYS ?? 1), // ambil ulang N hari terakhir tiap run (1 request/hari; menutup laga yang belum selesai saat pengambilan sebelumnya)
  backfillDays: Number(env.BACKFILL_DAYS ?? 5),      // isi data awal: berapa hari ke belakang saat results.json masih kosong
  maxResultDaysPerRun: 7,                            // maks hari yang dikumpulkan per run (hemat kuota)
  minOwnGames: 3,                                    // tim dengan hasil sendiri < ini dianggap "tipis" -> boleh dibantu Gemini
  geminiStandings: env.GEMINI_STANDINGS !== 'false', geminiStandingsMaxCalls: 4,
  // --- Opini kedua AI (Gemini + Google Search memprediksi mandiri, dibandingkan dengan pick rumus) ---
  useAiOpinion: env.AI_OPINION !== 'false', opinionBatchSize: 5, opinionMaxCalls: 4, opinionTtlH: 6,
  // --- Elo (ClubElo untuk klub, eloratings.net untuk tim nasional) ---
  useElo: env.USE_ELO !== 'false', eloTtlH: 20,
  eloShrinkK: 30,           // (backtest: 8 -> 30) bobot klasemen = laga/(laga+K); sisanya Elo. Tanpa klasemen -> 100% Elo
  eloSlope: 0.0018,         // (backtest: 0.0014 -> 0.0018) ln-rasio gol per poin Elo (200 poin ~ selisih ~0,8 gol pada total 2,7)
  // --- Kalibrasi hasil (seri) ---
  drawBoost: 0,             // (backtest: 0.08 -> 0; tuning memilih 0 di semua dataset) inflasi diagonal skor seri (Poisson cenderung meremehkan seri)
  rho: -0.07,               // (backtest: klub -0.04..-0.07, timnas -0.10) koreksi Dixon-Coles skor rendah
  tempoSpread: 0.2,         // ketidakpastian tempo laga (campuran 3 skenario) -> ekor gol lebih realistis
  eloOnlyPenalty: 0.85,     // (tidak dipakai lagi sejak rumus keyakinan v2; dibiarkan agar env lama tidak error)
  nationalLeagues: new Set<number>([1, 4, 5, 6, 9, 10, 22, 25, 29, 30, 31, 32, 33, 34, 35, 36, 1247]), // pakai eloratings.net (25 = Gulf Cup, 1247 = FIFA Asean Cup)
  neutralLeagues: new Set<number>([1, 4, 6, 9]),                              // turnamen final: tanpa keunggulan kandang
  noStandingsLeagues: new Set<number>([1, 4, 5, 6, 9, 10, 22, 25, 29, 30, 31, 32, 33, 34, 35, 36, 1247]), // turnamen antarnegara: lewati Gemini

  // --- v2: odds pasar sebagai sinyal (API-Football /odds, 1 request/laga, di-cache ringkas 6 jam) ---
  useOdds: env.USE_ODDS !== 'false', oddsTtlH: 6, oddsMaxRequests: Number(env.ODDS_MAX_REQUESTS ?? 30) /* per sesi (2 sesi/hari berbagi kuota 100); laga tanpa data tim tetap diprediksi dari odds bila kuota cukup */,
  marketWeight: 0.8,                 // (backtest: 0.6 -> 0.8; terbaik 1.0 pada odds penutupan, dikurangi agar aman) bobot pasar di ruang log (awal). Setelah cukup data, dituning otomatis oleh evaluate.ts
  sharpBooks: ['pinnacle'],          // bandar 'tajam' diberi bobot 3x saat merata-ratakan
  // --- v2: kalibrasi otomatis dari rekam jejak (public/data/calibration.json) ---
  calibrationFile: 'public/data/calibration.json',
  calMinN: 150,                      // min. laga dinilai sebelum temperatur (ketajaman) boleh diubah
  calMinMarketN: 60,                 // min. laga ber-odds sebelum bobot pasar boleh diubah
  tauMin: 0.85, tauMax: 1.25,        // batas temperatur probabilitas (>1 = lebih tajam, <1 = lebih landai)
  marketWMin: 0.2, marketWMax: 0.85,
  // --- v3: taruhan laga (tim mengejar target vs tim sudah aman) & fase musim. Diuji di backtest.ts bagian H (hold-out 30%) ---
  // Hasil: efek RELATIF (tim yang masih berebut juara/4 besar/degradasi lebih tajam daripada lawan yang tanpa target) memperbaiki log-loss 1X2 secara nyata
  // (-0.003 +/- 0.001) tanpa mengganggu Over/Under. Efek "akhir musim = gol lebih sedikit" TIDAK didukung data: memaksanya memperburuk Over/Under secara nyata
  // (model malah sedikit MEREMEHKAN gol di paruh akhir musim), jadi stakesPhase = 0. Ubah lewat env, jalankan ulang backtest sebelum mengubah default.
  stakesOn: env.STAKES !== 'false',
  stakesRel: Number(env.STAKES_REL ?? 0.2),        // efek relatif (total gol dijaga)
  stakesLevel: Number(env.STAKES_LEVEL ?? 0),      // efek level total gol (kedua tim berebut); 0 = tidak terbukti
  stakesPhase: Number(env.STAKES_PHASE ?? 0),      // elastisitas total gol vs progres musim; 0 = tidak terbukti (negatif = ditolak data)
  stakesNeed0: 0.741,                              // rata-rata "kebutuhan" di data latih (pusat untuk efek level)
  stakesMinPhase: 0.25,                            // sebelum 25% musim, tabel belum bermakna -> tanpa label & tanpa penyesuaian
  // Liga domestik kandang-tandang penuh (G = 2 x (N-1) laga). Liga dengan babak lanjutan/split/playoff/konferensi sengaja tidak dimasukkan.
  stakesLeagues: new Set<number>([39, 140, 135, 78, 61, 88, 94, 203, 71, 307, 274]),
  // --- v5: konteks laga (scripts/context.ts). Hanya kelelahan yang diuji backtest (bagian I); lainnya efek kecil & konservatif, BELUM tervalidasi. ---
  ctxFatigue: env.CTX_FATIGUE !== 'false', ctxFatigueRel: Number(env.CTX_FATIGUE_REL ?? 0), // backtest I (27.927 laga klub): TIDAK ada pengaruh nyata (terbaik di set latih = 0) -> hanya label, xG tidak diubah. Isi mis. 0.03 lalu jalankan ulang backtest sebelum memakainya
  ctxLeg2: env.CTX_LEG2 !== 'false', ctxLeg2K: Number(env.CTX_LEG2_K ?? 0.05),                    // per gol selisih agregat (dibatasi 2 gol)
  ctxFinal: env.CTX_FINAL !== 'false', ctxFinalGoals: 0.04, ctxFinalConf: 0.9,                    // final: total gol -4%, keyakinan x0,9
  ctxDerby: env.CTX_DERBY !== 'false', ctxDerbyConf: 0.93,                                        // derbi: hanya keyakinan yang dipotong
  ctxGroup: env.CTX_GROUP !== 'false', ctxGroupRel: Number(env.CTX_GROUP_REL ?? 0.12), ctxDeadConf: 0.9, // grup timnas: sudah lolos/gugur -> rotasi; keduanya tanpa taruhan -> keyakinan x0,9
  maxGroupStandings: 4,                                                                           // maks request klasemen grup timnas per run (1 request per turnamen/kualifikasi)
  // Turnamen timnas yang punya fase grup. Persahabatan (10) dan turnamen gugur murni tidak diambil. Kualifikasi & Nations League dianggap kandang-tandang (G = 2 x (N-1)) = konservatif.
  groupLeagues: new Set<number>([1, 4, 5, 6, 9, 22, 25, 29, 30, 31, 32, 33, 34, 35, 36, 1247]),
  groupRounds: { 1: 1, 4: 1, 6: 1, 9: 1, 22: 1, 25: 1, 1247: 1 } as Record<number, number>,   // 1 = sekali bertemu (fase grup turnamen), lainnya kandang-tandang
  groupSlots: { 1: 2, 4: 2, 6: 2, 9: 2, 22: 2, 25: 2, 1247: 2 } as Record<number, number>,   // slot lolos bila API tidak memberi deskripsi; tidak ada di sini -> default 2
  // --- v6: konteks laga dari AI (scripts/aiContext.ts). Gemini membaca hasil Tavily yang sudah ada (tanpa kredit/panggilan tambahan) lalu melaporkan rotasi, motivasi, kelelahan nyata, skor leg 1, derbi.
  //     Efek kecil & dibatasi; BELUM bisa di-backtest (tidak ada data historis). AI_CONTEXT=false mematikan; CTX_AI_SCALE=0 = hanya label (xG & keyakinan tidak berubah). ---
  ctxAi: env.AI_CONTEXT !== 'false', ctxAiScale: Number(env.CTX_AI_SCALE ?? 1),
  ctxAiMinSrc: 2,                                        // minimal sumber web agar sinyal AI dipercaya
  ctxAiRotHeavy: 0.05, ctxAiRotSome: 0.02, ctxAiLowMotive: 0.03, ctxAiTired: 0.015, // penurunan ln-xG tim per sinyal
  ctxAiMaxXg: 0.06,                                      // batas total penurunan ln-xG per tim (~ -5,8%)
  ctxAiConfStep: 0.04, ctxAiConfMin: 0.92,               // tiap tim dengan rotasi besar / motivasi rendah memotong keyakinan 4% (min. x0,92)
  ctxAiLegTrust: 0.7,                                    // skor leg 1 dari AI dipercaya 70% dibanding catatan sendiri (ctxLeg2K x 0,7)
  recentKeep: 4, recentMaxAgeDays: 21,                                                            // riwayat waktu laga per tim (untuk jeda/kelelahan) di data/results.json
  // --- v2: keyakinan ---
  aiAgreeBonus: 4, aiDisagreePenalty: 8, // opini AI sepakat/beda dengan pick (kecil; dituning manual setelah melihat calibration.json -> ai)
  friendlyLeagues: new Set<number>([10, 667]), friendlyConfFactor: 0.85, // laga persahabatan: rotasi & motivasi acak -> keyakinan dipotong
  // --- v4: prediksi utama & beranda ---
  homeTopN: 10,                      // beranda: maks. laga keyakinan tinggi
  homeMinShown: 5,                   // bila yang 'tinggi' kurang dari ini, beranda diisi laga terbaik berikutnya
  marketOnlyQualityFactor: 0.8,      // laga yang HANYA berdasar odds (tanpa klasemen/Elo): kualitas data dipotong
  headlineMinP: 0.6,                 // AH/O-U/BTTS baru dipilih jadi prediksi utama bila peluangnya >= ini
  cachePruneDays: 4,                 // hapus file cache lebih tua dari ini (mencegah repo membengkak)
};