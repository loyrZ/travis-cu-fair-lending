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

## Roadmap

**v1 — Interactive data exploration** (DONE)
Slice and aggregate Travis CU's 2024 HMDA loan applications across race,
ethnicity, age, sex, loan purpose, action taken, county, and loan product
type. Six metrics: count, approval rate, average loan amount, average income,
average interest rate, average loan-to-value ratio.

**v2 — Demographic comparison** (DONE)
Pit the applicant pool against the actual reported residence demographics of
each census tract and county, sourced from the U.S. Census Bureau's American
Community Survey (Table B03002). Surfaces gaps between who lives in a
community and who's applying for loans there.

**v3 — Geographic visualization** (DONE)
Interactive Leaflet map of Travis CU's service area. Per county: total
applications, approval and denial rates, applicant racial composition, and
population racial composition side by side. Branch locations marked. Click
any county for the full demographic comparison; hover the sidebar list to
highlight on the map.

**v4 — Drill-down analysis** (DONE)
Click any bar in the Explorer chart to expand a detailed panel for that slice:
outcome breakdown (accepted / denied / withdrawn), income and loan-amount
distributions (mean, median, quartiles, min, max) split by accepted vs denied,
geographic breakdown by county and census tract, and a sortable sample of
individual applications. Moves from "what happened" to "what happened to whom,
and why."

**v5 — Neural network denial prediction** (planned)
A feedforward neural network trained on the HMDA dataset to predict
application denial probability from applicant and loan features. Served
through an Express endpoint with an interactive what-if UI: adjust race,
ethnicity, age, income, loan amount, DTI, LTV, and loan purpose to see how
the prediction shifts. Includes a counterfactual view showing how denial
probability would change if a single feature were altered, holding everything
else equal — closer to how fair-lending regulators probe for disparate impact.

> Methodological note: this dataset has ~1,400 applications, well below the
> ~20k–100k typically expected for a feedforward NN. The intent is to
> demonstrate end-to-end ML deployment — preprocessing, training, model
> serialization, API serving, and interactive UI — not to claim production
> accuracy. Real fair-lending models typically use logistic regression or
> gradient-boosted trees on much larger institutional datasets.

## Disclaimer

Independent academic / portfolio project. Not affiliated with or endorsed by Travis Credit Union or the CFPB. All data is publicly published HMDA data.

## License

MIT