"use strict";

/**
 * v5 frontend: Predict tab
 *
 * - Loads dropdown options from /api/predict-options
 * - Renders form for applicant profile
 * - On submit, POSTs to /api/predict, displays prediction + counterfactuals
 */

const predictState = {
    options: null,
    lastResult: null,
    initialized: false,
};

const COUNTY_NAMES_PRED = {
    "06001": "Alameda",       "06013": "Contra Costa", "06017": "El Dorado",
    "06047": "Merced",        "06055": "Napa",         "06061": "Placer",
    "06067": "Sacramento",    "06077": "San Joaquin",  "06081": "San Mateo",
    "06085": "Santa Clara",   "06095": "Solano",       "06097": "Sonoma",
    "06099": "Stanislaus",    "06101": "Sutter",       "06113": "Yolo",
};

const FRIENDLY_LABELS = {
    derived_race: "Race",
    derived_ethnicity: "Ethnicity",
    derived_sex: "Sex",
    applicant_age: "Age bracket",
    loan_purpose: "Loan purpose",
    derived_loan_product_type: "Loan product type",
    debt_to_income_ratio: "Debt-to-income ratio",
    county_code: "County",
    loan_amount: "Loan amount ($)",
    income: "Annual income ($)",
    loan_to_value_ratio: "Loan-to-value ratio (%)",
};

document.addEventListener("DOMContentLoaded", () => {
    const tabBtn = document.getElementById("tab-predict");
    if (!tabBtn) return;

    tabBtn.addEventListener("click", () => {
        if (!predictState.initialized) {
            initPredictTab();
        }
    });
});

async function initPredictTab() {
    predictState.initialized = true;
    const form = document.getElementById("predict-form");
    if (!form) return;

    form.innerHTML = `<p class="text-sm text-slate-400 p-4">Loading model options…</p>`;

    try {
        const res = await fetch("/api/predict-options");
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        predictState.options = await res.json();
        renderForm();
        renderModelInfo();
    } catch (err) {
        form.innerHTML = `
            <div class="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-4">
                <strong>Couldn't load model.</strong>
                <p class="mt-1">${escapePred(err.message)}</p>
                <p class="mt-2 text-rose-600">
                    Make sure you've trained the model:
                    <code class="bg-white px-1 py-0.5 rounded">node scripts/trainModel.js</code>
                </p>
            </div>
        `;
    }
}

// ---------- Form rendering ----------

function renderForm() {
    const opts = predictState.options;
    const form = document.getElementById("predict-form");

    // Pre-select sensible defaults: the most common categorical values + numeric means
    const defaultRow = {
        derived_race: "White",
        derived_ethnicity: "Not Hispanic or Latino",
        derived_sex: "Male",
        applicant_age: "35-44",
        loan_purpose: "Home purchase",
        derived_loan_product_type: "Conventional:First Lien",
        debt_to_income_ratio: "30%-<36%",
        county_code: "06095",
        loan_amount: opts.numeric.loan_amount.mean,
        income: opts.numeric.income.mean,
        loan_to_value_ratio: 80,
    };

    let html = `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">`;

    // Categorical dropdowns
    for (const col of Object.keys(opts.categorical)) {
        const choices = opts.categorical[col];
        const dflt = defaultRow[col];
        html += `
            <label class="block">
                <span class="text-sm font-medium text-slate-700">${escapePred(FRIENDLY_LABELS[col] || col)}</span>
                <select name="${col}" class="pred-input mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm border px-3 py-2 bg-white">
                    ${choices.map(v => {
                        const display = col === "county_code" ? `${COUNTY_NAMES_PRED[v] || v} County (${v})` : v;
                        const sel = v === dflt ? "selected" : "";
                        return `<option value="${escapePred(v)}" ${sel}>${escapePred(display)}</option>`;
                    }).join("")}
                </select>
            </label>
        `;
    }

    // Numeric inputs
    for (const col of Object.keys(opts.numeric)) {
        const dflt = defaultRow[col] ?? opts.numeric[col].mean;
        const placeholder = col === "loan_to_value_ratio"
            ? "e.g. 80"
            : `mean: $${Number(opts.numeric[col].mean).toLocaleString()}`;
        html += `
            <label class="block">
                <span class="text-sm font-medium text-slate-700">${escapePred(FRIENDLY_LABELS[col] || col)}</span>
                <input type="number" name="${col}" value="${dflt}" placeholder="${placeholder}"
                    class="pred-input mt-1 block w-full rounded-md border-slate-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 text-sm border px-3 py-2 bg-white" />
            </label>
        `;
    }

    html += `</div>
        <div class="mt-5 flex justify-end gap-3">
            <button type="button" id="predict-reset" class="text-sm px-4 py-2 text-slate-600 hover:text-slate-900 underline">Reset to defaults</button>
            <button type="button" id="predict-submit" class="text-sm px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 font-medium">
                Predict denial probability →
            </button>
        </div>
    `;

    form.innerHTML = html;

    document.getElementById("predict-submit").addEventListener("click", submitPrediction);
    document.getElementById("predict-reset").addEventListener("click", () => {
        predictState.initialized = false;
        initPredictTab();
        document.getElementById("predict-result").innerHTML = "";
    });
}

