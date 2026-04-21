## Selected API
- Endpoint: `https://external-api.autozone.com/sls/b2c/product-discovery-browse-search-data/v1/product-shelves`
- Method: `GET`
- Auth: None
- Pagination: `pageNumber` + `recordsPerPage`
- Fields available: `itemId`, `itemDescription`, `productImageUrl`, `productDetailsPageUrl`, `partNumber`, `brandName`, `lineCode`, `partGroupId`, `partGroupName`, `partTerminologyId`, `taxonomyPath`, `productAttributes`, `vehicleFitment`, `warrantyType`, `badges`, `positionId`, `oemPartNumber`, `oemBrandName`, `bonusReward*`, and more.
- Fields currently missing in old actor: Product identifiers, taxonomy/category metadata, fitment data, brand/part details, structured attributes, warranty labels, review statistics integration.
- Field count: 35+ core product fields (vs old 8 remote job fields).

### Supporting resolver endpoint
- Endpoint: `https://external-api.autozone.com/sls/b2c/product-discovery-seo-data-bs/v2/page-types`
- Purpose: Resolve canonical path redirects and `catalogId` (`partGroupId`) before product shelf requests.

### Keyword mode endpoint
- Endpoint: `https://external-api.autozone.com/sls/b2c/product-discovery-browse-search-data/v1/products/search`
- Method: `POST`
- Purpose: API-first extraction when user provides keyword (or search URL) instead of shelf URL.

## Scoring
| Candidate | JSON | Field richness | Auth-free | Pagination | Score |
|---|---:|---:|---:|---:|---:|
| `product-shelves` | 30 | 25 | 20 | 15 | **90** |
| `products/search` | 30 | 25 | 20 | 15 | **90** |
| `review-statistics` | 30 | 10 | 20 | 0 | 60 |
| JSON-LD only (HTML embedded) | 30 | 10 | 20 | 0 | 60 |

## Rejected/secondary candidates
- `https://www.autozone.com/ecomm/b2c/browse/v3/skus/price-availability/{skuIds}`  
  Rejected as primary source: intermittently blocked in direct HTTP context.
- `https://www.autozone.com/ecomm/b2c/browse/v3/deal/details/{skuIds}`  
  Rejected as primary source: intermittently blocked in direct HTTP context.
- `JSON-LD` / hydration-only extraction from HTML  
  Rejected: not strictly API-first, lower field coverage than dedicated product APIs.

## Notes
- API discovery used URLScan request traces plus JS bundle endpoint extraction.
- Redirect handling is required for some URL patterns (`f-150` -> `f150`) before page-type resolution.
- Actor remains fully HTTP/API based; no DOM parsing is used for data extraction.
