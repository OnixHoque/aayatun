#!/usr/bin/env python3
"""Generate a one-theme-per-ayah mapping for the Quran with OpenAI.

Reads the existing offline AI verse context (db/ai_context.db) and the English
translation (db/en_quran.db), asks OpenAI to assign each verse one of twelve
themes, applies a deterministic post-process (disconnected letters ->
Revelation, plus a short manual list), and writes the result to a small
SQLite database (db/ayah_themes.db).

The OpenAI key is read from the environment (OPENAI_API_KEY) or from a local
env file passed with --env-file. It is never written to the repository.
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent

THEMES = [
    (0, 'Tawhid', '#4e79a7'),
    (1, 'Revelation', '#f28e2b'),
    (2, 'Worship', '#59a14f'),
    (3, 'Belief', '#e15759'),
    (4, 'Judgment', '#b07aa1'),
    (5, 'Guidance', '#76b7b2'),
    (6, 'Conduct', '#edc948'),
    (7, 'Justice', '#ff9da7'),
    (8, 'Prophets', '#9c755f'),
    (9, 'Creation', '#7f9c4f'),
    (10, 'Humanity', '#a0cbe8'),
    (11, 'Law', '#6b6b6b'),
]

RUBRIC = """You tag each Quran verse with exactly one dominant theme from this fixed list:
0 Tawhid - Allah's oneness, divine names/attributes, lordship, rejecting shirk; use Creation for nature as proof.
1 Revelation - the Quran and earlier scriptures as the revealed Book: descent, clarity, recitation, preservation, Allah's speech.
2 Worship - acts of worship and turning to Allah: prayer, dua, dhikr, zakah, fasting, hajj, sacrifice, repentance/istighfar.
3 Belief - articles of faith: angels, jinn, the unseen, qadr, messengers/books as objects of belief, faith/kufr in general.
4 Judgment - the Last Day, resurrection, paradise, hell, reckoning, reward/punishment, intercession, final destinies.
5 Guidance - guidance and misguidance, the straight path, steadfastness, gratitude/ingratitude, trials, truth versus falsehood.
6 Conduct - general character and ethics: honesty, patience, humility, modesty, anger, forgiveness, speech, good treatment.
7 Justice - social and economic justice, rights of parents/orphans/poor/neighbours, fairness, contracts, oppression, zakah as social obligation.
8 Prophets - narratives and mention of prophets/messengers and past nations; their stories, trials, and outcomes.
9 Creation - heavens, earth, nature, animals, plants, rain, life/death in the universe, natural signs.
10 Humanity - human origin/nature/fitrah, nafs, moral psychology, regret, accountability of the soul, human creation.
11 Law - legal rulings: halal/haram, marriage, divorce, inheritance, criminal law, evidence, oaths, dietary/commercial/family law, covenants.

Rules:
- Exactly one id per verse: the dominant message, not every association.
- Classify every verse independently. Do not carry a theme forward because nearby verses had it.
- Law is for a verse that itself states a legal ruling: marriage, divorce, inheritance, criminal law, evidence, oaths, dietary rules, contracts, interest. Prayer is Worship; charity/spending is Justice or Worship; Allah's attributes are Tawhid; a prophet's story is Prophets.
- If a verse is a legal prescription, prefer Law; ritual worship defaults to Worship; a prophet's narrative to Prophets.
- For nature used as a sign of God, choose Creation; for divine attributes/oneness, Tawhid.
- Use the translation and the short context provided. For very short or cryptic verses, rely on the passage context.
- Return ONLY a JSON array of N integers in 0..11, one per verse in the order given, with no commentary.

