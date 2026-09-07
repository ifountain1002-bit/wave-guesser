/**
 * Beach Guesser — round flow, timer, scoring and the two Leaflet maps.
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
  const BEST_KEY = Backend.KEYS.best;
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
    final: $("screen-final"),
    board: $("screen-board")
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
    photoReport: $("photo-report"), reportBox: $("reportbox"),
    reportReasons: $("report-reasons"), reportCancel: $("report-cancel"),
    reportWhich: $("report-which"), revealReport: $("reveal-report"),
    boardScope: $("board-scope"), boardList: $("board-list"), boardNote: $("board-note"),
    boardBack: $("btn-board-back"), openBoard: $("btn-leaderboard"),
    viewBoard: $("btn-view-board"), submitRow: $("submit-row"),
    playerName: $("player-name"), submitBtn: $("btn-submit-score"),
    submitNote: $("submit-note"),
    toast: $("toast")
  };

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */

  const settings = { rounds: 5, labels: "on" };

  let game = null;      // { beaches, results, index, total }
  let round = null;     // { beach, photos, photoIndex, guess, deadline }
  let ticker = null;
  let loadAbandoned = false;

  let guessMap = null, resultMap = null;
  let guessLayer = null, guessMarker = null;
  let resultBase = null, resultLayer = null;
  let boardRounds = 5;      // which board the leaderboard screen is showing
  let boardFrom = "start";  // where to return to when it is dismissed
  let lastSubmitted = null; // the row this device just added, to highlight it
  let reportTarget = null;  // { photo, beach, from } while the dialog is open
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

  function shuffled(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /** Picks the round line-up, avoiding two beaches that sit on top of each other. */
  function pickBeaches(count) {
    const pool = shuffled(BEACHES);
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
    const queue = pickBeaches(Math.min(BEACHES.length, wanted + 6)); // spares for failures
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

    game = { rounds: ready, results: [], index: 0, total: 0, submittedScore: false };
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

    el.photoNav.hidden = false;   // the report control lives here too
    el.photoPrev.hidden = photos.length < 2;
    el.photoNext.hidden = photos.length < 2;
    el.photoCount.hidden = photos.length < 2;
    el.photoCount.textContent = (round.photoIndex + 1) + " / " + photos.length;
    el.photoReport.classList.remove("is-done");
    openReport(null);
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
    el.revealReport.textContent = "\u2691 Report this photo";
    el.revealReport.classList.remove("is-done");
    el.revealReport.disabled = false;

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

    saveBest(game.total, max);

    // Prime the submit row for this game.
    game.submittedScore = false;
    el.submitBtn.disabled = false;
    el.playerName.disabled = false;
    el.playerName.value = Backend.rememberedName();
    el.submitNote.textContent = Backend.isConfigured()
      ? ""
      : "No worldwide board is configured, so this saves to your device.";
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
  /* reporting a photo                                                 */
  /* ---------------------------------------------------------------- */

  function buildReportReasons() {
    el.reportReasons.innerHTML = "";
    Backend.REASONS.forEach((reason) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = reason.label;
      btn.addEventListener("click", () => sendReport(reason.id));
      el.reportReasons.appendChild(btn);
    });
  }

  /** `target` is { photo, beach, from } — null closes the dialog. */
  function openReport(target) {
    reportTarget = target;
    el.reportBox.hidden = !target;
    if (!target) return;
    el.reportWhich.textContent = target.photo.credit.title;
    const first = el.reportReasons.querySelector("button");
    if (first) first.focus();
  }

  /**
   * Files the report and, when it came from the photo itself, drops that photo
   * from the round so the player is not left looking at what they complained
   * about.
   */
  async function sendReport(reasonId) {
    const target = reportTarget;
    if (!target) return;
    openReport(null);

    const result = await Backend.reportPhoto({
      fileTitle: target.photo.credit.title,
      beach: target.beach,
      reason: reasonId
    });
    const thanks = result.published
      ? "Thanks — reported. You won't see it again."
      : "Hidden for you on this device.";

    if (target.from === "reveal") {
      el.revealReport.textContent = "\u2713 Reported";
      el.revealReport.classList.add("is-done");
      el.revealReport.disabled = true;
      toast(thanks, 3200);
      return;
    }

    if (round && round.photos.length > 1) {
      round.photos = round.photos.filter((p) => p !== target.photo);
      showPhoto(round.photoIndex);
      toast(thanks, 3200);
    } else {
      // Nothing left to fall back to, so keep showing it for this round.
      el.photoReport.classList.add("is-done");
      toast("Reported. It won't come back on this device.", 3200);
    }
  }

  /* ---------------------------------------------------------------- */
  /* leaderboard                                                       */
  /* ---------------------------------------------------------------- */

  function showBoard(rounds, from) {
    boardRounds = rounds || boardRounds;
    boardFrom = from || boardFrom;
    document.querySelectorAll(".segmented--board .seg").forEach((b) => {
      const on = Number(b.dataset.board) === boardRounds;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-checked", String(on));
    });
    show("board");
    renderBoard();
  }

  async function renderBoard() {
    el.boardList.innerHTML = "";
    el.boardNote.textContent = "";
    el.boardScope.textContent = "Loading…";

    const wanted = boardRounds;
    const result = await Backend.topScores(wanted);
    if (boardRounds !== wanted) return;   // the player switched boards meanwhile

    const worldwide = result.scope === "world";
    el.boardScope.textContent = worldwide ? "Worldwide" : "This device";

    if (result.rows.length === 0) {
      const li = document.createElement("li");
      li.className = "board__empty";
      li.textContent = worldwide
        ? "No scores yet for this length. Be the first."
        : "No games finished at this length yet.";
      el.boardList.appendChild(li);
    } else {
      result.rows.forEach((row, i) => {
        const li = document.createElement("li");
        if (lastSubmitted && row.name === lastSubmitted.name &&
            row.score === lastSubmitted.score && row.rounds === lastSubmitted.rounds) {
          li.className = "is-you";
        }
        const rank = document.createElement("span");
        rank.className = "rank";
        rank.textContent = i + 1;
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = row.name;            // other people's text: never innerHTML
        const pts = document.createElement("span");
        pts.className = "pts";
        pts.textContent = nf(row.score);
        li.append(rank, who, pts);
        el.boardList.appendChild(li);
      });
    }

    if (!Backend.isConfigured()) {
      el.boardNote.textContent = "Scores are kept on this device only. " +
        "Connect a Supabase project (see docs/online-setup.md) to share a worldwide board.";
    } else if (result.degraded) {
      el.boardNote.textContent = "Couldn't reach the worldwide board, so this is your device's.";
    } else {
      el.boardNote.textContent = "Best games over " + wanted + " beaches, from players everywhere.";
    }
  }

  async function submitScore(event) {
    if (event) event.preventDefault();
    if (!game || game.submittedScore) return;

    const name = Backend.cleanName(el.playerName.value);
    if (!name) {
      el.submitNote.textContent = "Enter a name first.";
      el.playerName.focus();
      return;
    }

    game.submittedScore = true;
    el.submitBtn.disabled = true;
    el.playerName.disabled = true;
    el.submitNote.textContent = "Sending…";

    const entry = { name: name, score: game.total, rounds: game.rounds.length };
    const result = await Backend.submitScore(entry);
    lastSubmitted = entry;

    el.submitNote.textContent = result.published
      ? "Added to the worldwide leaderboard."
      : Backend.isConfigured()
        ? "Couldn't reach the leaderboard — saved on this device."
        : "Saved to this device's high scores.";
  }

  /* ---------------------------------------------------------------- */
  /* wiring                                                            */
  /* ---------------------------------------------------------------- */

  document.querySelectorAll(".segmented").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg");
      if (!btn) return;
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

  el.play.addEventListener("click", startGame);
  el.again.addEventListener("click", startGame);
  el.home.addEventListener("click", () => show("start"));
  el.nextBtn.addEventListener("click", advance);
  el.guessBtn.addEventListener("click", () => submitGuess(false));
  el.toMap.addEventListener("click", () => setPhase("guess"));
  el.photoReport.addEventListener("click", () => {
    if (!el.reportBox.hidden) return openReport(null);
    if (round) openReport({ photo: round.photos[round.photoIndex], beach: round.beach.name, from: "photo" });
  });
  el.revealReport.addEventListener("click", () => {
    const last = game && game.results[game.results.length - 1];
    if (last) openReport({ photo: last.photo, beach: last.beach.name, from: "reveal" });
  });
  el.reportCancel.addEventListener("click", () => openReport(null));
  el.reportBox.addEventListener("click", (e) => {
    if (e.target === el.reportBox) openReport(null);   // click the backdrop
  });
  el.openBoard.addEventListener("click", () => showBoard(settings.rounds, "start"));
  el.viewBoard.addEventListener("click", () => showBoard(game ? game.rounds.length : settings.rounds, "final"));
  el.boardBack.addEventListener("click", () => show(boardFrom));
  el.submitRow.addEventListener("submit", submitScore);
  document.querySelector(".segmented--board").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg");
    if (btn) showBoard(Number(btn.dataset.board));
  });
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
      if (e.key === "Escape") {
        if (!el.reportBox.hidden) openReport(null);
        else setPeek(false);
      }
      if (e.key === "ArrowLeft" && round && round.photos.length > 1) showPhoto(round.photoIndex - 1);
      if (e.key === "ArrowRight" && round && round.photos.length > 1) showPhoto(round.photoIndex + 1);
    } else if (screens.reveal.classList.contains("is-active")) {
      if (e.key === "Escape" && !el.reportBox.hidden) openReport(null);
      else if (e.key === "Enter" && el.reportBox.hidden) { e.preventDefault(); advance(); }
    }
  });

  // A tab-out pauses nothing, but coming back should not show a stale clock.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && round && !round.submitted) tick();
  });

  buildReportReasons();
  // Photos other players have reported enough times are dropped before the
  // first round is drawn; a failure here just means nothing extra is hidden.
  Backend.loadBlocked().catch(() => {});

  // Make it clear the round count is a per-game setting, not the whole pool.
  el.poolNote.innerHTML = "Drawn at random from <b>" + nf(BEACHES.length) +
    " beaches</b> in " + nf(new Set(BEACHES.map(function (b) { return b.country; })).size) +
    " countries.";

  renderBest();
})();
