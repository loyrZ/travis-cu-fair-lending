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

// Race comparison labels (used by both v2 and v3)
const RACE_LABELS = [
    { label: "White",                                     acs: "pop_white_nh",       hmda: "White" },
    { label: "Black or African American",                 acs: "pop_black_nh",       hmda: "Black or African American" },
    { label: "Asian",                                     acs: "pop_asian_nh",       hmda: "Asian" },
    { label: "American Indian or Alaska Native",          acs: "pop_aian_nh",        hmda: "American Indian or Alaska Native" },
    { label: "Native Hawaiian or Other Pacific Islander", acs: "pop_nhpi_nh",        hmda: "Native Hawaiian or Other Pacific Islander" },
    { label: "Hispanic or Latino",                        acs: "pop_hispanic",       hmda: "__ETHNICITY__" },
    { label: "Two or more races",                         acs: "pop_two_or_more_nh", hmda: "2 or more minority races" },
];

// ---------- v1: /api/options ----------

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

// ---------- v1: /api/stats ----------

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

// ---------- v2: /api/comparison ----------

router.get("/comparison", async (req, res) => {
    try {
        const level = req.query.level || "all";
        const geoId = req.query.geo_id;

        if (!["tract", "county", "all"].includes(level)) {
            return res.status(400).json({ error: `Invalid level: ${level}` });
        }
        if (level !== "all" && !geoId) {
            return res.status(400).json({ error: "geo_id is required when level is tract or county" });
        }
        if (geoId && !/^[0-9]{3,11}$/.test(geoId)) {
            return res.status(400).json({ error: "geo_id must be numeric (3-11 digits)" });
        }

        let loanWhere = "";
        let demoWhere = "";
        const loanParams = [];
        const demoParams = [];

        if (level === "tract") {
            loanWhere = "WHERE census_tract = ?";
            demoWhere = "WHERE census_tract = ?";
            loanParams.push(geoId);
            demoParams.push(geoId);
        } else if (level === "county") {
            // loans table stores 5-digit FIPS ("06095"), demographics stores 3-digit ("095")
            const fullFips = "06" + geoId.padStart(3, "0");
            loanWhere = "WHERE county_code = ?";
            demoWhere = "WHERE county_code = ?";
            loanParams.push(fullFips);
            demoParams.push(geoId);
        }

        const [applicantRows] = await pool.query(
            `SELECT derived_race AS race, COUNT(*) AS n
             FROM loans
             ${loanWhere}
             GROUP BY derived_race`,
            loanParams
        );

        const [ethRows] = await pool.query(
            `SELECT derived_ethnicity AS eth, COUNT(*) AS n
             FROM loans
             ${loanWhere}
             GROUP BY derived_ethnicity`,
            loanParams
        );

        const demoSelectCols = RACE_LABELS
            .map(r => `SUM(${r.acs}) AS ${r.acs}`)
            .join(", ");
        const [demoRowsRaw] = await pool.query(
            `SELECT SUM(total_population) AS total_pop, ${demoSelectCols}
             FROM tract_demographics
             ${demoWhere}`,
            demoParams
        );
        const demoRow = demoRowsRaw[0] || {};

        const applicantsByRace = {};
        let applicantTotal = 0;
        for (const row of applicantRows) {
            const key = row.race || "Unknown";
            applicantsByRace[key] = (applicantsByRace[key] || 0) + row.n;
            applicantTotal += row.n;
        }

        const hispanicApplicants = ethRows
            .filter(r => r.eth && /hispanic/i.test(r.eth) && !/not hispanic/i.test(r.eth))
            .reduce((sum, r) => sum + r.n, 0);

        const residentsByRace = {};
        let residentTotal = Number(demoRow.total_pop) || 0;
        for (const r of RACE_LABELS) {
            residentsByRace[r.label] = Number(demoRow[r.acs]) || 0;
        }

        const gaps = RACE_LABELS.map(r => {
            const applicantCount = r.label === "Hispanic or Latino"
                ? hispanicApplicants
                : (applicantsByRace[r.hmda] || 0);
            const residentCount = residentsByRace[r.label] || 0;

            const applicantPct = applicantTotal > 0
                ? +(100 * applicantCount / applicantTotal).toFixed(1)
                : 0;
            const residentPct = residentTotal > 0
                ? +(100 * residentCount / residentTotal).toFixed(1)
                : 0;

            return {
                race: r.label,
                applicant_count: applicantCount,
                resident_count: residentCount,
                applicant_pct: applicantPct,
                resident_pct: residentPct,
                gap: +(applicantPct - residentPct).toFixed(1),
            };
        });

        res.json({
            level,
            geo_id: geoId || null,
            applicants: { total: applicantTotal, by_race: applicantsByRace },
            residents:  { total: residentTotal,  by_race: residentsByRace },
            gaps,
        });
    } catch (err) {
        console.error("/api/comparison error:", err);
        res.status(500).json({ error: "Failed to compute comparison" });
    }
});

// ---------- v2: /api/geographies ----------

