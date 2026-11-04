# AGENTS.md

Aayatun: Flask + Jinja Quran web app. No build step, no bundler, no linter/formatter config, no automated tests, no CI. Frontend is server-rendered templates plus CDN jQuery/Fomantic and `static/`.

## Run & verify

- Run from the repo root; all data paths are relative (`db/…`, `db2/…`, `db3`).
- `flask --app app.py run --debug` (or `python3 -m flask --app app.py run`; see `run_command.md`). `app.py` has no `__main__`, so `python3 app.py` silently does nothing.
- Dependencies: `pip install -r requirements.txt`. Docs target Python 3.10; the local `venv/` is an ignored, empty Python 3.13 skeleton (pip only). Use a fresh 3.10 venv or a Python that already has the deps (`python3` here does).
- `db2/quran_metadata.db` is Git LFS (~311 MB). Without `git lfs pull` verse pages fail.
- No test suite. Smoke-check a route with the real stack (allow a few seconds for outbound calls):
  `python3 -c "import app; print(app.app.test_client().get('/2/255').status_code)"`

## Data layout (directory names are misleading)

- `db/` — live SQLite DBs and JSON/text indexes (`quran.db`, translation/tafsir DBs, `ai_context.db`, `quran_stat.json`, `quran_index.txt`, `ruku_index.txt`, `sarf.json`).
- `db/qcf_verses.json` — **tracked** seed of all 6,236 verses as `{"verses": [[surah, verse, mushaf_page, code_v2], …]}`, generated once from quran.com's `by_page` endpoints with the page column corrected to the **V2** (`v2_page`) Madani page used by the QPC2 fonts. It is the source of truth for QCF text and mushaf-page membership; `_qcf_load_cache` seeds the in-process dict from it (the sqlite cache is only a fallback). Page membership follows V2, not the per-verse `page_number`/V1 page (5:77 says 121 but belongs to V2 page 120). `qcf_page_index` and `library.get_mushaf_page(page)` derive from it. The 56 V1/V2 mismatches were fixed when the layout mode was added.
- `db/mushaf_lines.json` — **tracked** compact line layout for the optional mushaf view: `{"pages": {"604": [["h", 112], ["b"], ["x", [[112, 1, "glyphs"], …]], …]}}` for all 604 V2 pages (560 KB). Generated from [zonetecde/mushaf-layout](https://github.com/zonetecde/mushaf-layout) `v2/mushaf/QPC2/page-XXX.json`; the glyphs are the same QPC V2 set as `code_v2`, so `/font/v4/<page>.woff2` renders them. `library.get_mushaf_lines(page)` lazy-loads it once; keep it in sync with `qcf_verses.json` page membership if either is regenerated.
- The `.txt` indexes (`quran_index.txt`, `ruku_index.txt`, `pos_tags_dict.txt`) are Python literals read with `eval`, not JSON; keep them valid Python when regenerating.
- `ai_context.db.verse_analysis.verse` is **0-based** (0 = ayah 1), unlike every other table; `library.RootDefAdder` applies the `verse - 1` shift.
- `db2/quran_metadata.db` — per-verse pickled dicts used by every verse page (`library.get_verse_pickle`). Git LFS.
- `db3/` — committed prebuilt Whoosh index powering `/search`. `searchtool.create_index()` needs `pd_backup.json`, which is not in the repo; don't try to rebuild the index here.
- `db/fonts/`, `db/qcf_cache.db`, `db/tajweed_cache.db` — gitignored runtime caches, safe to delete; they refetch on demand.
- The non-pickle code path is legacy: `getSurahInfo`, `get_morph`, `get_word_for_word_meaning` read `db/corpus.db`, `db/words.db`, `db/all_word_def.json`, none of which exist. Verse routes use `p_getSurahInfo()`.
- SQL is assembled with f-strings; route params are ints, but use bound parameters for any new string input.

## Architecture

- `app.py` holds all routes (flat, no blueprints). `/<surah>/<verse>` renders `versedetails.html` from `library.get_verse_core` (not `p_getSurahInfo`); `/search` is POST-only (form field `query_str`) and queries Whoosh. `/page/<n>` (1–604, prev/next wrap) renders one Madani mushaf page as a row-per-verse table grouped by surah (`templates/mushaf_page.html` + `library.get_mushaf_page`), with QCF text from the local seed. A third toggle, **Mushaf layout**, hides the table and the other toggles and shows `library.get_mushaf_lines(page)` as printed lines (surah banner, Amiri basmala, glyph lines split into clickable verse segments that open the details modal); it is persisted in `localStorage['aayatun_mushaf_layout_v1']` and off by default. Table toggles default to plain text with translations shown, and both choices persist (`ayahTajweedOn` for the QCF font, `aayatun_mushaf_translation_v1` for translation). Controls are icon-only (`title` + `aria-label` + `aria-pressed`, Material `translate` SVG for translations) because the labels crowded narrow screens; the shared verse modal (`partials/_verse_modal.html`, also used by `/search`) is reused here. The layout view's credit line names zonetecde/mushaf-layout (ISC) and the King Fahd Complex glyphs.
- Verse pages ship only the current verse plus empty accordions. `GET /api/v1/verse/<s>/<v>` is the per-verse core payload (token-protected), `GET /api/v1/verse/<s>/<v>/<section>` renders one accordion section on demand, and `GET /api/v1/surah/<n>` returns the whole surah as compact `[[ayah, translation, page, codev2], …]` (no token, gzip, `no-store` so only the JS memory cache holds it). `library.get_surah_core` is `lru_cache(maxsize=4)` and reads only local DBs (`peek_qcf_ayah` never hits the network; the seed makes it always present).
- `static/js/verse-nav.js` keeps surah payloads in a memory-only LRU (3 entries) and drives the swipe carousel: two 3-pane tracks (ayah + translation), pointer drag with a 25 %/velocity commit, then `applyVerse()` + instant re-centre. No sessionStorage/IndexedDB/service-worker caching of the payload. It preloads the next/prev 3 page fonts.
- Offline verses: `verse-nav.js` writes every verse actually shown (max 60, LRU by timestamp) to `localStorage['aayatun_verse_offline_v1']` (Arabic, translation, QCF text/page, prev/next). `dataFor`/`loadVerse` fall back to it when the API is unreachable, and `static/offline.html` renders the saved verse when an uncached verse navigation fails offline. Do not grow this into a surah-payload cache.
- `templates/base.html` is the shared shell. `templates/comprehensive.html` extends it and is the layout for surah-wide pages (`translation`, `tafsir/*`, `mushaf`). `/mushaf/<surah>` (arabic fulltext) turns DataTables pagination off (`paging:false, stateSave:false`) so the whole surah scrolls like a mushaf; translation/tafsir keep pagination.
- `prayer-time.html` at the repo root is standalone (no Jinja, no base) and served verbatim at `/prayer-time` via `send_from_directory('.', …)`, so it must stay at the root. Its "See details" iframe loads `https://www.aayatun.com/<surah>/<verse>` unless the page is already on `aayatun.com`.
- Per-request network: alquran.cloud (tajweed markup) and quran.com (QCF `code_v2` + per-page COLRv1 fonts). Calls use short timeouts, sqlite caches, background warmers, and a plain-text fallback, so pages must still work when those APIs are down.
- `/font/v4/<page>.woff2` serves page fonts (1–604) with immutable caching and downloads them into `db/fonts/` on first use.

## Frontend gotchas

- Verse-page tajweed: the head script adds `html.tajweed-pending` (hides the server-rendered plain `h1`), and the parse-time script after the controls applies the colored rendering then calls `reveal()`. Keep that init parse-time; moving it back into `DOMContentLoaded` brings back the plain→tajweed flash. `VerseTajweed.renderInto(el, data)` paints any carousel pane (per-page `@font-palette-values`, fonts preloaded with `preloadPage`); the carousel keeps the only `id="ayah"` on the current pane, and neighbour panes are `div.ayah-text` (one `h1` per page).
- The navigation loading bar in `base.html` keeps `showLoading`/`hideLoading` outside jQuery/`DOMContentLoaded` and passes state across pages via `sessionStorage['aayatun_loading']` + `html.is-loading`; iOS Chrome needs this path.
- `static/service-worker.js` precaches the app shell and is registered only from `index.html`; bump `CACHE_NAME` when changing precached assets or caching logic.
- Mushaf layout view (`templates/mushaf_page.html`): its JS runs from the base page's `DOMContentLoaded` block, so `QcfFont` is already defined. It keeps the view `visibility: hidden` until the page font is painted and the lines are fitted (measure at 100 px, scale the widest line to the column, re-fit on resize). Pages 1–2 additionally cap that size at `100 × avail ÷ 1640` because their printed lines are much shorter than a normal page's, which otherwise made their text ~20 % larger than the rest of the mushaf. Only lines flagged `endblock` (last line of a surah or of the page) may stay short; every other line is justified, which is why mid-verse line breaks must not be right-aligned. A verse split across lines shares one `data-surah`/`data-verse`, and the hover/focus handler toggles `.mushaf-seg-active` on every segment of it; the highlight is transient (cleared on leave/click, never stored). The 100 px measuring pass needs `.mushaf-layout { overflow: hidden }` or it flashes a horizontal scrollbar.
- The shared verse modal (`partials/_verse_modal.html`) reveals on the iframe's `DOMContentLoaded` (polled, 40 ms) instead of `load`, and the verse page's two `<audio>` tags use `preload="none"`, so opening a modal downloads no MP3s. Don't move back to `load` or `preload="auto"` without measuring: it added ~600 ms and two external requests per open.
- Frontend dependencies are CDN-only (jsdelivr jQuery/Fomantic, Google Fonts); there is no npm or build output.
- `prayer-time.html` keeps an offline copy of Aladhan calendar months in `localStorage['prayer-times-offline-v1']` (current + next month, keyed by place + `method`/`school`), so the times survive with no connection. Change the `-v1` suffix if the stored shape changes; old keys are ignored.
- PWA scope is fixed at install time: the manifest uses `id`/`scope`/`start_url` `/`, so the app must be installed from `https://www.aayatun.com` (the apex 301s there). An install made from the apex stays in the in-app browser and has to be removed and re-added.

## Repo

- Current branch `deploy` tracks `origin/deploy`; `origin` also has `master`, `develop`, `release`. No CI workflows.
- Python files indent with tabs (`app.py`, `library.py`); match that to avoid mixed-indentation errors.
- Don't commit `db/fonts/` or `db/*cache*.db` (gitignored); keep Git LFS installed for `db2/quran_metadata.db`.
