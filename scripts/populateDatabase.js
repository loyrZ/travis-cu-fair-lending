"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const mysql = require("mysql2/promise");

// ---------- CONFIG ----------

const CSV_PATH = path.join(__dirname, "..", "data", "travis_cu_2024_hmda.csv");
const BATCH_SIZE = 100;

// ---------- HMDA CODE LOOKUPS ----------
// Reference: FFIEC HMDA Filing Instructions Guide

const ACTION_TAKEN = {
    "1": "Loan originated",
    "2": "Application approved but not accepted",
    "3": "Application denied",
    "4": "Application withdrawn by applicant",
    "5": "File closed for incompleteness",
    "6": "Purchased loan",
    "7": "Preapproval request denied",
    "8": "Preapproval request approved but not accepted",
};

const LOAN_PURPOSE = {
    "1": "Home purchase",
    "2": "Home improvement",
    "31": "Refinancing",
    "32": "Cash-out refinancing",
    "4": "Other purpose",
    "5": "Not applicable",
};

// ---------- HELPERS ----------

/**
 * HMDA uses several different "missing/unavailable" values:
 * "NA", "Exempt", empty string, "8888", "9999"
 * Returns null for any of these, otherwise the trimmed value.
 */
function cleanString(value) {
    if (value === undefined || value === null) return null;
    const v = String(value).trim();
    if (v === "" || v === "NA" || v === "Exempt") return null;
    return v;
}

function cleanNumber(value) {
    const v = cleanString(value);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Age comes as a bracket string like "25-34", "65-74", or "8888" (NA).
 */
function cleanAge(value) {
    const v = cleanString(value);
    if (v === null || v === "8888" || v === "9999") return null;
    return v;
}

/**
 * HMDA reports income in thousands of dollars. Convert to actual dollars.
 */
function cleanIncome(value) {
    const n = cleanNumber(value);
    if (n === null) return null;
    return n * 1000;
}

function decode(map, value) {
    const v = cleanString(value);
    if (v === null) return null;
    return map[v] || v; // fall through to raw value if unknown code
}

// ---------- ROW MAPPING ----------

function mapRow(row) {
    return [
        cleanNumber(row.activity_year),
        cleanString(row.lei),
        cleanString(row.state_code),
        cleanString(row.county_code),
        cleanString(row.census_tract),
        cleanString(row["derived_msa-md"]),
        cleanString(row.derived_loan_product_type),
        cleanString(row.derived_dwelling_category),
        decode(LOAN_PURPOSE, row.loan_purpose),
        cleanNumber(row.loan_amount),
        cleanNumber(row.loan_to_value_ratio),
        cleanNumber(row.interest_rate),
        decode(ACTION_TAKEN, row.action_taken),
        cleanString(row.derived_ethnicity),
        cleanString(row.derived_race),
        cleanString(row.derived_sex),
        cleanAge(row.applicant_age),
        cleanIncome(row.income),
        cleanString(row.debt_to_income_ratio),
        cleanNumber(row.tract_population),
        cleanNumber(row.tract_minority_population_percent),
        cleanNumber(row.tract_to_msa_income_percentage),
        cleanNumber(row.ffiec_msa_md_median_family_income),
    ];
}

const COLUMNS = [
    "activity_year",
    "lei",
    "state_code",
    "county_code",
    "census_tract",
    "derived_msa_md",
    "derived_loan_product_type",
    "derived_dwelling_category",
    "loan_purpose",
    "loan_amount",
    "loan_to_value_ratio",
    "interest_rate",
    "action_taken",
    "derived_ethnicity",
    "derived_race",
    "derived_sex",
    "applicant_age",
    "income",
    "debt_to_income_ratio",
    "tract_population",
    "tract_minority_population_percent",
    "tract_to_msa_income_percentage",
    "ffiec_msa_md_median_family_income",
];

// ---------- DB ----------

async function getConnection() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
    });
}

async function clearTable(connection) {
    await connection.query("TRUNCATE TABLE loans;");
    console.log("Cleared existing rows from loans table.");
}

async function insertBatch(connection, batch) {
    const placeholders = batch.map(() => `(${COLUMNS.map(() => "?").join(",")})`).join(",");
    const flat = batch.flat();
    const sql = `INSERT INTO loans (${COLUMNS.join(",")}) VALUES ${placeholders}`;
    await connection.query(sql, flat);
}

// ---------- MAIN ----------

(async function main() {
    let connection = null;
    try {
        if (!fs.existsSync(CSV_PATH)) {
            throw new Error(`CSV file not found at ${CSV_PATH}`);
        }

        console.log(`Reading ${CSV_PATH}...`);
        const fileContents = fs.readFileSync(CSV_PATH, "utf8");

        const records = parse(fileContents, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            relax_quotes: true,
            relax_column_count: true,
        });

        console.log(`Parsed ${records.length} rows from CSV.`);

        connection = await getConnection();
        await clearTable(connection);

        const mapped = records.map(mapRow);

        let inserted = 0;
        for (let i = 0; i < mapped.length; i += BATCH_SIZE) {
            const batch = mapped.slice(i, i + BATCH_SIZE);
            await insertBatch(connection, batch);
            inserted += batch.length;
            process.stdout.write(`Inserted ${inserted}/${mapped.length}\r`);
        }

        console.log(`\nDone. Inserted ${inserted} rows into loans.`);

        // Quick sanity check
        const [counts] = await connection.query(
            "SELECT action_taken, COUNT(*) AS n FROM loans GROUP BY action_taken ORDER BY n DESC;"
        );
        console.log("\nAction breakdown:");
        console.table(counts);

        const [races] = await connection.query(
            "SELECT derived_race, COUNT(*) AS n FROM loans GROUP BY derived_race ORDER BY n DESC;"
        );
        console.log("\nRace breakdown:");
        console.table(races);

        connection.end();
    } catch (error) {
        console.error("Seed failed:", error);
        if (connection) connection.end();
        process.exit(1);
    }
})();