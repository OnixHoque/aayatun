const pages = {
	"VERSE_DETAILS" : 1,
	"COMP_ARABIC" : 2,
	"COMP_TRANSLATION" : 3,
	"COMP_TAFSIR_BN" : 4,
	"COMP_TAFSIR_EN" : 5,

}

function set_dark_theme(val)
{
	if(typeof(Storage) !== "undefined") {
		localStorage.setItem("darktheme", val);
		return true;
	}
	else
		return false;
}
function is_dark_theme()
{
	if(typeof(Storage) !== "undefined") {
		let tmp = localStorage.getItem("darktheme");
		if (tmp !== null)
			return tmp;
		else
			return false;
	}
	else
		return false;
}

function setValues(pageType, location)
{
	if(typeof(Storage) !== "undefined") {
    	localStorage.setItem("pageType", pageType);
		localStorage.setItem("location", location);
		return 1;
	}
	else
		return -1;
}

function getPageType()
{
	if(typeof(Storage) !== "undefined") {
		let tmp = localStorage.getItem("pageType");
		if (tmp !== null)
			return tmp;
		else
			return -1;
	}
	return -1;
}

function getLocation()
{
	if(typeof(Storage) !== "undefined") {
		let tmp = localStorage.getItem("location");
		if (tmp !== null)
			return tmp;
		else
			return -1;
	}
	return -1;
}