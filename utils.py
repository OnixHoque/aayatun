from markupsafe import Markup, escape
import re

# def json_to_html(data: dict) -> Markup:
#     """Convert verse-context and word-meaning JSON into Flask-safe HTML."""

#     html = []

#     # Verse context
#     html.append('<section class="verse-context">')
#     html.append("<h2>Verse Context</h2>")

#     for paragraph in data.get("verse_context", "").split("\n\n"):
#         if paragraph.strip():
#             html.append(f"<p>{escape(paragraph)}</p>")

#     html.append("</section>")

#     # Word meanings
#     word_meanings = data.get("word_meanings", [])

#     if word_meanings:
#         html.append('<section class="word-meanings">')
#         html.append("<h2>Word Meanings</h2>")

#         for item in word_meanings:
#             word = escape(item.get("word", ""))
#             classical = escape(item.get("classical_meaning", ""))
#             meaning_here = escape(item.get("meaning_here", ""))
#             notable = escape(item.get("notable_usage", ""))

#             html.append('<article class="word-meaning">')

#             html.append(f'<h3 class="word">{word}</h3>')

#             html.append(
#                 '<div class="meaning-section">'
#                 '<span class="meaning-label">Classical meaning:</span>'
#                 f'<span>{classical}</span>'
#                 '</div>'
#             )

#             html.append(
#                 '<div class="meaning-section">'
#                 '<span class="meaning-label">Meaning here:</span>'
#                 f'<span>{meaning_here}</span>'
#                 '</div>'
#             )

#             html.append(
#                 '<div class="meaning-section">'
#                 '<span class="meaning-label">Notable usage:</span>'
#                 f'<span>{notable}</span>'
#                 '</div>'
#             )

#             html.append("</article>")

#         html.append("</section>")

#     return Markup("\n".join(html))


import re
from markupsafe import Markup, escape


def convert_links(data: dict) -> dict:
    """Convert Markdown links in the known fields of the dict."""

    pattern = re.compile(r'\[([^\]]+)\]\((https?://[^\s)]+)\)')

    def convert(text):
        if not isinstance(text, str):
            return text

        # return pattern.sub(
        #     r'<a href="\2" target="_blank" rel="noopener noreferrer">\1 (\2)</a>',
        #     text
        # )
        return pattern.sub(
            r'source: <a href="\2" target="_blank" rel="noopener noreferrer">\1</a>',
            text
        )

    result = data.copy()

    # verse_context is a string
    if "verse_context" in result:
        result["verse_context"] = convert(result["verse_context"])

    # word_meanings is a list of dictionaries
    if "word_meanings" in result:
        result["word_meanings"] = [
            {
                **item,
                "word": convert(item.get("word", "")),
                "classical_meaning": convert(item.get("classical_meaning", "")),
                "meaning_here": convert(item.get("meaning_here", "")),
                "notable_usage": convert(item.get("notable_usage", "")),
            }
            for item in result["word_meanings"]
        ]

    return result

SAFE_LINK = re.compile(
    r'<a href="https?://[^"<>\s]+" '
    r'target="_blank" '
    r'rel="noopener noreferrer">'
    r'[^<>]*'
    r'</a>'
)

def escape_custom(text):
    if not isinstance(text, str):
        return text

    parts = []
    last = 0

    for match in SAFE_LINK.finditer(text):
        # Escape everything before the known-safe link
        parts.append(escape(text[last:match.start()]))

        # Preserve the link
        parts.append(Markup(match.group(0)))

        last = match.end()

    # Escape everything after the final link
    parts.append(escape(text[last:]))

    return Markup("").join(parts)

def json_to_html(data: dict) -> Markup:
    """Convert verse-context and word-meaning JSON into Flask-safe HTML."""
    
    data = convert_links(data) 

    html = []

    # Verse context
    html.append('<section >')
    html.append('''<h3 style="font-family: 'Open Sans'">Verse Context</h3>''')

    for paragraph in data.get("verse_context", "").split("\n\n"):
        if paragraph.strip():
            html.append(f"<p>{escape_custom(paragraph)}</p>")

    html.append("</section>")

    # Word meanings
    word_meanings = data.get("word_meanings", [])

    if word_meanings:
        html.append('<br><section>')
        html.append('''<h3 style="font-family: 'Open Sans'">Word Meanings</h3>''')

        for item in word_meanings:
            word = escape_custom(item.get("word", ""))
            classical = escape_custom(item.get("classical_meaning", ""))
            meaning_here = escape_custom(item.get("meaning_here", ""))
            notable = escape_custom(item.get("notable_usage", ""))

            html.append('<article>')

            # html.append(f'<h3>{word}</h3>') 
            # <h2 style="font-size: 250%; font-family: 'Scheherazade', serif; padding-top: 20px;"> {{ x[0] }} </h2>
            arabic, pron = re.match(r"^(.*?)\s*\((.*?)\)$", word).groups()
            html.append(f'''<h4 style="font-size: 250%; font-family: 'Scheherazade', serif; padding-top: 20px;">{arabic} <span style="font-family: 'Open Sans'; font-size: 0.35em"> ({pron}) </span></h4>''')
            html.append('<dl>')
            html.append(
                '<div >'
                '<dt><b>Classical meaning</b></dt>'
                f'<dd>{classical}</dd>'
                '</div>'
            )

            html.append(
                '<div >'
                '<dt ><b>Meaning here</b></dt>'
                f'<dd>{meaning_here}</dd>'
                '</div>'
            )

            html.append(
                '<div >'
                '<dt ><b>Notable usage</b></dt>'
                f'<dd>{notable}</dd>'
                '</div>'
            )
            html.append('</dl>')
            html.append("</article>")

        html.append("</section>")

    return Markup("\n".join(html))