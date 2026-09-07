/**
 * The two online features: the worldwide leaderboard, and photo reports.
 *
 * Both are optional. With no Supabase project configured the game still works
 * end to end — scores go to a local high-score table, and a photo you report
 * is hidden for you on this device. Configure a project and the same calls
 * reach everybody.
 *
 * Everything read back from the network is other people's input. It is
 * returned as plain data and rendered with textContent, never as markup.
 */
const Backend = (function () {
  "use strict";

  const CFG = typeof BEACH_GUESSER_CONFIG !== "undefined" ? BEACH_GUESSER_CONFIG : {};
  const TIMEOUT_MS = 8000;

  const KEYS = {
    best: "beachguesser.best",
    localScores: "beachguesser.scores",
    blocked: "beachguesser.blocked",
    name: "beachguesser.name"
  };
  // Keys used before the game was renamed from Wave Guesser.
  const LEGACY = { "beachguesser.best": "waveguesser.best" };

  const configured = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);

  /* ------------------------------------------------------------------ */
  /* local storage helpers (every one of these can throw)                */
  /* ------------------------------------------------------------------ */

  function read(key, fallback) {
    try {
      let raw = localStorage.getItem(key);
      if (raw === null && LEGACY[key]) raw = localStorage.getItem(LEGACY[key]);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;   // private browsing, quota, or storage disabled
    }
  }

  /* ------------------------------------------------------------------ */
  /* supabase REST (no SDK needed — PostgREST speaks plain HTTP)         */
  /* ------------------------------------------------------------------ */

  async function rest(path, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(CFG.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/" + path, {
        method: (options && options.method) || "GET",
        signal: controller.signal,
        headers: Object.assign({
          apikey: CFG.supabaseAnonKey,
          Authorization: "Bearer " + CFG.supabaseAnonKey,
          "Content-Type": "application/json"
        }, (options && options.headers) || {}),
        body: options && options.body ? JSON.stringify(options.body) : undefined
      });
      if (!res.ok) {
        throw new Error("supabase " + res.status + ": " + (await res.text()).slice(0, 200));
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* names                                                               */
  /* ------------------------------------------------------------------ */

  /** Trimmed, length-capped, control characters stripped. */
  function cleanName(raw) {
    return String(raw == null ? "" : raw)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 20);
  }

  function rememberedName() { return cleanName(read(KEYS.name, "")); }
  function rememberName(name) { write(KEYS.name, cleanName(name)); }

  /* ------------------------------------------------------------------ */
  /* leaderboard                                                         */
  /* ------------------------------------------------------------------ */

  /** Local table, kept per round-length so 3s and 10s are never compared. */
  function localScores(rounds) {
    const all = read(KEYS.localScores, []);
    return all
      .filter((s) => s && s.rounds === rounds && typeof s.score === "number")
      .sort((a, b) => b.score - a.score)
      .slice(0, CFG.leaderboardSize || 20);
  }

  function addLocalScore(entry) {
    const all = read(KEYS.localScores, []).filter((s) => s && typeof s.score === "number");
    all.push(entry);
    // Keep the table from growing without bound on a well-used device.
    write(KEYS.localScores, all.sort((a, b) => b.score - a.score).slice(0, 200));
  }

  /**
   * Records a finished game. Always stores locally; also publishes to the
   * shared board when one is configured. Never rejects — a leaderboard being
   * unreachable must not interrupt the end of a game.
   */
  async function submitScore(entry) {
    const record = {
      name: cleanName(entry.name) || "Anonymous",
      score: Math.max(0, Math.round(entry.score)),
      rounds: entry.rounds,
      created_at: new Date().toISOString()
    };
    rememberName(record.name);
    addLocalScore(record);

    if (!configured) return { published: false, reason: "no-backend" };
    try {
      await rest("scores", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: { name: record.name, score: record.score, rounds: record.rounds }
      });
      return { published: true };
    } catch (err) {
      console.warn("leaderboard submit failed", err);
      return { published: false, reason: "error", error: err };
    }
  }

  /**
   * Top scores for a round length. Returns { scope: "world" | "device", rows }
   * so the UI can be honest about which board it is showing.
   */
  async function topScores(rounds) {
    if (configured) {
      try {
        const rows = await rest("scores?select=name,score,rounds,created_at" +
          "&rounds=eq." + encodeURIComponent(rounds) +
          "&order=score.desc,created_at.asc" +
          "&limit=" + (CFG.leaderboardSize || 20));
        return {
          scope: "world",
          rows: (rows || []).map((r) => ({
            name: cleanName(r.name) || "Anonymous",
            score: Number(r.score) || 0,
            rounds: Number(r.rounds) || rounds,
            created_at: r.created_at
          }))
        };
      } catch (err) {
        console.warn("leaderboard fetch failed", err);
        return { scope: "device", rows: localScores(rounds), degraded: true };
      }
    }
    return { scope: "device", rows: localScores(rounds) };
  }

  /* ------------------------------------------------------------------ */
  /* photo reports                                                       */
  /* ------------------------------------------------------------------ */

  const REASONS = [
    { id: "not_this_beach", label: "Not this beach" },
    { id: "gives_it_away", label: "Gives the answer away" },
    { id: "not_a_beach", label: "Not a beach photo" },
    { id: "bad_image", label: "Broken or unsuitable" }
  ];

  let blockedRemote = new Set();
  const blockedLocal = new Set(read(KEYS.blocked, []));

  function isBlocked(fileTitle) {
    return blockedLocal.has(fileTitle) || blockedRemote.has(fileTitle);
  }

  function blockLocally(fileTitle) {
    blockedLocal.add(fileTitle);
    write(KEYS.blocked, Array.from(blockedLocal));
  }

  /**
   * Fetches the shared block list once at start-up. Photos that enough people
   * have reported stop being served to anybody.
   */
  async function loadBlocked() {
    if (!configured) return 0;
    try {
      const rows = await rest("blocked_photos?select=file_title");
      blockedRemote = new Set((rows || []).map((r) => String(r.file_title)));
      return blockedRemote.size;
    } catch (err) {
      console.warn("block list fetch failed", err);
      return 0;
    }
  }

  /** Hides the photo for this player immediately, and files a shared report. */
  async function reportPhoto(report) {
    blockLocally(report.fileTitle);
    if (!configured) return { published: false, reason: "no-backend" };
    try {
      await rest("photo_reports", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: {
          file_title: String(report.fileTitle).slice(0, 300),
          beach: String(report.beach || "").slice(0, 120),
          reason: REASONS.some((r) => r.id === report.reason) ? report.reason : "bad_image"
        }
      });
      return { published: true };
    } catch (err) {
      console.warn("photo report failed", err);
      return { published: false, reason: "error", error: err };
    }
  }

  return {
    KEYS: KEYS,
    REASONS: REASONS,
    isConfigured: function () { return configured; },
    read: read,
    write: write,
    cleanName: cleanName,
    rememberedName: rememberedName,
    submitScore: submitScore,
    topScores: topScores,
    loadBlocked: loadBlocked,
    reportPhoto: reportPhoto,
    isBlocked: isBlocked
  };
})();
