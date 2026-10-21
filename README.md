# Photomap

Your local photo library on a world map, with a zoomable timeline that acts as a filter. Everything runs on your machine, and your photos are only ever read, unless you run `bun run writeback --apply`.

## Run

```bash
bun install
bun run scan ~/Pictures        # index a folder (incremental on later runs)
bun run dev                    # http://photomap.localhost:4747
```

You can also start the server with an empty index and add folders from the UI (**Library → Add & scan**).

| Command                                      | What it does                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run scan <folder…>`                     | Register folders and index them; prints library stats. A subfolder of an indexed folder rescans just that part; a parent folder absorbs the indexed folders inside it. Quote paths with spaces (unquoted ones are rejoined when unambiguous)                                                                      |
| `bun run scan`                               | Rescan every registered folder (only new or changed files are read)                                                                                                                                                                                                                                               |
| `bun run scan --thumbs`                      | Also pre-generate every grid thumbnail                                                                                                                                                                                                                                                                            |
| `bun run backfill [-v]`                      | Dry run: estimate locations for photos without GPS from photos taken around them (bursts, same spot before and after, home, nearby)                                                                                                                                                                               |
| `bun run backfill --apply=high\|medium\|low` | Write those estimates to the index at or above a confidence; files are never touched. `--undo` removes them                                                                                                                                                                                                       |
| `bun run estimates <file.json> [--min=…]`    | Apply reviewed estimates (`[{ id, lat, lon, confidence }]`, e.g. worked out series by series from the GPS photos around them) to photos still without a location, at or above a confidence (default medium). Marked `inferred:series`, which `backfill` leaves alone. `--dry-run` previews, `--undo` removes them |
| `bun run geotag <lat, lon> <from> [to]`      | Tag photos without GPS taken in a time range (local time at that place), e.g. `bun run geotag 48.8584, 2.2945 2019-07-14` or `… "2019-07-14 15:00" "2019-07-14 15:30"`. Coordinates paste straight from Google Maps. `--dry-run` previews, `--clear` removes manual tags. Manual tags survive rescans             |
| `bun run writeback [folder…] [-v]`           | Dry run: list the files whose hand-set dates and locations (from the app or `geotag`) aren't in the file yet. Inferred ones are never written                                                                                                                                                                     |
| `bun run writeback [folder…] --apply`        | Write them into the files with `exiftool`: EXIF date, offset and GPS for photos, QuickTime date and location for videos. The file's modified time is kept, and so is the original as `<name>_original` unless `--no-backup`. Files that already agree are skipped                                                 |
| `bun run start`                              | Run the server without watch mode                                                                                                                                                                                                                                                                                 |
| `bun test`                                   | Run the tests                                                                                                                                                                                                                                                                                                     |
| `bun run typecheck`                          | Type check (`bun check`)                                                                                                                                                                                                                                                                                          |
| `bun lint` / `bun lint --fix`                | Lint, optionally applying the safe fixes. It's Bun's built-in command; there's no `lint` script because one would shadow it                                                                                                                                                                                       |
| `bun run format` / `bun run format:check`    | Format the codebase (`bun fmt`, Prettier-compatible, configured in `.prettierrc.json`), or only check it                                                                                                                                                                                                          |

Environment: `PORT` (default 4747), `HOST` (default 127.0.0.1), `PHOTOMAP_DATA` (default `./data`).

**Requirements:** `ffmpeg`/`ffprobe` on PATH for video metadata and poster frames, and `exiftool` for `writeback` (`brew install exiftool`). The typecheck, lint and format commands need Bun 1.4.4 or newer (`bun upgrade --canary` until it's released). On macOS, HEIC and RAW files are decoded with the built-in `sips`.

## Using it

The header switches between two views, **Map** and **Gallery**; the app reopens in the one you used last.

- **Gallery:** every photo, newest first, grouped by day with the countries visited, in justified rows. The date rail on the right jumps through the years (click a year, or drag).
  - **Selecting:** hover a photo and click its circle, Shift-click to extend a range, or use a day header's circle to select the whole day. Esc clears.
  - **Set location…** places all selected photos at once, using the same map picker as single photos. **Reset** puts back what the files say.
- **Map:** photos cluster by location, and each cluster shows its most recent photo and a count. Click a cluster to zoom into it. A cluster that can't be split any further (same spot) opens its photos. **Fit to photos** zooms to whatever the current filter matches.
- **Timeline:**
  - Drag to select a range. It snaps to the bar size you're viewing.
  - Click a bar to select it, and double-click to zoom into it.
  - Scroll or pinch to zoom, and drag the axis to pan. **Esc** clears the selection.
  - Bars are stacked: orange is geotagged, grey has no location.
  - **Map area only** counts just the photos inside the visible map.
- **Sidebar:** photos in the visible map area (newest first), plus a **No location** tab for photos without GPS. Hovering a thumbnail pings its spot on the map and its time on the timeline.
- **Viewer:** ← → to move, **i** for info, **Esc** to close. "Show on map" flies to the photo, and "Show in Finder" reveals the file.
- The map position and time selection live in the URL, so you can bookmark a view.

## How it works

```
scan ──► SQLite index (bun:sqlite) ──► Bun.serve ──► React + MapLibre
          + thumbnail cache             /api/points (binary columns)
                                        /thumb/:size/:id, /original/:id
