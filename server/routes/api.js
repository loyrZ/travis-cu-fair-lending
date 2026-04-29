"use strict";

const express = require("express");
const pool = require("../db");

const router = express.Router();

// ---------- Whitelists (security: never trust client column names directly) ----------

const FILTERABLE = {
    derived_race: "derived_race",
    derived_ethnicity: "derived_ethnicity",
    derived_sex: "derived_sex",
    applicant_age: "applicant_age",
    loan_purpose: "loan_purpose",
    action_taken: "action_taken",
    county_code: "county_code",
    census_tract: "census_tract",
    derived_loan_product_type: "derived_loan_product_type",
};

const GROUPABLE = {
    derived_race: "derived_race",
    derived_ethnicity: "derived_ethnicity",
    derived_sex: "derived_sex",
    applicant_age: "applicant_age",
    loan_purpose: "loan_purpose",
    action_taken: "action_taken",
    county_code: "county_code",
    derived_loan_product_type: "derived_loan_product_type",
};

const METRICS = {
    count: "COUNT(*)",
    approval_rate:
        "ROUND(100 * SUM(CASE WHEN action_taken = 'Loan originated' THEN 1 ELSE 0 END) / COUNT(*), 1)",
    avg_loan_amount: "ROUND(AVG(loan_amount), 0)",
    avg_income: "ROUND(AVG(income), 0)",
    avg_interest_rate: "ROUND(AVG(interest_rate), 3)",
    avg_ltv: "ROUND(AVG(loan_to_value_ratio), 2)",
};

// ---------- /api/options ----------
// Returns distinct values for each filterable column, so the frontend can populate dropdowns.

router.get("/options", async (req, res) => {
    try {
        const result = {};
        for (const col of Object.keys(FILTERABLE)) {
            const [rows] = await pool.query(
                `SELECT DISTINCT \`${col}\` AS v FROM loans WHERE \`${col}\` IS NOT NULL ORDER BY v`
            );
            result[col] = rows.map((r) => r.v);
        }
        res.json(result);
    } catch (err) {
        console.error("/api/options error:", err);
        res.status(500).json({ error: "Failed to load options" });
    }
});

// ---------- /api/stats ----------
// Query params:
//   group_by:   one of GROUPABLE keys
//   metric:     one of METRICS keys
//   filter_<col>:  one or more values, comma-separated (e.g. filter_derived_race=White,Asian)

router.get("/stats", async (req, res) => {
    try {
        const groupByKey = req.query.group_by || "derived_race";
        const metricKey = req.query.metric || "count";

        if (!GROUPABLE[groupByKey]) {
            return res.status(400).json({ error: `Invalid group_by: ${groupByKey}` });
        }
        if (!METRICS[metricKey]) {
            return res.status(400).json({ error: `Invalid metric: ${metricKey}` });
        }

        const groupCol = GROUPABLE[groupByKey];
        const metricExpr = METRICS[metricKey];

        // Build WHERE clauses from filter_<col> params
        const whereClauses = [];
        const params = [];

        for (const [paramName, raw] of Object.entries(req.query)) {
            if (!paramName.startsWith("filter_")) continue;
            const col = paramName.replace("filter_", "");
            if (!FILTERABLE[col]) continue;

            const values = Array.isArray(raw) ? raw : String(raw).split(",");
            const cleaned = values.map((v) => v.trim()).filter(Boolean);
            if (cleaned.length === 0) continue;

            const placeholders = cleaned.map(() => "?").join(",");
            whereClauses.push(`\`${col}\` IN (${placeholders})`);
            params.push(...cleaned);
        }

        const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

        const sql = `
      SELECT \`${groupCol}\` AS bucket,
             COUNT(*) AS total,
             ${metricExpr} AS value
      FROM loans
      ${whereSql}
      GROUP BY \`${groupCol}\`
      ORDER BY total DESC
    `;

        const [rows] = await pool.query(sql, params);

        res.json({
            group_by: groupByKey,
            metric: metricKey,
            filters_applied: whereClauses.length,
            total_rows: rows.reduce((sum, r) => sum + r.total, 0),
            buckets: rows,
        });
    } catch (err) {
        console.error("/api/stats error:", err);
        res.status(500).json({ error: "Failed to compute stats" });
    }
});

module.exports = router;