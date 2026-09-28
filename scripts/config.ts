const env = process.env;
// Liga yang diprediksi (ID API-Football). Ubah lewat env LEAGUE_IDS="39,140" atau ALL_LEAGUES=true
const DEFAULT_LEAGUES = [39,40,140,135,78,61,88,94,144,179,203,2,3,848,1,4,5,6,9,10,17,253,307,274,71,128,98,292];
export const CFG = {
  tzOffsetHours: 7,               // WIB
  windowStartHourWIB: 6,          // 06:00 WIB
  footballBase: 'https://v3.football.api-sports.io',
  dailyRequestLimit: Number(env.FOOTBALL_DAILY_LIMIT ?? 100), // free tier API-Football
  requestReserve: 8,              // sisa request yang tidak boleh dipakai
  maxStandingsRequests: 60,
  fixturesTtlH: 5, standingsTtlH: 20, maxStaleH: 72,
  allLeagues: env.ALL_LEAGUES === 'true',
  leagues: env.LEAGUE_IDS ? env.LEAGUE_IDS.split(',').map(Number).filter(Boolean) : DEFAULT_LEAGUES,
  geminiModel: env.GEMINI_MODEL ?? 'gemini-flash-latest', // jika 404, otomatis dicari lewat ListModels
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
  backfillDays: Number(env.BACKFILL_DAYS ?? 5),      // isi data awal: berapa hari ke belakang saat results.json masih kosong
  maxResultDaysPerRun: 7,                            // maks hari yang dikumpulkan per run (hemat kuota)
  minOwnGames: 3,                                    // tim dengan hasil sendiri < ini dianggap "tipis" -> boleh dibantu Gemini
  geminiStandings: env.GEMINI_STANDINGS !== 'false', geminiStandingsMaxCalls: 4,
  // --- Elo (ClubElo untuk klub, eloratings.net untuk tim nasional) ---
  useElo: env.USE_ELO !== 'false', eloTtlH: 20,
  eloShrinkK: 8,            // bobot klasemen = laga/(laga+K); sisanya Elo. Tanpa klasemen -> 100% Elo
  eloSlope: 0.0014,         // ln-rasio gol per poin Elo (200 poin ~ selisih ~0,8 gol pada total 2,7)
  // --- Kalibrasi hasil (seri) ---
  drawBoost: 0.08,          // inflasi diagonal skor seri (Poisson cenderung meremehkan seri)
  rho: -0.10,               // koreksi Dixon-Coles skor rendah
  tempoSpread: 0.2,         // ketidakpastian tempo laga (campuran 3 skenario) -> ekor gol lebih realistis
  eloOnlyPenalty: 0.85,     // Elo-saja sedikit lebih rendah keyakinannya daripada klasemen+Elo
  nationalLeagues: new Set<number>([1, 4, 5, 6, 9, 10, 32, 33, 34, 35, 36]), // pakai eloratings.net
  neutralLeagues: new Set<number>([1, 4, 6, 9]),                              // turnamen final: tanpa keunggulan kandang
  noStandingsLeagues: new Set<number>([1, 4, 5, 6, 9, 10, 32, 33, 34, 35, 36]), // turnamen antarnegara: lewati Gemini
};
