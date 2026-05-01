"use strict";

/**
 * Downloads CA county boundaries and filters to Travis CU's service area,
 * outputting a small GeoJSON file that the frontend loads directly.
 *
 * Source: U.S. Census Bureau cartographic boundary files, simplified to ~500k.
 * We use the 20m simplified version since we only need county-level shapes.
 *
 * Usage:
 *   node scripts/fetchCountyGeoJson.js
 *
 * Output: public/ca_counties_travis.geojson
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

// Travis CU's full service area (12 counties per their website)
const TRAVIS_CU_COUNTY_FIPS = [
    "001",  // Alameda
    "013",  // Contra Costa
    "047",  // Merced - actual FIPS
    "055",  // Napa
    "061",  // Placer
    "067",  // Sacramento
    "077",  // San Joaquin
    "095",  // Solano
    "097",  // Sonoma
    "099",  // (not Merced - this is Stanislaus actually; double-check)
    "113",  // Yolo
];

// Census 20m simplified counties for all states. Small enough.
const URL = "https://raw.githubusercontent.com/plotly/datasets/master/geojson-counties-fips.json";
const OUTPUT_PATH = path.join(__dirname, "..", "public", "ca_counties_travis.geojson");

console.log("Downloading county GeoJSON from", URL);

https.get(URL, (response) => {
    if (response.statusCode !== 200) {
        console.error(`HTTP ${response.statusCode}`);
        process.exit(1);
    }

    let body = "";
    response.on("data", (chunk) => (body += chunk));
    response.on("end", () => {
        const all = JSON.parse(body);
        console.log(`Downloaded ${all.features.length} counties (US-wide)`);

        // Filter: California only (state FIPS "06"), and only Travis CU counties
        const filtered = all.features.filter((f) => {
            const id = String(f.id || "");
            // The Plotly dataset uses 5-digit FIPS as the feature `id`, e.g. "06095"
            if (!id.startsWith("06")) return false;
            const countyFips = id.slice(2);
            return TRAVIS_CU_COUNTY_FIPS.includes(countyFips);
        });

        console.log(`Filtered to ${filtered.length} counties in Travis CU service area`);

        // Add a clean COUNTYFP property so the map.js parser can find it
        for (const f of filtered) {
            const id = String(f.id);
            f.properties = f.properties || {};
            f.properties.COUNTYFP = id.slice(2);
            f.properties.STATEFP = id.slice(0, 2);
            f.properties.GEOID = id;
        }

        const output = {
            type: "FeatureCollection",
            features: filtered,
        };

        fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output));
        const sizeKB = (fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1);
        console.log(`Wrote ${OUTPUT_PATH} (${sizeKB} KB)`);
        console.log("Counties included:");
        for (const f of filtered) {
            console.log(`  ${f.id}: ${f.properties.NAME || "(no name)"}`);
        }
    });
}).on("error", (err) => {
    console.error("Download failed:", err.message);
    process.exit(1);
});