function renderModelInfo() {
    const info = document.getElementById("predict-model-info");
    if (!info) return;
    const opts = predictState.options;
    const m = opts.test_metrics || {};
    const date = opts.trained_at ? new Date(opts.trained_at).toLocaleString() : "?";
    info.innerHTML = `
        <p class="text-xs text-slate-500">
            Model trained on ${opts.train_rows.toLocaleString()} applications (${opts.test_rows.toLocaleString()} held out for testing).
            Test accuracy: <strong>${(m.accuracy * 100).toFixed(1)}%</strong>
            · F1: <strong>${m.f1?.toFixed(3) ?? "—"}</strong>
            · Recall on denials: <strong>${(m.recall * 100).toFixed(1)}%</strong>.
            Trained ${escapePred(date)}.
        </p>
        <p class="text-xs text-amber-700 mt-1">
            ⚠ With ~1,400 rows this model is well below typical NN training sizes.
            Treat predictions as illustrative of methodology, not as production-grade.
        </p>
    `;
}

// ---------- Submit + render result ----------

async function submitPrediction() {
    const form = document.getElementById("predict-form");
    const inputs = form.querySelectorAll(".pred-input");
    const profile = {};
    for (const el of inputs) {
        const v = el.value;
        if (v === "" || v == null) continue;
        profile[el.name] = el.tagName === "INPUT" ? Number(v) : v;
    }

    const result = document.getElementById("predict-result");
    result.innerHTML = `<p class="text-sm text-slate-400 p-6">Running prediction…</p>`;

    try {
        const res = await fetch("/api/predict", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(profile),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        predictState.lastResult = data;
        renderResult(data);
    } catch (err) {
        result.innerHTML = `<div class="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-4">Prediction failed: ${escapePred(err.message)}</div>`;
    }
}

function renderResult(data) {
    const result = document.getElementById("predict-result");
    const denialPct = data.predicted_denial;
    const approvalPct = data.predicted_approval;

    // Color the headline by predicted outcome
    const denialColor = denialPct >= 50 ? "text-rose-700" : "text-emerald-700";

    let html = `
        <!-- Headline result -->
        <div class="bg-slate-50 rounded-lg p-5 mb-5">
            <div class="text-xs uppercase tracking-wide text-slate-500 mb-2">Predicted outcome</div>
            <div class="flex items-baseline gap-4">
                <div class="text-5xl font-bold ${denialColor} tabular-nums">${denialPct}%</div>
                <div class="text-sm text-slate-600">denial probability</div>
            </div>
            <div class="mt-3">
                <div class="flex h-3 rounded overflow-hidden border border-slate-200">
                    <div style="width:${approvalPct}%; background:#10b981" title="Approval ${approvalPct}%"></div>
                    <div style="width:${denialPct}%; background:#ef4444" title="Denial ${denialPct}%"></div>
                </div>
                <div class="flex justify-between text-xs text-slate-500 mt-1">
                    <span class="text-emerald-700">Approval ${approvalPct}%</span>
                    <span class="text-rose-700">Denial ${denialPct}%</span>
                </div>
            </div>
        </div>

        <!-- Counterfactuals -->
        <h3 class="text-base font-semibold text-slate-900 mb-1">Counterfactual analysis</h3>
        <p class="text-xs text-slate-500 mb-4">
            How would the prediction shift if a single feature changed, holding everything else equal?
            Positive numbers mean denial probability increases; negative means it decreases.
        </p>
    `;

    for (const col of Object.keys(data.counterfactuals)) {
        const cf = data.counterfactuals[col];
        const label = FRIENDLY_LABELS[col] || col;

        html += `
            <div class="mb-5">
                <div class="text-sm font-medium text-slate-700 mb-1">
                    ${escapePred(label)}
                    <span class="text-xs text-slate-400 font-normal">
                        (current: ${escapePred(cf.current_value || "—")} → ${cf.current_predicted_denial}% denial)
                    </span>
                </div>
                <div class="space-y-1">
        `;

        for (const v of cf.variants) {
            const positive = v.delta > 0;
            const barColor = positive ? "#ef4444" : "#10b981";
            const sign = positive ? "+" : "";
            const widthPct = Math.min(50, Math.abs(v.delta));
            // Center the bar at 50% (the midline); positive deltas bar to the right, negative to the left
            const barLeft = positive ? 50 : (50 - widthPct);

            html += `
                <div class="grid grid-cols-12 gap-2 items-center text-xs">
                    <div class="col-span-4 text-slate-700">${escapePred(v.value)}</div>
                    <div class="col-span-6 relative h-5 bg-slate-50 rounded">
                        <div class="absolute top-0 bottom-0 left-1/2 w-px bg-slate-300"></div>
                        <div class="absolute top-1 bottom-1 rounded" style="left:${barLeft}%; width:${widthPct}%; background:${barColor}"></div>
                    </div>
                    <div class="col-span-2 text-right tabular-nums ${positive ? "text-rose-700" : "text-emerald-700"}">
                        ${sign}${v.delta} pp
                    </div>
                </div>
            `;
        }

        html += `</div></div>`;
    }

    html += `
        <p class="text-xs text-slate-400 mt-4 italic">
            Counterfactuals show the model's behavior, not necessarily ground truth.
            A large counterfactual gap on a protected-class feature (race, sex, age, ethnicity)
            is exactly what fair-lending regulators flag as potential disparate impact.
        </p>
    `;

    result.innerHTML = html;
    result.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapePred(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
