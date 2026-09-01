/**
 * Resolves real beach photographs at runtime from the Wikimedia APIs.
 *
 * Nothing here needs an API key or a server: both endpoints allow anonymous
 * cross-origin reads when called with `origin=*`, so the whole game can be
 * hosted as static files.
 *
 * Strategy per beach:
 *   1. Ask English Wikipedia for the article's lead image and every other
 *      image used in the article, with size + licence metadata.
 *   2. Throw out anything that is not a usable photograph (icons, flags,
 *      locator maps, diagrams, tiny or extreme-aspect files).
 *   3. If that yields nothing, fall back to a Commons geo-search around the
 *      beach's coordinates.
 * Every returned photo carries the credit line for the file that is actually
 * displayed, so attribution can never drift from the image.
 */
const PhotoService = (function () {
  const WIKI_API = "https://en.wikipedia.org/w/api.php";
  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  const REQUEST_TIMEOUT_MS = 15000;
  const TARGET_WIDTH = 1600;
  const MAX_PHOTOS_PER_BEACH = 8;

  /** Files whose names give them away as non-photographic page furniture. */
  const REJECT_NAME = new RegExp([
    "flag", "\\bmap\\b", "locator", "location_?map", "orthographic",
    "coat[ _]of[ _]arms", "\\bicon\\b", "logo", "wikimedia", "commons-logo",
    "wiki(pedia|voyage|source)", "question_?book", "ambox", "edit-clear",
    "symbol", "\\bseal\\b", "emblem", "pog\\.svg", "compass", "diagram",
    "chart", "graph", "topograph", "relief", "bathymetr", "climate",
    "portal", "speakerlink", "increase2?\\.svg", "decrease2?\\.svg",
    "loudspeaker", "\\bplaque\\b", "signature", "\\bstub\\b"
  ].join("|"), "i");

  const cache = new Map();      // wiki title -> Promise<photo[]>
  const inflight = new Map();

  /* ------------------------------------------------------------------ */
  /* networking                                                          */
  /* ------------------------------------------------------------------ */

  async function getJSON(base, params) {
    const url = base + "?" + new URLSearchParams(
      Object.assign({ format: "json", formatversion: "2", origin: "*" }, params)
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
      if (!res.ok) throw new Error("HTTP " + res.status + " from " + base);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ------------------------------------------------------------------ */
  /* metadata -> photo objects                                           */
  /* ------------------------------------------------------------------ */

  /** Strips the HTML Wikimedia returns in credit fields down to plain text. */
  function plainText(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** extmetadata is user-supplied; never let a non-http scheme reach an href. */
  function safeUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, "https://commons.wikimedia.org");
      return (parsed.protocol === "http:" || parsed.protocol === "https:") ? parsed.href : "";
    } catch (err) {
      return "";
    }
  }

  function usable(page) {
    const info = page.imageinfo && page.imageinfo[0];
    if (!info) return false;
    if (!info.mime || !info.mime.startsWith("image/")) return false;
    if (info.mime === "image/svg+xml") return false;
    if (REJECT_NAME.test(page.title)) return false;

    const w = info.width, h = info.height;
    if (!w || !h) return false;
    if (w < 700 || h < 400) return false;           // too small to fill a stage
    const ratio = w / h;
    if (ratio < 0.75 || ratio > 3.4) return false;  // extreme panoramas and tall crops
    return true;
  }

  function toPhoto(page, isLead, source) {
    const info = page.imageinfo[0];
    const meta = info.extmetadata || {};
    const value = (k) => (meta[k] && meta[k].value) || "";
    return {
      src: info.thumburl || info.url,
      fullSrc: info.url,
      width: info.thumbwidth || info.width,
      height: info.thumbheight || info.height,
      isLead: !!isLead,
      source: source,
      credit: {
        title: page.title.replace(/^File:/, ""),
        author: plainText(value("Artist")) || "Unknown author",
        license: plainText(value("LicenseShortName")) || "See file page",
        licenseUrl: safeUrl(plainText(value("LicenseUrl"))),
        pageUrl: safeUrl(info.descriptionurl) ||
          ("https://commons.wikimedia.org/wiki/" + encodeURIComponent(page.title))
      }
    };
  }

  /**
   * Best photo first: the article's lead image, then the rest of the article's
   * images, then geo-tagged finds from Commons; big landscape shots ahead of
   * small or oddly-shaped ones within each tier.
   */
  function rank(photos) {
    const tier = (p) => (p.isLead ? 0 : p.source === "article" ? 1 : 2);
    return photos.sort((a, b) => {
      if (tier(a) !== tier(b)) return tier(a) - tier(b);
      const score = (p) => {
        const ratio = p.width / p.height;
        const landscape = ratio >= 1.2 && ratio <= 2.2 ? 1.35 : 1;
        return Math.min(p.width, 2400) * landscape;
      };
      return score(b) - score(a);
    });
  }

  /* ------------------------------------------------------------------ */
  /* sources                                                             */
  /* ------------------------------------------------------------------ */

  async function fromArticle(title) {
    const [leadRes, imagesRes] = await Promise.all([
      getJSON(WIKI_API, {
        action: "query", prop: "pageimages", piprop: "name",
        titles: title, redirects: "1"
      }).catch(() => null),
      getJSON(WIKI_API, {
        action: "query",
        generator: "images", gimlimit: "60", titles: title, redirects: "1",
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: String(TARGET_WIDTH),
        iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|Credit"
      })
    ]);

    const leadName = leadRes && leadRes.query && leadRes.query.pages &&
      leadRes.query.pages[0] && leadRes.query.pages[0].pageimage;

    const pages = (imagesRes.query && imagesRes.query.pages) || [];
    return rank(
      pages.filter(usable).map((p) => {
        const bare = p.title.replace(/^File:/, "").replace(/ /g, "_");
        const leadMatch = leadName && bare === leadName.replace(/ /g, "_");
        return toPhoto(p, leadMatch, "article");
      })
    );
  }

  async function fromGeoSearch(beach) {
    const res = await getJSON(COMMONS_API, {
      action: "query",
      generator: "geosearch",
      ggscoord: beach.lat + "|" + beach.lng,
      ggsradius: "10000",
      ggslimit: "50",
      ggsnamespace: "6",
      prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata",
      iiurlwidth: String(TARGET_WIDTH),
      iiextmetadatafilter: "Artist|LicenseShortName|LicenseUrl|Credit"
    });
    const pages = (res.query && res.query.pages) || [];
    return rank(pages.filter(usable).map((p) => toPhoto(p, false, "geo")));
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                          */
  /* ------------------------------------------------------------------ */

  /** Confirms the browser can actually render the file before a round uses it. */
  function preload(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load: " + src));
      img.src = src;
    });
  }

  async function resolve(beach) {
    const [fromArticleResult, fromGeoResult] = await Promise.all([
      fromArticle(beach.wiki).catch((err) => {
        console.warn("article lookup failed for", beach.wiki, err);
        return [];
      }),
      fromGeoSearch(beach).catch((err) => {
        console.warn("geo-search failed for", beach.name, err);
        return [];
      })
    ]);

    // Commons files often appear in both sets; keep the article's copy.
    const seen = new Set();
    const photos = rank(fromArticleResult.concat(fromGeoResult).filter((p) => {
      if (seen.has(p.credit.title)) return false;
      seen.add(p.credit.title);
      return true;
    }));

    if (photos.length === 0) throw new Error("no usable photo for " + beach.name);

    // Confirm one photo decodes so the round is guaranteed to render, then
    // carry a few unverified spares — showPhoto() drops any that turn out bad.
    let lead = null;
    for (const photo of photos) {
      try {
        await preload(photo.src);
        lead = photo;
        break;
      } catch (err) {
        /* try the next candidate */
      }
    }
    if (!lead) throw new Error("no loadable photo for " + beach.name);

    const spares = photos.filter((p) => p !== lead).slice(0, MAX_PHOTOS_PER_BEACH - 1);
    return [lead].concat(spares);
  }

  function getPhotos(beach) {
    const key = beach.wiki;
    if (cache.has(key)) return cache.get(key);
    if (inflight.has(key)) return inflight.get(key);

    const promise = resolve(beach).then(
      (photos) => { cache.set(key, Promise.resolve(photos)); inflight.delete(key); return photos; },
      (err) => { inflight.delete(key); throw err; }
    );
    inflight.set(key, promise);
    return promise;
  }

  return { getPhotos, preload };
})();