Examples:
2:255 -> 0, 2:22 -> 9, 2:30 -> 8, 2:183 -> 2, 2:282 -> 11, 1:6 -> 5,
2:256 -> 5, 2:243 -> 8, 2:254 -> 7, 2:238 -> 2, 2:177 -> 6, 2:219 -> 11.
"""


def load_key(env_file):
    key = os.environ.get('OPENAI_API_KEY')
    if key:
        return key
    path = Path(env_file) if env_file else Path('/tmp/opencode/openai.env')
    if not path.exists():
        raise SystemExit(f'No OPENAI_API_KEY and no env file at {path}')
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        k = k.strip()
        if k.startswith('export '):
            k = k[len('export '):].strip()
        if k == 'OPENAI_API_KEY':
            return v.strip().strip("'\"")
    raise SystemExit(f'OPENAI_API_KEY not found in {path}')


def clean_text(text):
    return re.sub(r'<[^>]+>', '', text or '').replace('\n', ' ').strip()


def build_verse_lines(surah, con_ctx, con_tr):
    # ai_context.db.verse_analysis.verse is 0-based (0 = ayah 1).
    ctx = {}
    for v, content in con_ctx.execute(
            'select verse, content from verse_analysis where surah=?', (surah,)):
        try:
            d = json.loads(content)
            c = d.get('verse_context', '') or ''
        except Exception:
            c = ''
        c = re.sub(r'\s+', ' ', c).strip()
        if len(c) > 240:
            c = c[:240] + '…'
        ctx[v + 1] = c

    lines = []
    for ayah, text in con_tr.execute(
            'select ayah, text from verses where sura=? order by ayah', (surah,)):
        text = clean_text(text)
        c = ctx.get(ayah, '')
        lines.append(f'{ayah}. {text}' + (f' — Context: {c}' if c else ''))
    return lines


def surah_name(surah, stat):
    try:
        name = stat['Chapter Name'][str(surah)]
        return f'Surah {surah} ({name})'
    except Exception:
        return f'Surah {surah}'


def parse_array(raw, n):
    m = re.search(r'\[[0-9,\s]+\]', raw)
    if not m:
        return None
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(arr, list) or len(arr) != n:
        return None
    if not all(isinstance(x, int) and not isinstance(x, bool) and 0 <= x <= 11 for x in arr):
        return None
    return arr


def classify_chunk(client, model, surah_label, lines, start, n):
    chunk = lines[start:start + n]
    prompt = (
        f'{surah_label}, verses {start + 1} to {start + len(chunk)}. '
        f'Classify each verse below. Return only a JSON array of {len(chunk)} integers.\n'
        + '\n'.join(chunk)
    )
    last_err = None
    for attempt in range(3):
        try:
            r = client.chat.completions.create(
                model=model,
                messages=[
                    {'role': 'system', 'content': RUBRIC},
                    {'role': 'user', 'content': prompt},
                ],
                temperature=0,
                max_tokens=2000,
            )
            raw = r.choices[0].message.content or ''
            arr = parse_array(raw, len(chunk))
            if arr:
                return arr
            last_err = f'bad array (raw {raw[:120]!r})'
        except Exception as e:
            last_err = f'{type(e).__name__}: {str(e)[:200]}'
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f'chunk {start + 1}-{start + len(chunk)} failed: {last_err}')


def classify_surah(client, model, surah, lines, surah_label, chunk_size):
    out = []
    for start in range(0, len(lines), chunk_size):
        n = min(chunk_size, len(lines) - start)
        out.extend(classify_chunk(client, model, surah_label, lines, start, n))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--env-file', default='/tmp/opencode/openai.env')
    ap.add_argument('--model', default='gpt-4o')
    ap.add_argument('--chunk-size', type=int, default=40)
    ap.add_argument('--surahs', default='1-114',
                    help='comma-separated list or range, e.g. 1,2,112-114')
    ap.add_argument('--result', default='/tmp/ayah_themes_result.json')
    ap.add_argument('--db', default=str(REPO / 'db' / 'ayah_themes.db'))
    ap.add_argument('--limit', type=int, default=0,
                    help='stop after this many surahs (0 = all selected)')
    args = ap.parse_args()

    def parse_surahs(spec):
        out = set()
        for part in spec.split(','):
            part = part.strip()
            if not part:
                continue
            if '-' in part:
                a, b = part.split('-', 1)
                out.update(range(int(a), int(b) + 1))
            else:
                out.add(int(part))
        return sorted(out)

    surahs = parse_surahs(args.surahs)
    if args.limit:
        surahs = surahs[:args.limit]

    key = load_key(args.env_file)
    from openai import OpenAI
    client = OpenAI(api_key=key, timeout=300)

    result_path = Path(args.result)
    result = {}
    if result_path.exists():
        result = json.loads(result_path.read_text())
    done = set(result.keys())
    todo = [s for s in surahs if str(s) not in done]
    print(f'{len(done)} surahs already done, {len(todo)} to classify', flush=True)

    con_ctx = sqlite3.connect(REPO / 'db' / 'ai_context.db')
    con_tr = sqlite3.connect(REPO / 'db' / 'en_quran.db')
    try:
        stat = json.loads((REPO / 'db' / 'quran_stat.json').read_text())
    except Exception:
        stat = {}

    for idx, surah in enumerate(todo, 1):
        lines = build_verse_lines(surah, con_ctx, con_tr)
        if not lines:
            raise SystemExit(f'no verses for surah {surah}')
        label = surah_name(surah, stat)
        t = time.time()
        arr = classify_surah(client, args.model, surah, lines, label, args.chunk_size)
        result[str(surah)] = arr
        result_path.write_text(json.dumps(result, ensure_ascii=False))
        counts = Counter(arr)
        top = ', '.join(f'{THEMES[i][1]}:{counts.get(i,0)}' for i in range(12) if counts.get(i,0))
        print(f'[{idx}/{len(todo)}] surah {surah} ({label}) {len(arr)} verses '
              f'in {time.time()-t:.1f}s | {top}', flush=True)

    # Validate the whole result before writing the database.
    expected = {}
    for surah in range(1, 115):
        n = con_tr.execute('select count(*) from verses where sura=?', (surah,)).fetchone()[0]
        expected[str(surah)] = n
    bad = [s for s, n in expected.items() if len(result.get(s, [])) != n]
    if bad:
        raise SystemExit(f'incomplete result for surahs: {bad[:20]} (total {len(bad)})')

    # Deterministic post-processing, applied after the AI pass so a fresh
    # run and a re-run from the cached result agree exactly:
    #   1. Disconnected letters (Alif Lam Meem, Ha Meem, …) always introduce
    #      the Revelation, whatever the model did with them.
    #   2. A short list of iconic mis-tags from manual review, fixed here so
    #      they survive regeneration.
    def _letter_verse(text):
        t = re.sub(r'<[^>]+>', '', text or '').lower()
        t = re.sub(r'[^a-z\s]', ' ', t)
        words = t.split()
        if not words:
            return False
        letters = {
            'alif', 'lam', 'meem', 'mim', 'ra', 'sad', 'saad', 'nun', 'qaf',
            'kaf', 'ha', 'ta', 'ya', 'seen', 'ain', 'ayn', 'sin',
        }
        return all(w in letters for w in words)

    con_tr2 = sqlite3.connect(REPO / 'db' / 'en_quran.db')
    try:
        for surah in range(1, 115):
            arr = result[str(surah)]
            for ayah, text in con_tr2.execute(
                    'select ayah, text from verses where sura=?', (surah,)):
                if _letter_verse(text):
                    arr[ayah - 1] = 1
    finally:
        con_tr2.close()

    MANUAL = {
        (2, 183): 2,   # fasting is worship
        (2, 185): 1,   # Ramadan / revelation of the Qur'an
        (2, 186): 2,   # dua
        (2, 254): 7,   # spending in the way of Allah
        (2, 255): 0,   # Ayat al-Kursi
        (2, 256): 5,   # no compulsion in religion
        (2, 261): 7,   # spending as a parable of charity
        (2, 274): 7,   # spending by night and day
        (2, 286): 5,   # Allah does not charge a soul except within its capacity
        (24, 35): 0,   # Ayat an-Nur: Allah is the Light of the heavens and the earth
        (49, 1): 6,    # conduct towards Allah and His Messenger
        (50, 1): 1,    # oath by the Qur'an
        (68, 1): 1,    # Nun / oath by the pen and what they inscribe
        (78, 1): 4,    # they are asking about the Hour
        (102, 1): 4,   # competition in (worldly) increase
        (103, 1): 10,  # oath by time
    }
    for (surah, verse), theme in MANUAL.items():
        result[str(surah)][verse - 1] = theme

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.execute('PRAGMA journal_mode=WAL')
    con.execute('PRAGMA synchronous=NORMAL')
    con.execute('''CREATE TABLE themes (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL
    )''')
    con.execute('''CREATE TABLE verse_themes (
        surah INTEGER NOT NULL,
        verse INTEGER NOT NULL,
        theme_id INTEGER NOT NULL REFERENCES themes(id),
        PRIMARY KEY (surah, verse)
    )''')
    con.executemany('INSERT INTO themes(id, name, color) VALUES (?, ?, ?)', THEMES)
    rows = []
    for surah in range(1, 115):
        arr = result[str(surah)]
        for offset, theme_id in enumerate(arr):
            rows.append((surah, offset + 1, theme_id))
    con.executemany('INSERT INTO verse_themes(surah, verse, theme_id) VALUES (?, ?, ?)', rows)
    con.execute('''CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )''')
    con.executemany('INSERT INTO meta(key, value) VALUES (?, ?)', [
        ('generated_at', time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())),
        ('model', args.model),
        ('verse_count', str(len(rows))),
        ('theme_count', str(len(THEMES))),
    ])
    con.commit()
    con.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    con.close()
    print(f'wrote {db_path} with {len(rows)} verse themes', flush=True)


if __name__ == '__main__':
    main()
