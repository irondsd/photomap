# Auto-enhance training

Trains a small model that picks values for the editor's own sliders (`src/edits/model.ts`), so
**Auto** fills in sliders you can still adjust, instead of applying a filter you can't undo.

The examples come from Google Photos: an export has `IMG_1234.jpg` next to `IMG_1234-edited.jpg`,
the photo before and after Google's edit. We don't need Google's slider values (they aren't
exported, and theirs don't measure the same as ours). For each pair, we search for the values of
_our_ sliders that make our renderer turn the original into the closest match to Google's edit.
Those values are the labels, already in our units. A model then learns to predict them from
simple statistics of the original.

Each edit is also used for **synthetic** samples (distort-and-recover): the edit made worse the
way real photos go wrong (under-exposed, a colour cast, flat, dull), with our sliders fitted to
undo the damage. These add variety, and they work even for edits whose original wasn't exported.

Everything is TypeScript on Bun. There's no Python and no ML runtime: the model is about 17,000
numbers in a JSON file. The parts the app also needs live in the app, in `src/edits/auto/`:

- the features (`features.ts`)
- the model format and prediction (`model.ts`)
- the bundled model (`model.json`)

The editor runs them in the browser for its **Auto** button.

## Steps

```bash
cd training
bun cli.ts takeout data/takeout/*.zip  # extract only the edits and their originals → data/photos
bun cli.ts pairs data/photos           # find X / X-edited pairs → data/pairs.json
bun cli.ts prepare                     # fit labels, make synthetic samples → data/samples.jsonl
bun cli.ts stats                       # what's in the dataset, how well the fits went
bun cli.ts train                       # train and compare models → data/model.json, data/metrics.json
bun cli.ts review                      # contact sheet of validation photos → data/review/index.html
bun cli.ts export                      # ship data/model.json to the app → src/edits/auto/model.json
bun test                               # this project's tests (the root `bun test` only runs src/)
```

`takeout` reads all the zips first (an edit and its original can be in different archives), then
extracts just those files from the "Photos from YEAR" folders. Album folders only repeat those
photos, and videos, JSON and unedited photos are skipped. For a 243 GB export, that's 18.5 GB. It
uses macOS's `bsdtar`, because `unzip` garbles non-ASCII names. If it's stopped, running it again
skips files already extracted. You can delete the zips afterwards.

`pairs` also works on any folder, such as a Takeout you extracted yourself. Album copies are
dropped. Edits are matched to originals in the same folder:

- by name, ignoring case
- with the `(1)` counters Takeout adds to repeated names
- with names Takeout cut short
- in any format: a HEIC original goes with its JPEG edit, and HEIC is decoded by macOS's `sips`

`--suffix=edited,editado` sets the words for "edited", when the export isn't in a language
already listed in `src/pairs.ts`.

`prepare` can be stopped and started again: it skips samples it already made. At the 256px
working size a fit costs about a second of CPU. A full Takeout (~5k pairs, plus 3 synthetic
samples for each) takes roughly an hour on the default worker pool.

### Options

| Command   | Option                     | Default | What it does                                                                                       |
| --------- | -------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `prepare` | `--synthetic=N`            | 3       | Synthetic samples per edit                                                                         |
|           | `--no-pairs`               |         | Synthetic samples only                                                                             |
|           | `--size=N`                 | 256     | Working size (long side). Also pass it to `train` and `review`, which reload images from its cache |
|           | `--lambda=X`               | 0.5     | Cost of slider use, in ΔE per 100 points. Higher gives sparser, more consistent labels             |
|           | `--min-structure=X`        | 0.7     | Pairs less alike than this (crops, turns) are rejected                                             |
|           | `--limit=N`, `--workers=N` |         | For trying things out                                                                              |
| `train`   | `--max-fit=X`              | 4       | Leave out pairs our sliders can't reproduce closer than this (mean ΔE)                             |
|           | `--pair-weight=X`          | 3       | With `--synthetic`: how much a real pair counts against a synthetic sample                         |
|           | `--hidden=128,64`          | 128,64  | Hidden layer sizes                                                                                 |
|           | `--synthetic`              |         | Also train on synthetic samples (they made results worse; see Results)                             |
| all       | `--data=DIR`               | `data/` | Where everything is read and written                                                               |

## Reading the results

`train` reports the **mean ΔE** (CIELAB colour difference) between each validation photo, as
rendered with predicted sliders, and Google's edit. ΔE around 1 is barely visible; 5 is an obvious
difference. Each line gives:

- **do nothing**: the untouched original
- **best our sliders can do**: the fitted labels, the ceiling for any model
- **ridge** and **mlp**: the two models

"closes N% of the gap" is how far the chosen model gets from doing nothing toward that ceiling.

Photos are split between training and validation by photo, never by sample, so a photo's
synthetic copies can't leak into validation.

Pairs are rejected or left out when:

- their shapes differ (a crop or a turn)
- their structure differs (`structure` in `src/image.ts`)
- the edit drained the colour (a black-and-white filter)
- our sliders can't get close (`--max-fit`): other filters, or local edits

`data/rejects.jsonl` lists the rejected ones, with reasons.

## Results (first Takeout, November 2026)

The data, from 5,230 Google edits:

- **4,891 usable pairs.** 337 were rejected: 126 changed shape, 163 changed content (cropped or
  straightened), and 48 were black-and-white filters.
- **Fit quality.** Our sliders bring the mean ΔE between each original and Google's edit from
  5.3 down to 1.9. That's the ceiling for any model.
- **What Google's edits do here:** mostly saturation, lifted shadows, deeper blacks and a little
  warmth.

On 300 held-out photos, mean ΔE to Google's edit:

| Model                           | ΔE   | Gap closed |
| ------------------------------- | ---- | ---------- |
| Do nothing                      | 4.85 | 0%         |
| Ridge                           | 3.65 | 37%        |
| MLP 64→64, with synthetic       | 3.81 | 32%        |
| **MLP 128→64, real pairs only** | 3.27 | **49%**    |
| Our sliders fitted (ceiling)    | 1.62 | 100%       |

Synthetic samples made the model _worse_. The damage they simulate is bigger and of a different
kind from what Google actually corrects on phone photos, so they pull predictions toward heavy
fixes. `train` now uses real pairs only unless you pass `--synthetic`. To save the time,
`prepare --synthetic=0` skips making them.

The features see only global statistics, never content. Using what is in the photo (faces, sky,
night scenes) is the next step, if this isn't good enough.

## Files

In the app, `src/edits/auto/`:

- `features.ts`: what the model sees of a photo. Bump `FEATURE_VERSION` on any change, then
  `prepare` again (old samples are ignored), `train` and `export`.
- `model.ts`: the model format and prediction.
- `index.ts`: `autoTweaks()`, used by the editor.

Here:

| File             | Role                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| `src/takeout.ts` | Extracts only the training photos from Takeout zips                    |
| `src/pairs.ts`   | Takeout naming rules: which file is whose edit                         |
| `src/image.ts`   | Decoding, orientation, the working-size cache, the structure check     |
| `src/fit.ts`     | Fitting our sliders between two images (coordinate descent on mean ΔE) |
| `src/distort.ts` | Seeded synthetic damage                                                |
| `src/nn.ts`      | Ridge regression and a small MLP with Adam                             |
| `src/prepare.ts` | Builds `samples.jsonl` on a pool of `fit.worker.ts`                    |
| `src/train.ts`   | Split, train, compare in image space                                   |
| `src/review.ts`  | The contact sheet                                                      |

`data/` is git-ignored. It holds derived data from your own photos, so keep it that way.
