"use strict";
require("dotenv").config();
const mysql = require("mysql2/promise");

function displayWarningMessage(warning) {
    switch (warning.Code) {
        case 1007:
            console.log(`Skipping Database Creation --> ${warning.Message}`);
            break;
        case 1050:
            console.log(`Skipping Table Creation --> ${warning.Message}`);
            break;
    }
}

async function getConnection() {
    return await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });
}

async function makeDatabase(connection) {
    const [result] = await connection.query(
        `CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME};`
    );
    if (result && result.warningStatus > 0) {
        const [warningResult] = await connection.query("SHOW WARNINGS");
        displayWarningMessage(warningResult[0]);
    } else {
        console.log("Created Database!");
    }
}

async function makeLoansTable(connection) {
    const [result] = await connection.query(`
    CREATE TABLE IF NOT EXISTS \`${process.env.DB_NAME}\`.\`loans\` (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
 
      -- HMDA identifiers
      activity_year SMALLINT UNSIGNED NOT NULL,
      lei VARCHAR(20) COLLATE utf8mb4_unicode_ci NOT NULL,
 
      -- Geography
      state_code VARCHAR(2) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      county_code VARCHAR(5) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      census_tract VARCHAR(11) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      derived_msa_md VARCHAR(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
 
      -- Loan attributes
      derived_loan_product_type VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      derived_dwelling_category VARCHAR(100) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      loan_purpose VARCHAR(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      loan_amount DECIMAL(12, 2) DEFAULT NULL,
      loan_to_value_ratio DECIMAL(7, 3) DEFAULT NULL,
      interest_rate DECIMAL(6, 3) DEFAULT NULL,
      action_taken VARCHAR(60) COLLATE utf8mb4_unicode_ci NOT NULL,
 
      -- Applicant demographics (CFPB-derived summary fields)
      derived_ethnicity VARCHAR(80) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      derived_race VARCHAR(120) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      derived_sex VARCHAR(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      applicant_age VARCHAR(10) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
      income DECIMAL(12, 2) DEFAULT NULL,
      debt_to_income_ratio VARCHAR(20) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
 
      -- Census tract / LMI context (Social Impact metrics)
      tract_population INT UNSIGNED DEFAULT NULL,
      tract_minority_population_percent DECIMAL(5, 2) DEFAULT NULL,
      tract_to_msa_income_percentage SMALLINT UNSIGNED DEFAULT NULL,
      ffiec_msa_md_median_family_income INT UNSIGNED DEFAULT NULL,
 
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 
      PRIMARY KEY (id),
      INDEX idx_race (derived_race),
      INDEX idx_ethnicity (derived_ethnicity),
      INDEX idx_action (action_taken),
      INDEX idx_purpose (loan_purpose),
      INDEX idx_tract (census_tract),
      INDEX idx_year (activity_year)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

    if (result && result.warningStatus > 0) {
        const [warningResult] = await connection.query("SHOW WARNINGS");
        displayWarningMessage(warningResult[0]);
    } else {
        console.log("Created Loans Table!");
    }
}

(async function main() {
    let connection = null;
    try {
        connection = await getConnection();
        await makeDatabase(connection);
        await connection.query(`USE ${process.env.DB_NAME}`);
        await makeLoansTable(connection);
        connection.close();
        return;
    } catch (error) {
        console.error(error);
        if (connection != null) {
            connection.close();
        }
    }
})();