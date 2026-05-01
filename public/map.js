"use strict";

/**
 * v3: Map View
 *
 * - Leaflet map of Travis CU service area
 * - County polygons colored by total applications
 * - Branch markers as bigger blue dots
 * - Sidebar lists counties with applicants / residents
 * - Hovering a sidebar row highlights the county on the map
 * - Clicking a county opens a detail panel with the v2-style comparison
 */

const COUNTY_NAMES_V3 = {
    "001": "Alameda",
    "013": "Contra Costa",
    "017": "El Dorado",
    "047": "Merced",   // some HMDA records may use this for Merced area
    "055": "Napa",
    "067": "Sacramento",
    "077": "San Joaquin",
    "095": "Solano",
    "097": "Sonoma",
    "099": "Merced",
    "101": "Sutter",
    "113": "Yolo",
};

const mapState = {
    map: null,
    countyLayer: null,
    branchLayer: null,
    countyData: null,
    branches: null,
    geojson: null,
    selectedCounty: null,
    initialized: false,
};

document.addEventListener("DOMContentLoaded", () => {
    if (!document.getElementById("tab-map")) return;

    document.getElementById("tab-map").addEventListener("click", () => {
        // Lazy-init Leaflet only when the map tab is first shown.
        // (Leaflet needs a visible container to size correctly.)
        if (!mapState.initialized) {
            initMap();
        } else {
            // If the map already exists, force a resize since the tab was hidden.
            setTimeout(() => mapState.map.invalidateSize(), 50);
        }
    });
});

async function initMap() {
    mapState.initialized = true;

    // Initialize Leaflet
    mapState.map = L.map("v3-map", {
        zoomControl: true,
        scrollWheelZoom: true,
    }).setView([38.35, -122.0], 9);  // Centered on Vacaville (Travis CU HQ)

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "© OpenStreetMap",
        maxZoom: 18,
    }).addTo(mapState.map);

    // Load all three data sources in parallel
    try {
        const [geojsonRes, dataRes, branchesRes] = await Promise.all([
            fetch("/ca_counties_travis.geojson"),
            fetch("/api/map-data"),
            fetch("/travis_branches.json"),
        ]);

        if (!geojsonRes.ok) throw new Error("Missing /ca_counties_travis.geojson");
        if (!dataRes.ok) throw new Error("Failed to load /api/map-data");
        if (!branchesRes.ok) throw new Error("Missing /travis_branches.json");

        mapState.geojson = await geojsonRes.json();
        mapState.countyData = (await dataRes.json()).counties;
        mapState.branches = (await branchesRes.json()).branches;

        renderCountyLayer();
        renderBranches();
        renderSidebar();
        fitMapToData();
    } catch (err) {
        console.error("Map init failed:", err);
        document.getElementById("v3-sidebar").innerHTML =
            `<p class="text-sm text-rose-600 p-4">
                Failed to load map data: ${err.message}.<br><br>
                Make sure <code>public/ca_counties_travis.geojson</code> exists.
                See README for download instructions.
             </p>`;
    }
}

// ---------- Color scale ----------

