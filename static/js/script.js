const pages = {
	"VERSE_DETAILS" : 1,
	"COMP_ARABIC" : 2,
	"COMP_TRANSLATION" : 3,
	"COMP_TAFSIR_BN" : 4,
	"COMP_TAFSIR_EN" : 5,
	"COMP_MUSHAF_PAGE" : 6,
	"COMP_THEME" : 7,

}

function set_dark_theme(val)
{
	try {
		localStorage.setItem("darktheme", val);
		return true;
	}
	catch (e) {
		// Quota exhausted or storage blocked (private mode) — the theme
		// just won't persist across loads.
		return false;
	}
}
function is_dark_theme()
{
	try {
		let tmp = localStorage.getItem("darktheme");
		if (tmp !== null)
			return tmp;
		else
			return false;
	}
	catch (e) {
		return false;
	}
}

function setValues(pageType, location)
{
	try {
		localStorage.setItem("pageType", pageType);
		localStorage.setItem("location", location);
		return 1;
	}
	catch (e) {
		return -1;
	}
}

function getPageType()
{
	try {
		let tmp = localStorage.getItem("pageType");
		if (tmp !== null)
			return tmp;
		else
			return -1;
	}
	catch (e) {
		return -1;
	}
}

function getLocation()
{
	try {
		let tmp = localStorage.getItem("location");
		if (tmp !== null)
			return tmp;
		else
			return -1;
	}
	catch (e) {
		return -1;
	}
}