```

- **Scanner** (`src/scan/`):
  - Walks the folders, skipping hidden folders, `.photoslibrary` and `.lrdata`. Reads EXIF with `exifr` and video tags with `ffprobe`.
  - Unchanged files (same size and mtime) are skipped, and deleted files are marked missing.
  - Countries come from an offline lookup with `country-coder`.
- **Dates** (`src/scan/datetime.ts`): stored as _wall-clock time where the photo was taken_, plus the UTC offset when known. The offset comes from, in order of preference:
  1. EXIF offset tags
  2. the GPS UTC timestamp
  3. the time zone at the GPS position

  Without a capture date, the time comes from, in order:
  1. a full date and time in the camera app's filename (`IMG_20161203_193220`), which also beats the weaker create/modify dates that editors rewrite;
  2. those create/modify dates;
  3. XMP dates;
  4. the GPS clock, or just the GPS date when the time is garbage (some HTC phones);
  5. video creation tags (a GoPro writes its local clock there, though the tag claims UTC);
  6. a date-only filename, or a millisecond timestamp in it (`FB_IMG_1501315576710`);
  7. the file's mtime.

  Picasa's placeholder date (2002-12-08 12:00) is ignored.

  After each scan, photos still without a real date get one from their neighbours (`src/scan/dates.ts`), most precise first:
  1. the unedited original next to an edited copy;
  2. files numbered just before and after it on the same day (`IMAG0169`…`IMAG0171`);
  3. when an editor saved the file. Photoshop's XMP IDs are time-stamped UUIDs, and a photo is taken before it's edited;
  4. numbered neighbours further apart, if consistent with that save time;
  5. the year in a Google Takeout folder name ("Photos from 2012").

  Each photo records which source was used. The viewer flags estimates, and the gallery puts year-only photos under "2012 · Date unknown". When extraction improves, `EXTRACTOR_VERSION` in `scanner.ts` makes the next scan re-read every file once.

- **Client:** the browser downloads one compact binary array (about 30 bytes per photo) and does clustering (`supercluster`, in a Web Worker) and timeline counts locally, so filtering never waits on the server.
- **Thumbnails:** generated by `sharp`, falling back to `sips` and `ffmpeg`. They're cached under `data/thumbs` and generated on demand plus in the background after scans.
- **Security:** the server binds to localhost, rejects foreign `Host` headers and cross-site writes, and only serves files that are in the index.

Map tiles come from [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data). They are the only network requests the app makes.

## Ideas for next steps

- Offline map tiles (Protomaps `.pmtiles` file)
- City-level place names (GeoNames) and place search
- Suggested locations for photos without GPS (from nearby-in-time geotagged ones); GPX import
- Trips: auto-group by time gaps and distance from home
- Heatmap and "route of the day" map modes
- Duplicate detection; local semantic search (CLIP)
