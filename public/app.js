"use strict";

// ---------- State ----------

const state = {
    options: {},        // populated from /api/options
    filters: {},        // { derived_race: ['White','Asian'], ... }
    groupBy: "derived_race",
    metric: "count",
    chart: null,
};

// Filter groups to render in the panel, in order, with display labels
const FILTER_GROUPS = [
    { key: "derived_race", label: "Race" },
    { key: "derived_ethnicity", label: "Ethnicity" },
    { key: "derived_sex", label: "Sex" },
    { key: "applicant_age", label: "Age bracket" },
    { key: "loan_purpose", label: "Loan purpose" },
    { key: "action_taken", label: "Action taken" },
    { key: "county_code", label: "County" },
    { key: "derived_loan_product_type", label: "Loan product type" },
];

// Metric display labels for chart axis / legend
const METRIC_LABELS = {
    count: "Application count",
    approval_rate: "Approval rate (%)",
    avg_loan_amount: "Avg loan amount ($)",
    avg_income: "Avg applicant income ($)",
    avg_interest_rate: "Avg interest rate (%)",
    avg_ltv: "Avg loan-to-value ratio",
};

// ---------- Init ----------

document.addEventListener("DOMContentLoaded", async () => {
    await loadOptions();
    renderFilterPanel();
    bindControls();
    await refreshStats();
});

async function loadOptions() {
    const res = await fetch("/api/options");
    if (!res.ok) {
        document.getElementById("filter-panel").innerHTML =
            `<p class="text-sm text-red-600">Failed to load filters.</p>`;
        return;
    }
    state.options = await res.json();
}

// ---------- Filter Panel ----------

function renderFilterPanel() {
    const panel = document.getElementById("filter-panel");
    panel.innerHTML = "";

    for (const group of FILTER_GROUPS) {
        const values = state.options[group.key] || [];
        if (values.length === 0) continue;

        const groupEl = document.createElement("div");
        groupEl.innerHTML = `
      <p class="filter-group-title">${group.label}</p>
      <div class="space-y-0.5 max-h-44 overflow-y-auto pr-1">
        ${values
            .map(
                (v) => `
          <label class="filter-option">
            <input type="checkbox" data-group="${group.key}" value="${escapeHtml(v)}" />
            <span>${escapeHtml(v)}</span>
          </label>`
            )
            .join("")}
      </div>
    `;
        panel.appendChild(groupEl);
    }

    panel.addEventListener("change", onFilterChange);
}

function onFilterChange(e) {
    if (e.target.tagName !== "INPUT") return;
    const group = e.target.dataset.group;
    const val = e.target.value;
    if (!state.filters[group]) state.filters[group] = [];

    if (e.target.checked) {
        if (!state.filters[group].includes(val)) state.filters[group].push(val);
    } else {
        state.filters[group] = state.filters[group].filter((x) => x !== val);
        if (state.filters[group].length === 0) delete state.filters[group];
    }

    refreshStats();
}

// ---------- Group / Metric Controls ----------

function bindControls() {
    document.getElementById("group-by").addEventListener("change", (e) => {
        state.groupBy = e.target.value;
        refreshStats();
    });
    document.getElementById("metric").addEventListener("change", (e) => {
        state.metric = e.target.value;
        refreshStats();
    });
    document.getElementById("clear-filters").addEventListener("click", clearFilters);
}

function clearFilters() {
    state.filters = {};
    document
        .querySelectorAll('#filter-panel input[type="checkbox"]')
        .forEach((cb) => (cb.checked = false));
    refreshStats();
}

// ---------- Fetch + Render ----------

async function refreshStats() {
    const params = new URLSearchParams();
    params.set("group_by", state.groupBy);
    params.set("metric", state.metric);
    for (const [group, values] of Object.entries(state.filters)) {
        params.set(`filter_${group}`, values.join(","));
    }

    const res = await fetch(`/api/stats?${params.toString()}`);
    if (!res.ok) {
        console.error("stats request failed", res.status);
        return;
    }
    const data = await res.json();

    renderSummary(data);
    renderChart(data);
    renderTable(data);
}

function renderSummary(data) {
    const summary = document.getElementById("summary-line");
    const filterCount = Object.values(state.filters).flat().length;
    const filterText = filterCount === 0 ? "no filters applied" : `${filterCount} filter${filterCount === 1 ? "" : "s"} applied`;
    summary.textContent = `${data.total_rows.toLocaleString()} applications across ${data.buckets.length} ${prettyGroup(data.group_by)} buckets — ${filterText}.`;
}

function renderChart(data) {
    const ctx = document.getElementById("results-chart");
    const labels = data.buckets.map((b) => String(b.bucket ?? "Unknown"));
    const values = data.buckets.map((b) => Number(b.value ?? 0));

    if (state.chart) state.chart.destroy();

    state.chart = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: METRIC_LABELS[state.metric] || state.metric,
                    data: values,
                    backgroundColor: "rgba(99, 102, 241, 0.85)",
                    borderRadius: 6,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (item) => formatValue(state.metric, item.parsed.y),
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: (v) => formatTick(state.metric, v),
                    },
                },
            },
        },
    });
}

function renderTable(data) {
    const tbody = document.getElementById("results-table");
    tbody.innerHTML = "";
    if (data.buckets.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="px-3 py-4 text-center text-slate-400">No data for current filters.</td></tr>`;
        return;
    }
    for (const b of data.buckets) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td class="px-3 py-2">${escapeHtml(String(b.bucket ?? "Unknown"))}</td>
      <td class="px-3 py-2 text-right tabular-nums">${(b.total ?? 0).toLocaleString()}</td>
      <td class="px-3 py-2 text-right tabular-nums">${formatValue(state.metric, b.value)}</td>
    `;
        tbody.appendChild(tr);
    }
}

// ---------- Helpers ----------

function formatValue(metric, raw) {
    if (raw === null || raw === undefined) return "—";
    const v = Number(raw);
    switch (metric) {
        case "count":
            return v.toLocaleString();
        case "approval_rate":
        case "avg_interest_rate":
            return v.toLocaleString() + "%";
        case "avg_loan_amount":
        case "avg_income":
            return "$" + v.toLocaleString();
        case "avg_ltv":
            return v.toLocaleString() + "%";
        default:
            return v.toLocaleString();
    }
}

function formatTick(metric, v) {
    switch (metric) {
        case "avg_loan_amount":
        case "avg_income":
            return "$" + Number(v).toLocaleString();
        case "approval_rate":
        case "avg_interest_rate":
        case "avg_ltv":
            return v + "%";
        default:
            return Number(v).toLocaleString();
    }
}

function prettyGroup(key) {
    const map = {
        derived_race: "race",
        derived_ethnicity: "ethnicity",
        derived_sex: "sex",
        applicant_age: "age bracket",
        loan_purpose: "loan purpose",
        action_taken: "action taken",
        county_code: "county",
        derived_loan_product_type: "loan product",
    };
    return map[key] || key;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}