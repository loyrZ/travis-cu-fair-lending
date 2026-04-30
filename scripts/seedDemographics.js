"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const mysql = require("mysql2/promise");

const CSV_PATH = path.join(__dirname, "..", "data", "acs_b03002_ca_2023.csv");
const ACS_YEAR = 2023;
const BATCH_SIZE = 200;

// Travis CU's primary service area in California.
// Solano=095, Yolo=113, Contra Costa=013, Sacramento=067, Napa=055, Sonoma=097
const TRAVIS_CU_COUNTY_FIPS = ["095", "113", "013", "067", "055", "097"];

function cleanInt(value) {
    if (value === undefined || value === null) return null;
    const v = String(value).trim();
    if (v === "" || v === "-" || v === "(X)" || v === "*****" || v === "N" || v === "null") return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeGeoid(geoId) {
    if (!geoId) return null;
    const v = String(geoId).trim();
    const match = v.match(/(\d{11})$/);
    return match ? match[1] : null;
}

const ACS_COLUMNS = {
    total: "B03002_001E",
    white_nh: "B03002_003E",
    black_nh: "B03002_004E",
    aian_nh: "B03002_005E",
    asian_nh: "B03002_006E",
    nhpi_nh: "B03002_007E",
    other_nh: "B03002_008E",
    two_or_more_nh: "B03002_009E",
    hispanic: "B03002_012E",
};

function mapRow(row, geoIdKey) {
    const geoid = normalizeGeoid(row[geoIdKey]);
    if (!geoid) return null;

    const stateCode = geoid.substring(0, 2);
    const countyCode = geoid.substring(2, 5);

    if (stateCode !== "06" || !TRAVIS_CU_COUNTY_FIPS.includes(countyCode)) return null;

    return [
        geoid, ACS_YEAR, stateCode, countyCode,
        cleanInt(row[ACS_COLUMNS.total]),
        cleanInt(row[ACS_COLUMNS.white_nh]),
        cleanInt(row[ACS_COLUMNS.black_nh]),
        cleanInt(row[ACS_COLUMNS.asian_nh]),
        cleanInt(row[ACS_COLUMNS.aian_nh]),
        cleanInt(row[ACS_COLUMNS.nhpi_nh]),
        cleanInt(row[ACS_COLUMNS.other_nh]),
        cleanInt(row[ACS_COLUMNS.two_or_more_nh]),
        cleanInt(row[ACS_COLUMNS.hispanic]),
    ];
}

const INSERT_COLUMNS = [
    "census_tract", "acs_year", "state_code", "county_code",
    "total_population",
    "pop_white_nh", "pop_black_nh", "pop_asian_nh",
    "pop_aian_nh", "pop_nhpi_nh", "pop_other_nh",
    "pop_two_or_more_nh", "pop_hispanic",
];

async function getConnection() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
    });
}

async function clearForYear(connection, year) {
    await connection.query("DELETE FROM tract_demographics WHERE acs_year = ?", [year]);
    console.log(`Cleared existing rows for ACS year ${year}.`);
}

async function insertBatch(connection, batch) {
    const placeholders = batch.map(() => `(${INSERT_COLUMNS.map(() => "?").join(",")})`).join(",");
    const flat = batch.flat();
    const sql = `INSERT INTO tract_demographics (${INSERT_COLUMNS.join(",")}) VALUES ${placeholders}`;
    await connection.query(sql, flat);
}

(async function main() {
    let connection = null;
    try {
        if (!fs.existsSync(CSV_PATH)) {
            throw new Error(`ACS CSV not found at ${CSV_PATH}`);
        }

        console.log(`Reading ${CSV_PATH}...`);
        let fileContents = fs.readFileSync(CSV_PATH, "utf8");

        // Strip UTF-8 BOM if present (common in Census downloads)
        if (fileContents.charCodeAt(0) === 0xFEFF) {
            console.log("Stripped UTF-8 BOM from start of file.");
            fileContents = fileContents.slice(1);
        }

        const records = parse(fileContents, {
            columns: true,
            skip_empty_lines: true,
            relax_quotes: true,
            relax_column_count: true,
        });

        console.log(`Parsed ${records.length} rows from CSV.`);

        if (records.length === 0) throw new Error("No rows parsed.");

        // Find the GEO_ID column key — handle BOM, whitespace, or naming variants
        const firstRowKeys = Object.keys(records[0]);
        const geoIdKey =
            firstRowKeys.find(k => k.replace(/[^A-Z_]/gi, "").toUpperCase() === "GEOID") ||
            firstRowKeys.find(k => k.toUpperCase().includes("GEO"));

        if (!geoIdKey) {
            console.log("Available columns:", firstRowKeys.slice(0, 10));
            throw new Error("Could not find GEO_ID column.");
        }
        console.log(`Using GEO_ID column: "${geoIdKey}"`);
        console.log("Sample GEOIDs:");
        for (let i = 0; i < Math.min(3, records.length); i++) {
            console.log(`  Row ${i}: "${records[i][geoIdKey]}"`);
        }

        // Drop the verbose-label row + state/county summary rows
        // Keep only rows whose total population is purely numeric AND whose GEOID is a tract
        const dataRecords = records.filter((r) => {
            const total = r[ACS_COLUMNS.total];
            return total && /^\d+$/.test(String(total).trim());
        });
        console.log(`After label-row filter: ${dataRecords.length} rows.`);

        const mapped = dataRecords.map(r => mapRow(r, geoIdKey)).filter(Boolean);
        console.log(`Filtered to ${mapped.length} tracts in Travis CU service area.`);

        if (mapped.length === 0) {
            // Diagnostic: show CA tract counts by county
            const countyCounts = {};
            for (const r of dataRecords) {
                const g = normalizeGeoid(r[geoIdKey]);
                if (g && g.substring(0, 2) === "06") {
                    const c = g.substring(2, 5);
                    countyCounts[c] = (countyCounts[c] || 0) + 1;
                }
            }
            console.log("\nDIAGNOSTIC — CA tract counts by county FIPS (top 15):");
            const sorted = Object.entries(countyCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
            console.table(sorted.map(([c, n]) => ({ county_fips: c, tracts: n })));
            throw new Error("No matching tracts. Check the table above against TRAVIS_CU_COUNTY_FIPS.");
        }

        connection = await getConnection();
        await clearForYear(connection, ACS_YEAR);

        let inserted = 0;
        for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
            const batch = mapped.slice(i, i + BATCH_SIZE);
            await insertBatch(connection, batch);
            inserted += batch.length;
            process.stdout.write(`Inserted ${inserted}/${mapped.length}\r`);
        }

        console.log(`\nDone. Inserted ${inserted} tract demographic rows.`);

        const [counties] = await connection.query(`
            SELECT county_code, COUNT(*) AS tracts, SUM(total_population) AS pop
            FROM tract_demographics
            WHERE acs_year = ?
            GROUP BY county_code
            ORDER BY pop DESC
        `, [ACS_YEAR]);
        console.log("\nBy county:");
        console.table(counties);

        connection.end();
    } catch (error) {
        console.error("Seed failed:", error.message);
        if (connection) connection.end();
        process.exit(1);
    }
})();
