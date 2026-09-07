/**
 * Wave Guesser — round flow, timer, scoring and the two Leaflet maps.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* config                                                            */
  /* ---------------------------------------------------------------- */

  // A round runs in two phases: study the photo, then place the pin.
  // The player can end the look phase early with "go to the map".
  const LOOK_SECONDS = 60;
  const GUESS_SECONDS = 30;
  const MAX_POINTS = 5000;
  const PERFECT_KM = 25;          // anything this close is a bullseye
  const DECAY_KM = 1500;          // how fast points fall off with distance
  const MIN_SEPARATION_KM = 100;  // keep two rounds from being the same place
  const BEST_KEY = "waveguesser.best";
  const WORLD_VIEW = [[-58, -172], [74, 178]];  // skips the empty polar bands

  const TILES = {
    on: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    },
    off: {
      url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
    }
  };

  /* ---------------------------------------------------------------- */
  /* dom                                                               */
  /* ---------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);
  const screens = {
    start: $("screen-start"),
    loading: $("screen-loading"),
    play: $("screen-play"),
    reveal: $("screen-reveal"),
    final: $("screen-final")
  };

  const el = {
    play: $("btn-play"), loadBar: $("load-bar"), loadStatus: $("load-status"),
    loadTitle: $("loading-title"), loadCancel: $("btn-load-cancel"),
    photo: $("photo"), photoCredit: $("photo-credit"), photoNav: $("photo-nav"),
    photoPrev: $("photo-prev"), photoNext: $("photo-next"), photoCount: $("photo-count"),
    roundPill: $("round-pill"), timer: $("timer"), timerRing: $("timer-ring"),
    timerNum: $("timer-num"), scoreTotal: $("score-total"),
    timerLabel: $("timer-label"), toMap: $("btn-to-map"), peek: $("stage-peek"),
    mappanel: $("mappanel"), mapToggle: $("map-toggle"),
    guessHint: $("guess-hint"), guessBtn: $("btn-guess"),
    revealEyebrow: $("reveal-eyebrow"), revealName: $("reveal-name"),
    revealCountry: $("reveal-country"), revealPoints: $("reveal-points"),
    revealDistance: $("reveal-distance"), revealFact: $("reveal-fact"),
    revealCredit: $("reveal-credit"), revealThumb: $("reveal-thumb"),
    nextBtn: $("btn-next"),
    finalPoints: $("final-points"), finalMax: $("final-max"),
    finalRank: $("final-rank"), breakdown: $("breakdown"),
    again: $("btn-again"), home: $("btn-home"), best: $("best-line"),
    poolNote: $("pool-note"),
    toast: $("toast"),
    // Challenge (shared-seed multiplayer) controls.
    invite: $("invite"),
    createChallenge: $("btn-create-challenge"),
    joinToggle: $("btn-join-toggle"),
    joinRow: $("join-row"), joinCode: $("join-code"), joinBtn: $("btn-join"),
    shareBox: $("share-box"), shareCode: $("share-code"),
    copyLink: $("btn-copy-link"), copyCode: $("btn-copy-code"),
    finalShare: $("final-share"), finalCode: $("final-code"),
    copyResult: $("btn-copy-result"), copyChallenge: $("btn-copy-challenge")
  };

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  const settings = { rounds: 5, labels: "on" };

  // When a challenge is active every player draws the same beaches in the same
  // order from a shared seed. null means an ordinary random game.
  let challenge = null; // { code, seed, rounds, labels }

  let game = null;      // { beaches, results, index, total }
  let round = null;     // { beach, photos, photoIndex, guess, deadline }
  let ticker = null;
  let loadAbandoned = false;

  let guessMap = null, resultMap = null;
  let guessLayer = null, guessMarker = null;
  let resultBase = null, resultLayer = null;
  let framing = false;     // true while we move the map ourselves
  let playerFramed = false; // the player has zoomed/panned, so stop auto-framing

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  function show(name) {
    Object.values(screens).forEach((s) => s.classList.remove("is-active"));
    screens[name].classList.add("is-active");
  }

  function toast(message, ms) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.toast.hidden = true; }, ms || 4200);
  }

  const rad = (d) => (d * Math.PI) / 180;

  /** Great-circle distance in km. */
  function distanceKm(a, b) {
    const R = 6371;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function scoreFor(km) {
    if (km <= PERFECT_KM) return MAX_POINTS;
    return Math.round(MAX_POINTS * Math.exp(-km / DECAY_KM));
  }

  function formatDistance(km) {
    if (km < 1) return Math.round(km * 1000) + " m";
    if (km < 100) return km.toFixed(1) + " km";
    return Math.round(km).toLocaleString() + " km";
  }

  const nf = (n) => n.toLocaleString();

  /** Leaflet lets you pan past the date line; fold the guess back on to Earth. */
  function normalise(latlng) {
    let lng = ((latlng.lng + 180) % 360 + 360) % 360 - 180;
    return { lat: latlng.lat, lng: lng };
  }

  /* ---------------------------------------------------------------- */
  /* challenges — same beaches for everyone from a shared seed          */
  /* ---------------------------------------------------------------- */

  // Map the round-count setting to a single character so it fits in the code.
  const ROUNDS_CODE = { 3: "3", 5: "5", 10: "X" };
  const CODE_ROUNDS = { "3": 3, "5": 5, "X": 10 };

  /** A tiny seeded PRNG (mulberry32). Same seed → same sequence everywhere. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** The RNG a game draws from: seeded inside a challenge, random otherwise. */
  function gameRng() {
    return challenge ? mulberry32(challenge.seed) : Math.random;
  }

  /** Builds the shareable code that carries the seed, round count and labels. */
  function encodeChallenge(c) {
    const seed = (c.seed >>> 0).toString(36).toUpperCase();
    return ROUNDS_CODE[c.rounds] + (c.labels === "off" ? "N" : "L") + "-" + seed;
  }

  /**
   * Reads a challenge back out of a pasted code or a full challenge link.
   * Lenient about case, spaces and the hyphen; returns null if it can't.
   */
  function parseChallenge(text) {
    if (!text) return null;
    let raw = String(text).trim();
    const m = raw.match(/[?&]g=([^&\s]+)/i); // a pasted link
    if (m) raw = decodeURIComponent(m[1]);
    raw = raw.replace(/[\s-]/g, "").toUpperCase();
    if (raw.length < 3) return null;
    const rounds = CODE_ROUNDS[raw[0]];
    const labels = raw[1] === "N" ? "off" : raw[1] === "L" ? "on" : null;
    const seed = parseInt(raw.slice(2), 36);
    if (!rounds || !labels || !Number.isFinite(seed)) return null;
    const c = { seed: seed >>> 0, rounds: rounds, labels: labels };
    c.code = encodeChallenge(c);
    return c;
  }

  /** The full link that opens straight into a challenge. */
  function challengeLink(c) {
    // Opened from a file:// build there is no shareable origin; fall back to the
    // hosted site so the copied link still works for whoever receives it.
    const base = location.protocol === "file:"
      ? "https://ifountain1002-bit.github.io/wave-guesser/"
      : location.origin + location.pathname;
    return base + "?g=" + c.code;
  }

  /** replaceState throws on a file:// page; the address bar just won't update. */
  function setUrl(url) {
    try { history.replaceState(null, "", url); } catch (err) { /* file:// */ }
  }

  function shuffled(list, rng) {
    const rand = rng || Math.random;
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /** Picks the round line-up, avoiding two beaches that sit on top of each other. */
  function pickBeaches(count, rng) {
    const pool = shuffled(BEACHES, rng);
    const chosen = [];
    for (const candidate of pool) {
      if (chosen.length >= count) break;
      const clashes = chosen.some((c) => distanceKm(c, candidate) < MIN_SEPARATION_KM);
      if (!clashes) chosen.push(candidate);
    }
    // Tiny pools could come up short; top up rather than run a shorter game.
    for (const candidate of pool) {
      if (chosen.length >= count) break;
      if (!chosen.includes(candidate)) chosen.push(candidate);
    }
    return chosen.slice(0, count);
  }

  function pinIcon(kind) {
    return L.divIcon({
      className: "",
      html: '<div class="pin pin--' + kind + '"></div>',
      iconSize: [26, 26],
      iconAnchor: [13, 26]
    });
  }

  function creditHTML(photo, prefix) {
    const c = photo.credit;
    const licence = c.licenseUrl
      ? '<a href="' + c.licenseUrl + '" target="_blank" rel="noopener">' + escapeHTML(c.license) + "</a>"
      : escapeHTML(c.license);
    return (prefix || "Photo") + ": " +
      '<a href="' + c.pageUrl + '" target="_blank" rel="noopener">' + escapeHTML(c.title) + "</a>" +
      " by " + escapeHTML(c.author) + " · " + licence + " · via Wikimedia Commons";
  }

  function escapeHTML(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  /* ---------------------------------------------------------------- */
  /* maps                                                              */
  /* ---------------------------------------------------------------- */

  function baseLayer() {
    const conf = TILES[settings.labels] || TILES.on;
    return L.tileLayer(conf.url, {
      attribution: conf.attribution,
      subdomains: "abcd",
      maxZoom: 18,
      minZoom: 0,
      noWrap: false
    });
  }

  function buildGuessMap() {
    guessMap = L.map("guess-map", {
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      minZoom: 0,
      zoomSnap: 0,
      zoomDelta: 1
    }).setView([20, 0], 1);
    guessLayer = baseLayer().addTo(guessMap);

    // Once the player zooms or pans, their view is theirs — we stop reframing.
    guessMap.on("zoomstart movestart", () => { if (!framing) playerFramed = true; });

    guessMap.on("click", (e) => {
      if (!round || round.submitted || round.phase !== "guess") return;
      const pos = normalise(e.latlng);
      if (guessMarker) {
        guessMarker.setLatLng(e.latlng);
      } else {
        guessMarker = L.marker(e.latlng, {
          icon: pinIcon("guess"), draggable: true, keyboard: false
        }).addTo(guessMap);
        guessMarker.on("dragend", () => {
          round.guess = normalise(guessMarker.getLatLng());
        });
      }
      round.guess = pos;
      el.guessBtn.disabled = false;
      el.guessHint.textContent = "Drag the pin to fine-tune, then guess";
    });
  }

  function buildResultMap() {
    resultMap = L.map("result-map", {
      worldCopyJump: true,
      zoomControl: true,
      attributionControl: true,
      minZoom: 0,
      zoomSnap: 0,
      zoomDelta: 1
    }).setView([20, 0], 2);
    resultBase = baseLayer().addTo(resultMap);
  }

  /** Swaps tiles when the player changes the labels setting between games. */
  function refreshTiles() {
    if (guessMap) { guessMap.removeLayer(guessLayer); guessLayer = baseLayer().addTo(guessMap); }
    if (resultMap) { resultMap.removeLayer(resultBase); resultBase = baseLayer().addTo(resultMap); }
  }

  /** Fits the whole world to whatever size the panel currently is. */
  function frameWorld() {
    // During the look phase the panel is display:none, so it has no size to
    // fit bounds to. Entering the guess phase reframes it once it is visible.
    const box = guessMap.getContainer();
    if (!box.clientWidth || !box.clientHeight) return;
    framing = true;
    guessMap.invalidateSize({ animate: false });
    guessMap.fitBounds(WORLD_VIEW, { animate: false });
    framing = false;
  }

  function resetGuessMap() {
    if (guessMarker) { guessMap.removeLayer(guessMarker); guessMarker = null; }
    playerFramed = false;
    frameWorld();
    el.guessBtn.disabled = true;
    el.guessHint.textContent = "Click the map to place your pin";
    setMapOpen(false);
  }

  function setMapOpen(open) {
    if (round && round.phase === "guess") return;  // the map is already full-screen
    el.mappanel.classList.toggle("is-open", open);
    el.mapToggle.setAttribute("aria-expanded", String(open));
    el.mapToggle.setAttribute("aria-label", open ? "Shrink map" : "Expand map");
    // The panel animates open, so resize once it has settled.
    setTimeout(() => {
      if (!guessMap) return;
      if (playerFramed) guessMap.invalidateSize({ animate: false });
      else frameWorld();
    }, 300);
  }

  /* ---------------------------------------------------------------- */
  /* loading a game                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Resolves photos for the queued beaches a few at a time and stops as soon as
   * `wanted` of them have come back — resolving them one by one made a
   * ten-round game take far too long to start.
   */
  async function loadRounds(queue, wanted) {
    const ready = [];
    let next = 0;

    const progress = () => {
      el.loadBar.style.width = Math.min(100, Math.round((ready.length / wanted) * 100)) + "%";
      el.loadStatus.textContent = ready.length >= wanted
        ? "Ready."
        : "Found " + ready.length + " of " + wanted + " beaches…";
    };

    async function worker() {
      while (next < queue.length && ready.length < wanted && !loadAbandoned) {
        const beach = queue[next++];
        try {
          const photos = await PhotoService.getPhotos(beach);
          if (ready.length < wanted) ready.push({ beach: beach, photos: photos });
        } catch (err) {
          console.warn("skipping", beach.name, err.message);
        }
        progress();
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()]);
    return ready.slice(0, wanted);
  }

  async function startGame() {
    loadAbandoned = false;
    show("loading");
    el.loadTitle.textContent = "Scouting beaches…";
    el.loadBar.style.width = "0%";
    el.loadStatus.textContent = "Contacting Wikimedia…";

    const wanted = settings.rounds;
    // Inside a challenge the seeded RNG makes this line-up identical for every
    // player; the spares (drawn in the same deterministic order) only stand in
    // when a photo fails to load.
    const queue = pickBeaches(Math.min(BEACHES.length, wanted + 6), gameRng());
    const ready = await loadRounds(queue, wanted);

    if (loadAbandoned) return;

    if (ready.length === 0) {
      show("start");
      toast("Couldn't reach Wikimedia to load beach photos. Check your connection and try again.", 7000);
      return;
    }
    if (ready.length < wanted) {
      toast("Only found photos for " + ready.length + " beaches right now — playing a shorter game.", 5000);
    }

    game = { rounds: ready, results: [], index: 0, total: 0 };
    el.scoreTotal.textContent = "0";
    show("play");
    if (!guessMap) buildGuessMap();
    beginRound();
  }

  /* ---------------------------------------------------------------- */
  /* a round                                                           */
  /* ---------------------------------------------------------------- */

  function beginRound() {
    const entry = game.rounds[game.index];
    round = {
      beach: entry.beach,
      photos: entry.photos,
      photoIndex: 0,
      guess: null,
      submitted: false,
      phase: "look",
      phaseSeconds: LOOK_SECONDS
    };

    el.roundPill.textContent = "Round " + (game.index + 1) + " / " + game.rounds.length;
    showPhoto(0);
    resetGuessMap();
    setPhase("look");

    // Warm the next round's photo while this one is being played.
    const next = game.rounds[game.index + 1];
    if (next) PhotoService.preload(next.photos[0].src).catch(() => {});
  }

  function showPhoto(i) {
    const photos = round.photos;
    round.photoIndex = (i + photos.length) % photos.length;
    const photo = photos[round.photoIndex];

    el.photo.onerror = () => {
      el.photo.onerror = null;
      if (photos.length > 1) {
        round.photos = photos.filter((p) => p !== photo);
        showPhoto(round.photoIndex);
      }
    };
    el.photo.src = photo.src;
    el.photo.alt = "An unidentified beach — round " + (game.index + 1);
    // Deliberately no filename or author here: Commons titles usually contain
    // the beach's name, which would hand the player the answer. The full
    // credit appears on the reveal screen instead.

    const many = photos.length > 1;
    el.photoNav.hidden = !many;
    el.photoCount.textContent = (round.photoIndex + 1) + " / " + photos.length;
  }

  /**
   * "look" shows the photo full-screen with no map; "guess" hands the screen
   * over to the map. Entering a phase always restarts its own clock, so
   * skipping the look phase early still leaves the full guessing time.
   */
  function setPhase(name) {
    if (!round || round.submitted) return;
    round.phase = name;
    round.phaseSeconds = name === "look" ? LOOK_SECONDS : GUESS_SECONDS;
    round.deadline = Date.now() + round.phaseSeconds * 1000;

    screens.play.classList.toggle("phase-look", name === "look");
    screens.play.classList.toggle("phase-guess", name === "guess");
    setPeek(false);

    el.timerLabel.textContent = name === "look" ? "Look" : "Guess";
    el.timer.classList.remove("is-warn", "is-urgent");
    el.timerRing.style.strokeDasharray = 2 * Math.PI * 19;
    el.timerRing.style.strokeDashoffset = "0";
    el.timerNum.textContent = round.phaseSeconds;

    if (name === "guess") {
      // The panel is now full-screen, so the map has to be re-measured.
      if (playerFramed) guessMap.invalidateSize({ animate: false });
      else frameWorld();
      el.guessBtn.focus();
    }

    clearInterval(ticker);
    ticker = setInterval(tick, 200);
    tick();
  }

  function tick() {
    if (!round || round.submitted) return;
    const remaining = Math.max(0, round.deadline - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    el.timerNum.textContent = seconds;

    const circumference = 2 * Math.PI * 19;
    const fraction = 1 - remaining / (round.phaseSeconds * 1000);
    el.timerRing.style.strokeDashoffset = (circumference * fraction).toFixed(2);

    el.timer.classList.toggle("is-warn", seconds <= 20 && seconds > 10);
    el.timer.classList.toggle("is-urgent", seconds <= 10);

    if (remaining > 0) return;
    if (round.phase === "look") setPhase("guess");
    else submitGuess(true);
  }

  /** Enlarges the photo thumbnail that sits over the map while guessing. */
  function setPeek(open) {
    screens.play.classList.toggle("is-peeking", open);
    el.peek.setAttribute("aria-expanded", String(open));
  }

  function submitGuess(timedOut) {
    if (!round || round.submitted) return;
    round.submitted = true;
    clearInterval(ticker);

    const truth = { lat: round.beach.lat, lng: round.beach.lng };
    const guess = round.guess;
    const km = guess ? distanceKm(guess, truth) : null;
    const points = guess ? scoreFor(km) : 0;

    game.total += points;
    game.results.push({
      beach: round.beach,
      photo: round.photos[round.photoIndex],
      guess: guess,
      km: km,
      points: points,
      timedOut: !!timedOut && !guess
    });
    el.scoreTotal.textContent = nf(game.total);

    renderReveal(game.results[game.results.length - 1]);
  }

  /* ---------------------------------------------------------------- */
  /* reveal                                                            */
  /* ---------------------------------------------------------------- */

  function renderReveal(result) {
    show("reveal");
    if (!resultMap) buildResultMap();

    if (resultLayer) resultMap.removeLayer(resultLayer);
    resultLayer = L.layerGroup().addTo(resultMap);

    const truth = [result.beach.lat, result.beach.lng];
    L.marker(truth, { icon: pinIcon("truth") })
      .addTo(resultLayer)
      .bindTooltip(result.beach.name, { direction: "top", offset: [0, -24] });

    if (result.guess) {
      const guess = [result.guess.lat, result.guess.lng];
      L.marker(guess, { icon: pinIcon("guess") })
        .addTo(resultLayer)
        .bindTooltip("Your guess", { direction: "top", offset: [0, -24] });
      L.polyline([guess, truth], {
        color: "#ff7a59", weight: 2, dashArray: "6 8", opacity: 0.9
      }).addTo(resultLayer);
    }

    resultMap.invalidateSize({ animate: false });
    if (result.guess) {
      resultMap.fitBounds(
        L.latLngBounds([[result.guess.lat, result.guess.lng], truth]),
        { padding: [70, 70], maxZoom: 8, animate: false }
      );
    } else {
      resultMap.setView(truth, 5, { animate: false });
    }

    el.revealEyebrow.textContent = "Round " + (game.index + 1) + " of " + game.rounds.length;
    el.revealName.textContent = result.beach.name;
    el.revealCountry.textContent = result.beach.country;
    el.revealPoints.textContent = nf(result.points);
    el.revealDistance.textContent = result.guess ? formatDistance(result.km) : "no guess";
    el.revealFact.textContent = result.timedOut
      ? "Time ran out before you dropped a pin. " + result.beach.fact
      : result.beach.fact;
    el.revealThumb.hidden = false;
    el.revealThumb.src = result.photo.src;
    el.revealThumb.alt = result.beach.name + ", " + result.beach.country;
    el.revealCredit.innerHTML = creditHTML(result.photo);

    const last = game.index === game.rounds.length - 1;
    el.nextBtn.textContent = last ? "See final score" : "Next round";
    el.nextBtn.focus();
  }

  function advance() {
    if (game.index === game.rounds.length - 1) return renderFinal();
    game.index++;
    show("play");
    beginRound();
  }

  /* ---------------------------------------------------------------- */
  /* final                                                             */
  /* ---------------------------------------------------------------- */

  function rankFor(pct) {
    if (pct >= 0.92) return "Cartographer of the coast";
    if (pct >= 0.75) return "Seasoned navigator";
    if (pct >= 0.55) return "Confident beachcomber";
    if (pct >= 0.35) return "Holiday browser";
    if (pct > 0) return "Lost at sea";
    return "Still packing the suitcase";
  }

  function renderFinal() {
    show("final");
    const max = game.rounds.length * MAX_POINTS;
    el.finalPoints.textContent = nf(game.total);
    el.finalMax.textContent = "/ " + nf(max);
    el.finalRank.textContent = rankFor(game.total / max);

    el.breakdown.innerHTML = "";
    game.results.forEach((r, i) => {
      const li = document.createElement("li");
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = i + 1;
      const name = document.createElement("span");
      name.textContent = r.beach.name;
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = r.guess ? formatDistance(r.km) : "no guess";
      const p = document.createElement("span");
      p.className = "p";
      p.textContent = nf(r.points);
      li.append(n, name, d, p);
      el.breakdown.appendChild(li);
    });

    if (el.finalShare) {
      el.finalShare.hidden = !challenge;
      if (challenge) el.finalCode.textContent = challenge.code;
    }

    saveBest(game.total, max);
  }

  /** A one-line result to paste into a chat, plus the link to try to beat it. */
  function resultText() {
    const max = game.rounds.length * MAX_POINTS;
    return "🌊 Wave Guesser challenge " + challenge.code + " — " +
      nf(game.total) + " / " + nf(max) + " (" + rankFor(game.total / max) +
      "). Same beaches, beat me: " + challengeLink(challenge);
  }

  function saveBest(total, max) {
    try {
      const pct = total / max;
      const prev = JSON.parse(localStorage.getItem(BEST_KEY) || "null");
      if (!prev || pct > prev.pct) {
        localStorage.setItem(BEST_KEY, JSON.stringify({ total: total, max: max, pct: pct }));
      }
    } catch (err) { /* private browsing — best score just won't stick */ }
    renderBest();
  }

  function renderBest() {
    try {
      const best = JSON.parse(localStorage.getItem(BEST_KEY) || "null");
      if (!best) { el.best.hidden = true; return; }
      el.best.hidden = false;
      el.best.textContent = "Personal best: " + nf(best.total) + " / " + nf(best.max);
    } catch (err) { el.best.hidden = true; }
  }

  /* ---------------------------------------------------------------- */
  /* challenge UI                                                       */
  /* ---------------------------------------------------------------- */

  /** Moves the "is-on" state of the segmented controls to match `settings`. */
  function reflectSettings() {
    document.querySelectorAll(".segmented .seg").forEach((b) => {
      const on = (b.dataset.rounds && Number(b.dataset.rounds) === settings.rounds) ||
        (b.dataset.labels && b.dataset.labels === settings.labels);
      b.classList.toggle("is-on", !!on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
  }

  function updatePlayButton() {
    el.play.textContent = challenge ? "Start challenge" : "Start guessing";
  }

  /** Enters a challenge: locks settings to it and reflects it on the start screen. */
  function enterChallenge(c) {
    challenge = c;
    settings.rounds = c.rounds;
    settings.labels = c.labels;
    reflectSettings();
    refreshTiles();
    if (el.shareBox) {
      el.shareCode.textContent = c.code;
      el.shareBox.hidden = false;
    }
    if (el.joinRow) el.joinRow.hidden = true;
    updatePlayButton();
  }

  /** Leaves challenge mode — the player is back to an ordinary random game. */
  function clearChallenge() {
    if (!challenge) return;
    challenge = null;
    if (el.shareBox) el.shareBox.hidden = true;
    if (el.invite) el.invite.hidden = true;
    updatePlayButton();
    // Drop ?g= so a reload doesn't drag the player back into the challenge.
    if (location.search) {
      setUrl(location.origin + location.pathname);
    }
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg || "Copied to clipboard.", 2600);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => prompt("Copy this:", text));
    } else {
      prompt("Copy this:", text);
    }
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  document.querySelectorAll(".segmented").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg");
      if (!btn) return;
      // Hand-tuning the settings means you're building your own game now.
      clearChallenge();
      group.querySelectorAll(".seg").forEach((b) => {
        b.classList.remove("is-on");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("is-on");
      btn.setAttribute("aria-checked", "true");
      if (btn.dataset.rounds) settings.rounds = Number(btn.dataset.rounds);
      if (btn.dataset.labels) { settings.labels = btn.dataset.labels; refreshTiles(); }
    });
  });

  if (el.createChallenge) {
    el.createChallenge.addEventListener("click", () => {
      const seed = (Math.random() * 0x100000000) >>> 0;
      const c = { seed: seed, rounds: settings.rounds, labels: settings.labels };
      c.code = encodeChallenge(c);
      enterChallenge(c);
      setUrl(challengeLink(c));
      toast("Challenge ready — share the link, then start when you like.", 4200);
    });
  }

  if (el.joinToggle) {
    el.joinToggle.addEventListener("click", () => {
      el.joinRow.hidden = !el.joinRow.hidden;
      if (!el.joinRow.hidden) el.joinCode.focus();
    });
  }

  if (el.joinRow) {
    el.joinRow.addEventListener("submit", (e) => {
      e.preventDefault();
      const c = parseChallenge(el.joinCode.value);
      if (!c) { toast("That doesn't look like a challenge code. Paste the link or code you were sent.", 5000); return; }
      enterChallenge(c);
      setUrl(challengeLink(c));
      startGame();
    });
  }

  if (el.copyLink) el.copyLink.addEventListener("click", () => challenge && copyText(challengeLink(challenge), "Challenge link copied."));
  if (el.copyCode) el.copyCode.addEventListener("click", () => challenge && copyText(challenge.code, "Challenge code copied."));

  el.play.addEventListener("click", startGame);
  el.again.addEventListener("click", startGame);
  el.home.addEventListener("click", () => show("start"));
  if (el.copyResult) el.copyResult.addEventListener("click", () => challenge && copyText(resultText(), "Result copied — paste it to your friends."));
  if (el.copyChallenge) el.copyChallenge.addEventListener("click", () => challenge && copyText(challengeLink(challenge), "Challenge link copied."));
  el.nextBtn.addEventListener("click", advance);
  el.guessBtn.addEventListener("click", () => submitGuess(false));
  el.toMap.addEventListener("click", () => setPhase("guess"));
  el.peek.addEventListener("click", () => {
    setPeek(!screens.play.classList.contains("is-peeking"));
  });
  el.mapToggle.addEventListener("click", () => {
    setMapOpen(!el.mappanel.classList.contains("is-open"));
  });
  el.loadCancel.addEventListener("click", () => { loadAbandoned = true; show("start"); });
  el.photoPrev.addEventListener("click", () => showPhoto(round.photoIndex - 1));
  el.photoNext.addEventListener("click", () => showPhoto(round.photoIndex + 1));

  document.addEventListener("keydown", (e) => {
    if (screens.play.classList.contains("is-active")) {
      const looking = round && round.phase === "look";
      if (e.key === "Enter") {
        e.preventDefault();
        if (looking) setPhase("guess");
        else if (!el.guessBtn.disabled) submitGuess(false);
      }
      if (e.key === "m" || e.key === "M") {
        if (looking) setPhase("guess");
        else setPeek(!screens.play.classList.contains("is-peeking"));
      }
      if (e.key === "Escape") setPeek(false);
      if (e.key === "ArrowLeft" && round && round.photos.length > 1) showPhoto(round.photoIndex - 1);
      if (e.key === "ArrowRight" && round && round.photos.length > 1) showPhoto(round.photoIndex + 1);
    } else if (screens.reveal.classList.contains("is-active") && e.key === "Enter") {
      e.preventDefault();
      advance();
    }
  });

  // A tab-out pauses nothing, but coming back should not show a stale clock.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && round && !round.submitted) tick();
  });

  // Make it clear the round count is a per-game setting, not the whole pool.
  el.poolNote.innerHTML = "Drawn at random from <b>" + nf(BEACHES.length) +
    " beaches</b> in " + nf(new Set(BEACHES.map(function (b) { return b.country; })).size) +
    " countries.";

  renderBest();

  // Opened from a shared challenge link? Load it and invite the player in.
  (function bootChallenge() {
    const params = new URLSearchParams(location.search);
    const c = parseChallenge(params.get("g"));
    if (!c) return;
    enterChallenge(c);
    if (el.invite) {
      el.invite.innerHTML = "You've been invited to a challenge — the same " +
        c.rounds + " beaches everyone else is guessing. Press <b>Start challenge</b>.";
      el.invite.hidden = false;
    }
  })();
})();
