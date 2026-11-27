"""Flask integration for Aayatun's meaning search."""
from functools import lru_cache
import json

from flask import Blueprint, render_template, request

from . import meaning_search
from .meaning_search import ASSET_ROOT

blueprint = Blueprint(
    'meaning_search', __name__, static_folder='static',
    static_url_path='/static/meaning', template_folder='templates',
)


@lru_cache(maxsize=4)
def _manifest_available(scope, version):
    path = ASSET_ROOT / ('all-fields-index.json' if scope == 'all-fields' else 'index.json')
    try:
        manifest = json.loads(path.read_text(encoding='utf8'))
        if scope == 'all-fields':
            if manifest.get('fusion', {}).get('status') != 'frozen':
                return False
            files = [field['file'] for field in manifest['fields']]
        else:
            files = [manifest['file']]
        return bool(files) and all((ASSET_ROOT / name).is_file() for name in files)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False


def _available(scope):
    path = ASSET_ROOT / ('all-fields-index.json' if scope == 'all-fields' else 'index.json')
    try:
        stat = path.stat()
    except OSError:
        return False
    return _manifest_available(scope, (stat.st_ino, stat.st_mtime_ns, stat.st_size))


def search_modes():
    scopes = tuple(scope for scope in ('all-fields', 'translation') if _available(scope))
    return {'meaning_scopes': scopes, 'meaning_scope': scopes[0] if scopes else ''}


def register(app):
    app.register_blueprint(blueprint)
    app.context_processor(search_modes)


def render_results(query):
    scope = request.form.get('meaning_scope') or 'translation'
    results, meta = meaning_search.search(
        request.form.getlist('meaning_ref'), request.form.get('meaning_corpus'), scope=scope,
    )
    return render_template(
        'search.html', query=query, results=results, suggestions=[], corrected=None,
        limit_label=10, filter_value='all:' if scope == 'all-fields' else 'translation:',
        truncated=False, search_error=meta['error'], search_mode='meaning',
        meaning_form_scope=scope,
    )
