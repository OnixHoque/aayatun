# Aayatun

Aayatun ("An Ayah a Day") is a simple web application built with Flask that delivers one Quranic verse (Ayah) daily, complete with Arabic text, translations, and contextual details. It also includes search functionality to explore verses by surah, keywords, or themes. Inspired by Islamic reflection, it aims to make Quran engagement accessible and daily.

## Features
- **One Ayah per page**: Each ayah has a dedicated page filled with its word-for-word meanings, recitation, tafsir, and other useful contents.
- **Search Tool**: Query verses across surahs with filters for relevance.
- **Responsive Design**: Clean, mobile-friendly interface.

## Tech Stack
- **Backend**: Python with Flask framework.
- **Frontend**: Jinja2 templates, HTML/CSS/JS in `static/` and `templates/`.
- **Database**: SQLite (stored in `db/`, `db2/`, `db3/` for data backups or versions).
- **Utilities**: Custom modules like `library.py` for Quran data handling and `searchtool.py` for querying.

## Quick Setup
1. Clone the repo:
   ```
   git clone https://github.com/OnixHoque/aayatun.git
   cd aayatun
   ```
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
3. (Optional) Set up database: Ensure SQLite files in `db/` are present; run any init scripts if needed.
4. Run the app:
   ```
   python flask_app.py  # Or check run_command.txt for exact command
   ```
5. Visit `http://localhost:5000` in your browser.

## Usage
- **Home**: See today's Ayah with details.
- **Search**: Use `/search` route to find verses (powered by `searchtool.py`).
- Customize: Edit `templates/` for UI tweaks or add translations in the DB.

## Deployment
Hosted example: [onixhoque.pythonanywhere.com](https://onixhoque.pythonanywhere.com). Deploy via PythonAnywhere, Heroku, or similar with Gunicorn.

## Contributing
Fork, PR improvements to search, UI, or new translations. Respect Quran sources—data from reliable APIs or files.

## License
MIT (or add your preferred). 

For issues, open a ticket! 🌙