router.get("/geographies", async (req, res) => {
    try {
        const [counties] = await pool.query(`
            SELECT DISTINCT county_code AS code
            FROM tract_demographics
            WHERE county_code IS NOT NULL
            ORDER BY county_code
        `);
        const [tracts] = await pool.query(`
            SELECT census_tract AS code, county_code
            FROM tract_demographics
            WHERE census_tract IS NOT NULL
            ORDER BY census_tract
        `);
        res.json({
            counties: counties.map(c => c.code),
            tracts: tracts.map(t => ({ tract: t.code, county: t.county_code })),
        });
    } catch (err) {
        console.error("/api/geographies error:", err);
        res.status(500).json({ error: "Failed to load geographies" });
    }
});

// ---------- v3: /api/map-data ----------

router.get("/map-data", async (req, res) => {
    try {
        const [loanByCounty] = await pool.query(`
            SELECT
                RIGHT(county_code, 3) AS county_code,
                COUNT(*) AS total_apps,
                SUM(CASE WHEN action_taken = 'Loan originated' THEN 1 ELSE 0 END) AS originated,
                SUM(CASE WHEN action_taken = 'Application denied' THEN 1 ELSE 0 END) AS denied,
                SUM(CASE WHEN action_taken = 'Preapproval request denied' THEN 1 ELSE 0 END) AS preapp_denied
            FROM loans
            WHERE county_code IS NOT NULL
            GROUP BY RIGHT(county_code, 3)
        `);

        const [loanByCountyRace] = await pool.query(`
            SELECT
                RIGHT(county_code, 3) AS county_code,
                derived_race AS race,
                COUNT(*) AS n
            FROM loans
            WHERE county_code IS NOT NULL
            GROUP BY RIGHT(county_code, 3), derived_race
        `);

        const [loanByCountyEth] = await pool.query(`
            SELECT
                RIGHT(county_code, 3) AS county_code,
                derived_ethnicity AS eth,
                COUNT(*) AS n
            FROM loans
            WHERE county_code IS NOT NULL
            GROUP BY RIGHT(county_code, 3), derived_ethnicity
        `);

        const demoSelectCols = RACE_LABELS
            .map(r => `SUM(${r.acs}) AS ${r.acs}`)
            .join(", ");
        const [residentsByCounty] = await pool.query(`
            SELECT
                county_code,
                SUM(total_population) AS total_pop,
                ${demoSelectCols}
            FROM tract_demographics
            GROUP BY county_code
        `);

        const counties = {};

        for (const row of loanByCounty) {
            const denied = (row.denied || 0) + (row.preapp_denied || 0);
            const total = row.total_apps || 0;
            counties[row.county_code] = {
                county_code: row.county_code,
                total_apps: total,
                originated: row.originated || 0,
                denied: denied,
                approval_rate: total > 0 ? +(100 * (row.originated || 0) / total).toFixed(1) : 0,
                denial_rate: total > 0 ? +(100 * denied / total).toFixed(1) : 0,
                applicants_by_race: {},
                residents_by_race: {},
                resident_total: 0,
            };
        }

        for (const row of loanByCountyRace) {
            if (!counties[row.county_code]) continue;
            const key = row.race || "Unknown";
            counties[row.county_code].applicants_by_race[key] = row.n;
        }

        const hispanicByCounty = {};
        for (const row of loanByCountyEth) {
            if (row.eth && /hispanic/i.test(row.eth) && !/not hispanic/i.test(row.eth)) {
                hispanicByCounty[row.county_code] = (hispanicByCounty[row.county_code] || 0) + row.n;
            }
        }

        for (const row of residentsByCounty) {
            if (!counties[row.county_code]) {
                counties[row.county_code] = {
                    county_code: row.county_code,
                    total_apps: 0,
                    originated: 0,
                    denied: 0,
                    approval_rate: 0,
                    denial_rate: 0,
                    applicants_by_race: {},
                    residents_by_race: {},
                    resident_total: 0,
                };
            }
            counties[row.county_code].resident_total = Number(row.total_pop) || 0;
            for (const r of RACE_LABELS) {
                counties[row.county_code].residents_by_race[r.label] = Number(row[r.acs]) || 0;
            }
        }

        for (const code of Object.keys(counties)) {
            const c = counties[code];
            const gaps = RACE_LABELS.map(r => {
                const applicantCount = r.label === "Hispanic or Latino"
                    ? (hispanicByCounty[code] || 0)
                    : (c.applicants_by_race[r.hmda] || 0);
                const residentCount = c.residents_by_race[r.label] || 0;
                const applicantPct = c.total_apps > 0
                    ? +(100 * applicantCount / c.total_apps).toFixed(1) : 0;
                const residentPct = c.resident_total > 0
                    ? +(100 * residentCount / c.resident_total).toFixed(1) : 0;
                return {
                    race: r.label,
                    applicant_count: applicantCount,
                    resident_count: residentCount,
                    applicant_pct: applicantPct,
                    resident_pct: residentPct,
                    gap: +(applicantPct - residentPct).toFixed(1),
                };
            });
            c.gaps = gaps;
        }

        res.json({ counties });
    } catch (err) {
        console.error("/api/map-data error:", err);
        res.status(500).json({ error: "Failed to load map data" });
    }
});

module.exports = router;
