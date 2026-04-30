"use strict";

/**
 * v2: Demographic Comparison
 * Pits applicant pool against actual resident demographics for a geography.
 */

const COUNTY_NAMES = {
    "013": "Contra Costa",
    "055": "Napa",
    "067": "Sacramento",
    "095": "Solano",
    "097": "Sonoma",
    "113": "Yolo",
};

const demoState = {
    level: "all",
    geoId: null,
    geographies: null,
    chart: null,
};

document.addEventListener("DOMContentLoaded", async () => {
    if (!document.getElementById("demo-level")) return;

    await loadGeographies();
    bindDemoControls();
    populateGeoDropdown();
    await refreshComparison();
});

async function loadGeographies() {
    const res = await fetch("/api/geographies");
    if (!res.ok) {
        console.error("Failed to load geographies");
        return;
    }
    demoState.geographies = await res.json();
}

function bindDemoControls() {
    document.getElementById("demo-level").addEventListener("change", (e) => {
        demoState.level = e.target.value;
        demoState.geoId = null;
        populateGeoDropdown();
        refreshComparison();
    });
    document.getElementById("demo-geo-id").addEventListener("change", (e) => {
        demoState.geoId = e.target.value || null;
        refreshComparison();
    });
}

function populateGeoDropdown() {
    const select = document.getElementById("demo-geo-id");
    select.innerHTML = "";

    if (demoState.level === "all" || !demoState.geographies) {
        select.disabled = true;
        select.innerHTML = `<option value="">— entire service area —</option>`;
        return;
    }

    select.disabled = false;

    if (demoState.level === "county") {
        select.innerHTML =
            `<option value="">Select a county…</option>` +
            demoState.geographies.counties
                .map(c => `<option value="${c}">${COUNTY_NAMES[c] || c} (${c})</option>`)
                .join("");
    } else if (demoState.level === "tract") {
        const byCounty = {};
        for (const t of demoState.geographies.tracts) {
            if (!byCounty[t.county]) byCounty[t.county] = [];
            byCounty[t.county].push(t.tract);
        }
        let html = `<option value="">Select a tract…</option>`;
        for (const county of Object.keys(byCounty).sort()) {
            const name = COUNTY_NAMES[county] || county;
            html += `<optgroup label="${name}">`;
            for (const tract of byCounty[county]) {
                const tractShort = tract.substring(5);
                html += `<option value="${tract}">${tractShort}</option>`;
            }
            html += `</optgroup>`;
        }
        select.innerHTML = html;
    }
}

async function refreshComparison() {
    if (demoState.level !== "all" && !demoState.geoId) {
        renderEmptyComparison();
        return;
    }

    const params = new URLSearchParams();
    params.set("level", demoState.level);
    if (demoState.geoId) params.set("geo_id", demoState.geoId);

    const res = await fetch(`/api/comparison?${params.toString()}`);
    if (!res.ok) {
        console.error("comparison request failed", res.status);
        return;
    }
    const data = await res.json();

    renderComparisonSummary(data);
    renderComparisonChart(data);
    renderGapTable(data);
}

function renderEmptyComparison() {
    document.getElementById("demo-summary").textContent =
        "Select a geography to see the comparison.";
    if (demoState.chart) {
        demoState.chart.destroy();
        demoState.chart = null;
    }
    document.getElementById("gap-table").innerHTML = "";
}

function renderComparisonSummary(data) {
    const label = data.level === "all"
        ? "the full Travis CU service area"
        : data.level === "county"
            ? `${COUNTY_NAMES[data.geo_id] || data.geo_id} County`
            : `tract ${data.geo_id}`;
    document.getElementById("demo-summary").textContent =
        `${data.applicants.total.toLocaleString()} applications vs ` +
        `${data.residents.total.toLocaleString()} residents in ${label}.`;
}

function renderComparisonChart(data) {
    const ctx = document.getElementById("demo-chart");
    const labels = data.gaps.map(g => g.race);
    const applicantPcts = data.gaps.map(g => g.applicant_pct);
    const residentPcts = data.gaps.map(g => g.resident_pct);

    // Stash the gap rows on the chart's dataset so the tooltip can reach them
    const applicantCounts = data.gaps.map(g => g.applicant_count);
    const residentCounts  = data.gaps.map(g => g.resident_count);

    if (demoState.chart) demoState.chart.destroy();

    demoState.chart = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Applicants %",
                    data: applicantPcts,
                    backgroundColor: "rgba(99, 102, 241, 0.85)",
                    borderRadius: 4,
                    // custom field for tooltip
                    rawCounts: applicantCounts,
                },
                {
                    label: "Residents %",
                    data: residentPcts,
                    backgroundColor: "rgba(16, 185, 129, 0.85)",
                    borderRadius: 4,
                    rawCounts: residentCounts,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "top" },
                tooltip: {
                    callbacks: {
                        label: (item) => {
                            const pct = item.parsed.y;
                            const count = item.dataset.rawCounts?.[item.dataIndex] ?? 0;
                            return `${item.dataset.label}: ${pct}% (${count.toLocaleString()})`;
                        },
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: (v) => v + "%" },
                },
            },
        },
    });
}

function renderGapTable(data) {
    const tbody = document.getElementById("gap-table");
    tbody.innerHTML = "";

    const sorted = [...data.gaps].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

    for (const g of sorted) {
        const gapClass = g.gap > 0
            ? "text-emerald-700"
            : g.gap < 0
                ? "text-rose-700"
                : "text-slate-500";
        const gapSign = g.gap > 0 ? "+" : "";

        // Format "count (pct%)" — count is the prominent number, % is the context
        const applicantCell =
            `<span class="tabular-nums">${g.applicant_count.toLocaleString()}</span>` +
            ` <span class="text-slate-400 text-xs tabular-nums">(${g.applicant_pct}%)</span>`;
        const residentCell =
            `<span class="tabular-nums">${g.resident_count.toLocaleString()}</span>` +
            ` <span class="text-slate-400 text-xs tabular-nums">(${g.resident_pct}%)</span>`;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td class="px-3 py-2">${escapeHtml(g.race)}</td>
            <td class="px-3 py-2 text-right">${applicantCell}</td>
            <td class="px-3 py-2 text-right">${residentCell}</td>
            <td class="px-3 py-2 text-right tabular-nums font-medium ${gapClass}">${gapSign}${g.gap}pp</td>
        `;
        tbody.appendChild(tr);
    }
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
