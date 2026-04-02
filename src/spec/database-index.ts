/**
 * Curated index of notable public DoltHub databases.
 * Used by dolthub_discover's "search" action for keyword-based discovery.
 *
 * To update: query DoltHub's GraphQL API for repo listings, then enrich
 * with SHOW TABLES and DESCRIBE calls. See scripts or run manually.
 */

export interface IndexedDatabase {
    database: string;
    description: string;
    tables: string[];
    tags: string[];
    rows?: string;
    notes?: string;
}

export const DATABASE_INDEX: IndexedDatabase[] = [
    // --- Healthcare & Pricing ---
    {
        database: "dolthub/hospital-price-transparency-v3",
        description: "Hospital prices for various insurers — 6K hospitals, 296M negotiated rates by payer, CPT code, inpatient/outpatient",
        tables: ["hospitals", "prices"],
        tags: ["healthcare", "hospital", "pricing", "insurance", "transparency", "CPT", "payer", "negotiated rates", "chargemaster"],
        rows: "296M",
        notes: "Very large — JOINs may timeout. Use targeted WHERE clauses on code or cms_certification_num.",
    },
    {
        database: "dolthub/hospital-price-transparency",
        description: "Hospital prices v1 — 1.4K hospitals, 72.7M prices with CPT/HCPCS codes by NPI and payer",
        tables: ["hospitals", "prices", "cpt_hcpcs"],
        tags: ["healthcare", "hospital", "pricing", "insurance", "transparency", "CPT", "HCPCS", "NPI", "payer"],
        rows: "72.7M",
        notes: "Older but includes cpt_hcpcs lookup table. Faster than v3 for queries.",
    },
    {
        database: "dolthub/transparency-in-coverage",
        description: "Insurance plan negotiated rates — payer-side transparency data with in-network rates by billing code",
        tables: ["in_network", "provider_groups"],
        tags: ["healthcare", "insurance", "payer", "negotiated rates", "coverage", "billing", "in-network"],
        rows: "2.7M",
    },

    // --- Real Estate ---
    {
        database: "dolthub/us-housing-prices",
        description: "US property sale records — address, price, beds, baths, sqft, lat/lon, assessments",
        tables: ["sales", "states"],
        tags: ["real estate", "housing", "property", "home prices", "sales", "mortgage", "assessment"],
        rows: "87M",
    },
    {
        database: "dolthub/us-housing-prices-v2",
        description: "Updated US housing and property sales records",
        tables: ["sales", "states"],
        tags: ["real estate", "housing", "property", "home prices", "sales"],
        rows: "87M+",
    },

    // --- Finance ---
    {
        database: "dolthub/options",
        description: "US equity options chains — bids, asks, vols, and greeks (delta, gamma, theta, vega, rho) plus IV history",
        tables: ["option_chain", "volatility_history"],
        tags: ["finance", "options", "equity", "derivatives", "greeks", "implied volatility", "IV rank", "stock market"],
        rows: "71M",
    },
    {
        database: "dolthub/stock-tickers",
        description: "Stock prices and market caps by exchange",
        tables: ["prices", "symbols"],
        tags: ["finance", "stocks", "tickers", "market cap", "exchange", "prices"],
        rows: "806K",
    },

    // --- Tax & Government ---
    {
        database: "dolthub/irs-soi",
        description: "IRS Statistics of Income — adjusted gross income by zip code, year, state, income category",
        tables: ["agi_by_zip", "allagi", "allnoagi", "column_mappings"],
        tags: ["tax", "IRS", "income", "AGI", "zip code", "government", "statistics", "wealth", "socioeconomic"],
        rows: "1.2M",
    },

    // --- Business ---
    {
        database: "spacelove/us-businesses",
        description: "US business registry — 21M businesses with NAICS, SIC codes, EIN, DUNS, addresses",
        tables: ["businesses", "business_types", "naics", "sic"],
        tags: ["business", "company", "NAICS", "SIC", "EIN", "DUNS", "registry", "corporate"],
        rows: "21M",
    },

    // --- Other ---
    {
        database: "dolthub/us-jails-old",
        description: "US jail populations and incidents — frequently updated inmate data",
        tables: ["incidents", "inmate_population_snapshots", "jails"],
        tags: ["criminal justice", "jails", "incarceration", "inmates", "corrections"],
    },
    {
        database: "dolthub/corona-virus",
        description: "COVID-19 data with demographics — cases, deaths, time series, mortality rates across 26 tables",
        tables: ["cases_by_age", "cases_by_sex", "cases_by_race", "characteristics", "mortality_rates"],
        tags: ["COVID", "coronavirus", "pandemic", "epidemiology", "public health", "mortality", "demographics"],
    },
    {
        database: "dolthub/menus",
        description: "Restaurant menu items collected from around the US",
        tables: ["menu_items"],
        tags: ["food", "restaurants", "menus", "dining", "prices"],
    },
    {
        database: "dolthub/open-images",
        description: "Google Open Images dataset metadata — object detection, segmentation, visual relationships",
        tables: ["images", "annotations", "labels"],
        tags: ["computer vision", "images", "machine learning", "object detection", "Google"],
    },
];

/**
 * Search the database index by keyword. Returns matching databases ranked by relevance.
 */
export function searchDatabases(query: string): IndexedDatabase[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return DATABASE_INDEX;

    const scored = DATABASE_INDEX.map((db) => {
        const searchable = [
            db.database,
            db.description,
            db.tables.join(" "),
            db.tags.join(" "),
            db.notes ?? "",
        ].join(" ").toLowerCase();

        let score = 0;
        for (const term of terms) {
            if (searchable.includes(term)) score++;
            // Boost exact tag matches
            if (db.tags.some((t) => t.toLowerCase().includes(term))) score += 0.5;
        }
        return { db, score };
    });

    return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((s) => s.db);
}