function getColor(count, maxCount) {
    if (!count || maxCount === 0) return "#e2e8f0"; // slate-200 — no data
    const t = Math.sqrt(count / maxCount); // sqrt = nicer perceptual scale
    // Indigo gradient: light → dark
    const colors = ["#e0e7ff", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#3730a3"];
    const idx = Math.min(colors.length - 1, Math.floor(t * colors.length));
    return colors[idx];
}

function renderCountyLayer() {
    const counts = Object.values(mapState.countyData).map(c => c.total_apps);
    const maxCount = Math.max(...counts, 1);

    if (mapState.countyLayer) mapState.countyLayer.remove();

    mapState.countyLayer = L.geoJSON(mapState.geojson, {
        style: (feature) => {
            const fips = extractCountyFips(feature);
            const county = mapState.countyData[fips];
            return {
                fillColor: getColor(county?.total_apps || 0, maxCount),
                fillOpacity: 0.65,
                color: "#475569",
                weight: 1.2,
            };
        },
        onEachFeature: (feature, layer) => {
            const fips = extractCountyFips(feature);
            const county = mapState.countyData[fips];
            const name = COUNTY_NAMES_V3[fips] || `County ${fips}`;

            // Bind tooltip
            const apps = county?.total_apps || 0;
            layer.bindTooltip(
                `<strong>${name}</strong><br>${apps.toLocaleString()} applications`,
                { sticky: true, className: "map-tooltip" }
            );

            // Click → open detail panel
            layer.on("click", () => {
                selectCounty(fips);
            });

            // Track for highlight-from-sidebar
            layer._fipsCode = fips;
        },
    }).addTo(mapState.map);
}

function extractCountyFips(feature) {
    // Census GeoJSON uses different property names depending on source.
    const props = feature.properties || {};
    return props.COUNTYFP || props.county_fips || props.GEOID?.slice(-3) || null;
}

// ---------- Branches ----------

function renderBranches() {
    if (mapState.branchLayer) mapState.branchLayer.remove();
    const layer = L.layerGroup();

    for (const branch of mapState.branches) {
        const marker = L.circleMarker([branch.lat, branch.lng], {
            radius: 7,
            fillColor: "#0ea5e9",   // sky-500
            color: "#0c4a6e",       // sky-900
            weight: 2,
            fillOpacity: 0.95,
        });
        marker.bindTooltip(
            `<strong>${branch.name}</strong><br>${branch.address}`,
            { className: "map-tooltip" }
        );
        layer.addLayer(marker);
    }

    mapState.branchLayer = layer.addTo(mapState.map);
}

// ---------- Sidebar ----------

function renderSidebar() {
    const sidebar = document.getElementById("v3-sidebar");

    // Sort counties by application count, descending
    const sorted = Object.values(mapState.countyData)
        .sort((a, b) => b.total_apps - a.total_apps);

    let html = `
        <h3 class="text-sm font-semibold text-slate-900 mb-3">Counties</h3>
        <p class="text-xs text-slate-500 mb-3">
            Hover a row to highlight on the map. Click for a full breakdown.
        </p>
        <div class="space-y-1">
    `;

    for (const c of sorted) {
        const name = COUNTY_NAMES_V3[c.county_code] || `County ${c.county_code}`;
        html += `
            <div class="county-row p-2 rounded hover:bg-indigo-50 cursor-pointer border border-transparent"
                 data-fips="${c.county_code}">
                <div class="flex items-center justify-between">
                    <span class="text-sm font-medium text-slate-800">${name}</span>
                    <span class="text-xs text-slate-500 tabular-nums">${c.total_apps.toLocaleString()} apps</span>
                </div>
                <div class="text-xs text-slate-500 mt-1">
                    Residents: ${c.resident_total.toLocaleString()}
                    · Approval: ${c.approval_rate}%
                </div>
            </div>
        `;
    }
    html += `</div>`;
    sidebar.innerHTML = html;

    // Wire up hover + click
    sidebar.querySelectorAll(".county-row").forEach(row => {
        const fips = row.dataset.fips;
        row.addEventListener("mouseenter", () => highlightCounty(fips));
        row.addEventListener("mouseleave", () => unhighlightCounty(fips));
        row.addEventListener("click", () => selectCounty(fips));
    });
}

// ---------- Highlight ----------

function highlightCounty(fips) {
    if (!mapState.countyLayer) return;
    mapState.countyLayer.eachLayer(layer => {
        if (layer._fipsCode === fips) {
            layer.setStyle({ weight: 3, color: "#dc2626", fillOpacity: 0.85 });
            layer.bringToFront();
        }
    });
}

function unhighlightCounty(fips) {
    if (!mapState.countyLayer) return;
    if (mapState.selectedCounty === fips) return;  // keep selection visible
    mapState.countyLayer.eachLayer(layer => {
        if (layer._fipsCode === fips) {
            mapState.countyLayer.resetStyle(layer);
        }
    });
}

// ---------- Detail Panel ----------

function selectCounty(fips) {
    // Visually mark on map
    if (mapState.selectedCounty && mapState.selectedCounty !== fips) {
        unhighlightCounty(mapState.selectedCounty);
    }
    mapState.selectedCounty = fips;
    highlightCounty(fips);

    // Mark in sidebar
    document.querySelectorAll("#v3-sidebar .county-row").forEach(r => {
        r.classList.toggle("ring-2", r.dataset.fips === fips);
        r.classList.toggle("ring-indigo-500", r.dataset.fips === fips);
    });

    renderDetailPanel(fips);
}

function renderDetailPanel(fips) {
    const panel = document.getElementById("v3-detail");
    const c = mapState.countyData[fips];
    if (!c) {
        panel.innerHTML = `<p class="text-sm text-slate-500">No data for this county.</p>`;
        return;
    }
    const name = COUNTY_NAMES_V3[fips] || `County ${fips}`;

    const sortedGaps = [...c.gaps].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

    let rowsHtml = "";
    for (const g of sortedGaps) {
        const gapClass = g.gap > 0 ? "text-emerald-700" : g.gap < 0 ? "text-rose-700" : "text-slate-500";
        const gapSign = g.gap > 0 ? "+" : "";
        rowsHtml += `
            <tr>
                <td class="px-3 py-2">${escapeHtmlV3(g.race)}</td>
                <td class="px-3 py-2 text-right">
                    <span class="tabular-nums">${g.applicant_count.toLocaleString()}</span>
                    <span class="text-slate-400 text-xs tabular-nums">(${g.applicant_pct}%)</span>
                </td>
                <td class="px-3 py-2 text-right">
                    <span class="tabular-nums">${g.resident_count.toLocaleString()}</span>
                    <span class="text-slate-400 text-xs tabular-nums">(${g.resident_pct}%)</span>
                </td>
                <td class="px-3 py-2 text-right tabular-nums font-medium ${gapClass}">${gapSign}${g.gap}pp</td>
            </tr>
        `;
    }

    panel.innerHTML = `
        <div class="flex items-baseline justify-between mb-3">
            <h3 class="text-lg font-semibold text-slate-900">${name} County</h3>
            <button id="close-detail" class="text-xs text-slate-400 hover:text-slate-700">close ✕</button>
        </div>
        <div class="grid grid-cols-3 gap-3 mb-4">
            <div class="bg-slate-50 rounded p-3">
                <div class="text-xs text-slate-500">Applications</div>
                <div class="text-xl font-semibold tabular-nums">${c.total_apps.toLocaleString()}</div>
            </div>
            <div class="bg-slate-50 rounded p-3">
                <div class="text-xs text-slate-500">Approval rate</div>
                <div class="text-xl font-semibold tabular-nums">${c.approval_rate}%</div>
            </div>
            <div class="bg-slate-50 rounded p-3">
                <div class="text-xs text-slate-500">Denial rate</div>
                <div class="text-xl font-semibold tabular-nums">${c.denial_rate}%</div>
            </div>
        </div>
        <table class="min-w-full text-sm">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                    <th class="px-3 py-2 text-left font-medium">Group</th>
                    <th class="px-3 py-2 text-right font-medium">Applicants</th>
                    <th class="px-3 py-2 text-right font-medium">Residents</th>
                    <th class="px-3 py-2 text-right font-medium">Gap</th>
                </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">${rowsHtml}</tbody>
        </table>
    `;

    document.getElementById("close-detail").addEventListener("click", () => {
        panel.innerHTML = `<p class="text-sm text-slate-400 italic">Click a county to see details.</p>`;
        if (mapState.selectedCounty) {
            unhighlightCounty(mapState.selectedCounty);
            mapState.selectedCounty = null;
        }
        document.querySelectorAll("#v3-sidebar .county-row").forEach(r => {
            r.classList.remove("ring-2", "ring-indigo-500");
        });
    });
}

// ---------- Misc ----------

function fitMapToData() {
    if (mapState.countyLayer) {
        mapState.map.fitBounds(mapState.countyLayer.getBounds(), { padding: [20, 20] });
    }
}

function escapeHtmlV3(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
