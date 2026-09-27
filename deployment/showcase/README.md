# PeopleLedger online project showcase

Static bilingual presentation player, Mandarin MP3 narration, 20 slides, total
planned runtime 18:49.536 (rounded to 18:50). The viewer clicks Start to enable
sound. Each narration ends with 1.5 seconds before advancing. Pause, resume,
contents navigation, previous/next, seeking, mute and full screen are available.
The current slide's Chinese transcript stays visible below the player.

## Prepare the explicit deployment bundle

Run `node scripts/prepare-assets.cjs` from this directory. Defaults read only:

- `.presentation-build/deck-content.json`
- `.presentation-build/slides/slide-01.png` through `slide-20.png`
- `.presentation-build/audio-work/narration/audio_manifest.json` and its 20 MP3s

The script copies an explicit allowlist into `public/` and verifies audio hashes.
It rejects unexpected files inside public. It never copies application source,
databases, runtime evidence, login data, local paths or repository metadata.

To add final PowerPoint files and use a different final slide-render directory:

```text
node scripts/prepare-assets.cjs --slides "ABSOLUTE_FINAL_SLIDES_DIRECTORY" --pptx "ABSOLUTE_FINAL_DECK.pptx" --ppsx "ABSOLUTE_FINAL_SHOW.ppsx" --require-downloads
```

`--content` and `--audio-manifest` can select replacement source manifests.
Only the PPTX/PPSX input paths persist in `download-sources.local.json`, which is
excluded from deployment. Subsequent preparation keeps these selected downloads.
The Chinese Markdown transcript is generated from the same slide narration.
Do not deploy until both final PowerPoint downloads are present.

## Preview and verify

Run `node scripts/serve.cjs`, then open `http://127.0.0.1:4397`.
Run `node scripts/test-browser.cjs` with Playwright installed to exercise actual
MP3 playback, pause/resume, navigation, automatic advance, full screen, mobile
layout and all media paths. Local QA results and screenshots go into `qa/`.

## Vercel

Use **this showcase directory** as the deployment root. `vercel.json` selects
`public` as the static output, with no installation or build command. The assets
must be prepared locally before deployment. `.vercelignore` allows only public
assets and `vercel.json` into the upload. Do not deploy the repository root.
There are no runtime secrets, server functions or external tracking services.
Vercel configuration follows its official project configuration documentation:
https://vercel.com/docs/project-configuration/vercel-json

The published `asset-manifest.json` contains only relative asset names, byte
sizes and SHA-256 values so the generated allowlist can be reviewed.
