"use strict";
require("dotenv").config();
const mysql = require("mysql2/promise");

/**
 * Adds tract_demographics table to the existing DB.
 * Run AFTER setupDatabase.js. Idempotent — safe to re-run.
 *
 * Schema based on ACS Table B03002 (Hispanic/Latino Origin by Race),
 * which is the standard table for fair-lending demographic analysis.
 * Counts are people, not households.
 */

async function getConnection() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
        database: process.env.DB_NAME,
    });
}

async function makeDemographicsTable(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS \`${process.env.DB_NAME}\`.\`tract_demographics\` (
            id INT UNSIGNED NOT NULL AUTO_INCREMENT,

            -- Geographic key. Must match loans.census_tract format (11-digit GEOID).
            census_tract VARCHAR(11) COLLATE utf8mb4_unicode_ci NOT NULL,

            -- Source metadata
            acs_year SMALLINT UNSIGNED NOT NULL,        -- e.g. 2023 (for 2019-2023 5-year)
            state_code VARCHAR(2) COLLATE utf8mb4_unicode_ci NOT NULL,
            county_code VARCHAR(5) COLLATE utf8mb4_unicode_ci NOT NULL,

            -- Total population (denominator for percentages)
            total_population INT UNSIGNED DEFAULT NULL,

            -- Race/ethnicity counts. These mirror HMDA's derived_race buckets
            -- so the comparison is apples-to-apples.
            -- Hispanic/Latino is treated as ethnicity (orthogonal to race) per Census,
            -- but HMDA collapses it, so we store both views.
            pop_white_nh INT UNSIGNED DEFAULT NULL,                -- White, non-Hispanic
            pop_black_nh INT UNSIGNED DEFAULT NULL,                -- Black or African American, non-Hispanic
            pop_asian_nh INT UNSIGNED DEFAULT NULL,                -- Asian, non-Hispanic
            pop_aian_nh INT UNSIGNED DEFAULT NULL,                 -- American Indian / Alaska Native, non-Hispanic
            pop_nhpi_nh INT UNSIGNED DEFAULT NULL,                 -- Native Hawaiian / Pacific Islander, non-Hispanic
            pop_other_nh INT UNSIGNED DEFAULT NULL,                -- Some other race, non-Hispanic
            pop_two_or_more_nh INT UNSIGNED DEFAULT NULL,          -- Two or more races, non-Hispanic
            pop_hispanic INT UNSIGNED DEFAULT NULL,                -- Hispanic or Latino (any race)

            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

            PRIMARY KEY (id),
            UNIQUE KEY uniq_tract_year (census_tract, acs_year),
            INDEX idx_county (county_code)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log("tract_demographics table ready.");
}

(async function main() {
    let connection = null;
    try {
        connection = await getConnection();
        await makeDemographicsTable(connection);
        connection.end();
    } catch (error) {
        console.error("Setup failed:", error);
        if (connection) connection.end();
        process.exit(1);
    }
})();
