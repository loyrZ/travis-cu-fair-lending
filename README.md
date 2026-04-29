# Travis CU Fair Lending Explorer

An interactive analytics tool for exploring Travis Credit Union's 2024 HMDA loan application data, sourced directly from the Consumer Financial Protection Bureau.

Slice 1,443 real loan applications across race, ethnicity, age, sex, loan purpose, action taken, county, and loan product type. Aggregate by count, approval rate, average loan amount, average income, average interest rate, or average loan-to-value ratio.

## Why

Fair-lending analysts at financial institutions routinely query HMDA data to evaluate whether their institution serves its communities equitably. This tool is a lightweight BI surface for that workflow, built against real public data — not synthetic.

## Stack

- Node.js + Express backend with parameterized SQL and whitelisted columns
- MySQL with a denormalized fact table optimized for read-heavy analytical queries
- Vanilla JS + Tailwind CDN + Chart.js frontend
- Data: CFPB FFIEC HMDA Modified LAR, 2024

## Running locally

Requires Node 18+ and MySQL 8+.

1. Clone and install:

       git clone https://github.com/loyrz/fair-lending-explorer.git
       cd fair-lending-explorer
       npm install

2. Create a `.env` file in the project root with your MySQL credentials:

       DB_HOST=127.0.0.1
       DB_PORT=3306
       DB_USER=root
       DB_PASSWORD=your_password
       DB_NAME=travis_cu_demo
       PORT=3000

3. Initialize the schema, seed real Travis CU data, then run:

       npm run builddb
       npm run seed
       npm start

4. Open http://localhost:3000

## API

`GET /api/options` returns distinct values for every filterable column.

`GET /api/stats` returns aggregated buckets. Query params:
- `group_by` — derived_race, derived_ethnicity, derived_sex, applicant_age, loan_purpose, action_taken, county_code, or derived_loan_product_type
- `metric` — count, approval_rate, avg_loan_amount, avg_income, avg_interest_rate, or avg_ltv
- `filter_<column>` — comma-separated values for any filterable column

Example: `/api/stats?group_by=loan_purpose&metric=approval_rate&filter_derived_race=White,Asian`

## Roadmap

**v1 (current) — Interactive data exploration**
Slice and aggregate Travis CU's 2024 HMDA loan applications across race, ethnicity, age, sex, loan purpose, action taken, county, and loan product type. Six metrics: count, approval rate, average loan amount, average income, average interest rate, average loan-to-value ratio.

**v2 — Demographic comparison** (APRIL 30)
Pit the applicant pool against the actual reported residence demographics of each census tract, sourced from the U.S. Census Bureau's American Community Survey. Surfaces gaps between who lives in a community and who's applying for loans there.

**v3 — Geographic visualization** (APRIL 30 or MAY 1)
Interactive Leaflet map of Travis CU's service area. Per zip code or census tract: total applications, denial percentage, approval percentage, applicant racial composition, and population racial composition side by side. Lets an analyst see at a glance where the lender's reach matches the underlying community and where it doesn't.

## Disclaimer

Independent academic / portfolio project. Not affiliated with or endorsed by Travis Credit Union or the CFPB. All data is publicly published HMDA data.

## License

MIT