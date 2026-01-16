const { Router } = require("express");
const axios = require("axios");

const router = Router();

const validKey = (k) => k && k !== "dummy";
const hasGoogleKey = () => validKey(process.env.GOOGLE_MAPS_API_KEY);

const mapGoogleResult = (r) => {
  const comps = r.address_components || [];
  const get = (type) => comps.find((c) => c.types?.includes(type))?.long_name || "";
  const city = get("locality") || get("administrative_area_level_1") || get("administrative_area_level_2");
  const country = get("country");
  const street = get("route");
  const streetNumber = get("street_number");
  const { lat, lng } = r.geometry?.location || {};
  return {
    id: r.place_id,
    label: r.formatted_address,
    city,
    country,
    street,
    streetNumber,
    lat,
    lng,
  };
};

const mapNominatimResult = (r) => {
  const city =
    r.address?.city ||
    r.address?.town ||
    r.address?.village ||
    r.address?.county ||
    r.address?.state ||
    "";
  return {
    id: r.place_id,
    label: r.display_name,
    city,
    country: r.address?.country || "",
    street: r.address?.road || r.address?.pedestrian || "",
    streetNumber: r.address?.house_number || "",
    lat: r.lat ? Number(r.lat) : null,
    lng: r.lon ? Number(r.lon) : null,
  };
};

router.get("/autocomplete", async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({ message: "query required" });
    if (hasGoogleKey()) {
      const url = "https://maps.googleapis.com/maps/api/place/autocomplete/json";
      const { data } = await axios.get(url, {
        params: {
          input: query,
          key: process.env.GOOGLE_MAPS_API_KEY,
          types: "geocode",
        },
      });
      const predictions = data.predictions?.map((p) => ({ description: p.description, place_id: p.place_id })) || [];
      return res.json({ predictions });
    }

    // Fallback to Nominatim autocomplete
    const url = "https://nominatim.openstreetmap.org/search";
    const { data } = await axios.get(url, {
      params: { q: query, format: "json", addressdetails: 1, limit: 8 },
      headers: { "User-Agent": "livadai-app/1.0" },
    });
    const predictions =
      (data || []).map((r) => ({
        description: r.display_name,
        place_id: r.place_id,
      })) || [];
    return res.json({ predictions });
  } catch (err) {
    console.error("Autocomplete error", err.response?.data || err.message);
    return res.status(500).json({ message: "autocomplete failed" });
  }
});

router.get("/geocode", async (req, res) => {
  try {
    const { placeId, text } = req.query;
    if (!placeId && !text) return res.status(400).json({ message: "placeId or text required" });
    if (hasGoogleKey()) {
      const url = "https://maps.googleapis.com/maps/api/geocode/json";
      const params = placeId
        ? { place_id: placeId, key: process.env.GOOGLE_MAPS_API_KEY }
        : { address: text, key: process.env.GOOGLE_MAPS_API_KEY };
      const { data } = await axios.get(url, { params });
      const result = data.results?.[0];
      if (!result) return res.status(404).json({ message: "not found" });
      const { lat, lng } = result.geometry.location;
      const address = result.formatted_address;
      return res.json({ lat, lng, address, components: result.address_components });
    }

    // Fallback: Nominatim
    const url = "https://nominatim.openstreetmap.org/search";
    const { data } = await axios.get(url, {
      params: { q: text, format: "json", addressdetails: 1, limit: 1 },
      headers: { "User-Agent": "livadai-app/1.0" },
    });
    const r = (data || [])[0];
    if (!r) return res.status(404).json({ message: "not found" });
    return res.json({
      lat: r.lat ? Number(r.lat) : null,
      lng: r.lon ? Number(r.lon) : null,
      address: r.display_name,
      components: r.address || {},
    });
  } catch (err) {
    console.error("Geocode error", err.response?.data || err.message);
    return res.status(500).json({ message: "geocode failed" });
  }
});

// Search by free text, normalized response for autocomplete
router.get("/search", async (req, res) => {
  try {
    const { query } = req.query;
    if (!query || query.length < 3) return res.status(400).json({ message: "query must be at least 3 chars" });
    if (hasGoogleKey()) {
      try {
        const url = "https://maps.googleapis.com/maps/api/geocode/json";
        const { data } = await axios.get(url, { params: { address: query, key: process.env.GOOGLE_MAPS_API_KEY } });
        const results = (data.results || []).slice(0, 8).map(mapGoogleResult);
        if (results.length) return res.json(results);
      } catch (err) {
        console.error("Geo Google error, falling back to OSM", err.response?.data || err.message);
      }
    }

    // Fallback: Nominatim free geocoder
    const url = "https://nominatim.openstreetmap.org/search";
    const { data } = await axios.get(url, {
      params: { q: query, format: "json", addressdetails: 1, limit: 8 },
      headers: { "User-Agent": "livadai-app/1.0" },
    });
    const results = (data || []).map(mapNominatimResult);
    return res.json(results);
  } catch (err) {
    console.error("Search geo error", err.response?.data || err.message);
    return res.status(500).json({ message: "search failed" });
  }
});

module.exports = router;
