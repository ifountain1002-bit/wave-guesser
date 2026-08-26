# Wave Guesser

A GeoGuessr-style game for beaches. You get a photograph of a beach somewhere
in the world and **60 seconds** to drop a pin on a world map. The closer you
land, the more you score.

It is a static site — three files of JavaScript, one stylesheet and a local
copy of Leaflet. No build step, no server, no API keys.

## Play locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works. Opening `index.html` straight off the filesystem
will *not* work, because browsers block the cross-origin API calls the game
makes from a `file://` page.

## Deploying

Push the repo and point GitHub Pages (or Netlify, Cloudflare Pages, S3 — any
static host) at the project root. There is nothing to build.

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
assets/css/style.css    all styling
assets/js/beaches.js    the beach pool — name, country, lat/lng, article, trivia
assets/js/photos.js     Wikimedia lookup, filtering and preloading
assets/js/game.js       rounds, timer, scoring, both Leaflet maps
vendor/leaflet/         Leaflet 1.9.4 (BSD-2-Clause)
```

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
