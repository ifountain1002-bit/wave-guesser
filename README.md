# Wave Guesser

A GeoGuessr-style game for beaches. You get a photograph of a beach somewhere
in the world and **60 seconds** to drop a pin on a world map. The closer you
land, the more you score.

It is a static site — three files of JavaScript, one stylesheet and a local
copy of Leaflet. No build step, no server, no API keys.

## Play it

### The downloadable single file

`wave-guesser.html` is the whole game in one file — Leaflet, the styles, the
beach list and the game code all inlined. Download it, double-click it, play.
No server, no install, nothing to unpack.

It still needs an internet connection, because the beach photos come from
Wikimedia and the map tiles from OpenStreetMap. Both allow the requests from a
local file, so opening it straight off your disk works.

Rebuild it after changing anything under `assets/`:

```bash
python3 tools/build-single-file.py
```

### From the source tree

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works. Opening `index.html` off the filesystem works
too, but the single-file build above is the tidier way to do that.

## Putting it on GitHub Pages

`.github/workflows/deploy.yml` publishes the site on every push to `main`
(or `master`). There is no build step — the repo root is uploaded as-is.

1. Create a repository on GitHub and push this code to it:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/wave-guesser.git
   git push -u origin main
   ```

2. In the repository, open **Settings → Pages** and set **Source** to
   **GitHub Actions**. (This is a one-time switch. Leaving it on the default
   "Deploy from a branch" will ignore the workflow.)

3. Push anything, or run the workflow by hand from the **Actions** tab. When
   it finishes, the site is at:

   ```
   https://YOUR-USERNAME.github.io/wave-guesser/
   ```

Every path in the project is relative, so the game works from that
`/wave-guesser/` subpath as well as from a domain root — no base-URL setting
to change.

### Other hosts

Netlify, Cloudflare Pages, Vercel, S3 and friends all work the same way:
point them at the repo root, leave the build command empty, and set the
publish directory to `.`.

### A custom domain

Add a `CNAME` file at the repo root containing the domain, point the domain's
DNS at GitHub Pages, then set it under **Settings → Pages → Custom domain**.

## How it works

### The map

[Leaflet](https://leafletjs.com/) with free raster tiles from
[CARTO](https://carto.com/basemaps/), rendered from OpenStreetMap data. No
account or key is required. The start screen has a **map labels: off** setting
that swaps in the label-free basemap for a much harder game.

Leaflet 1.9.4 is vendored in `vendor/leaflet/` rather than loaded from a CDN,
so the only third-party requests at runtime are tiles and photos.

### The photos

Photos are **not** stored in this repo. `assets/js/beaches.js` holds each
beach's name, coordinates and Wikipedia article title; at runtime
`assets/js/photos.js` asks the Wikimedia APIs for that article's images:

1. `en.wikipedia.org/w/api.php` for the article's lead image and every other
   image it uses, with dimensions and licence metadata.
2. Anything that is not a usable photograph is discarded — SVGs, icons, flags,
   locator maps, diagrams, files under 900×500, and extreme aspect ratios.
3. If an article yields nothing, it falls back to a Commons geo-search within
   10 km of the beach's coordinates.
4. Each candidate is decoded in the browser before a round uses it, so a dead
   file never reaches the player.

Because the credit line is read from the same API response as the image, the
attribution shown always matches the photo on screen. Every photo links back to
its Commons file page and its licence.

This does mean **the game needs an internet connection** and that the exact
photos change as Wikipedia articles change.

### Scoring

Distance from your pin to the beach, on an exponential falloff:

```
points = 5000 · e^(−km / 1500)     (anything within 25 km scores the full 5000)
```

| Off by | Points |
|-------:|-------:|
| 25 km | 5,000 |
| 100 km | 4,678 |
| 500 km | 3,583 |
| 1,000 km | 2,567 |
| 5,000 km | 178 |

Letting the clock run out with no pin scores zero. Your best game is kept in
`localStorage`.

## Controls

| Key | Action |
|-----|--------|
| `M` | expand / shrink the map |
| `Esc` | shrink the map |
| `←` `→` | flip through the other photos of this beach |
| `Enter` | submit your guess, or advance from the reveal screen |

## Layout

```
index.html              markup for all five screens
wave-guesser.html       generated single-file build (see tools/)
assets/css/style.css    all styling
assets/js/beaches.js    the beach pool — name, country, lat/lng, article, trivia
assets/js/photos.js     Wikimedia lookup, filtering and preloading
assets/js/game.js       rounds, timer, scoring, both Leaflet maps
vendor/leaflet/         Leaflet 1.9.4 (BSD-2-Clause)
tools/                  the single-file bundler
.github/workflows/      GitHub Pages deployment
```

`wave-guesser.html` is generated. Edit the sources under `assets/`, then run
the bundler — don't edit the bundle directly.

## Adding a beach

Append an entry to `BEACHES` in `assets/js/beaches.js`:

```js
{ name: "Playa Whatever", country: "Chile", lat: -33.1234, lng: -71.6789,
  wiki: "Article title on English Wikipedia",
  fact: "One line shown on the reveal screen." }
```

`lat`/`lng` are the scoring ground truth, so use the beach itself rather than
the nearest town. `wiki` must be an article whose images actually show the
beach — the filter removes obvious junk, but it cannot tell a photo of the
harbour from a photo of the sand. The game skips any beach it cannot find a
photo for, and it will not put two beaches within 100 km of each other in the
same game.

## Credits

- Photographs: contributors to [Wikimedia Commons](https://commons.wikimedia.org/),
  under the licence shown with each image.
- Map tiles: [CARTO](https://carto.com/attributions), data ©
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Map library: [Leaflet](https://leafletjs.com/), BSD-2-Clause.
