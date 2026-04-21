# AutoZone Products Scraper
Collect structured AutoZone product listings from shelf URLs or keyword searches.  
Build clean datasets for catalog analysis, price monitoring workflows, and automotive parts research.  
The actor supports pagination, market-aware collection, and null-free output records.

## Features

- **URL or keyword input** — Run by product shelf URL or search keyword.
- **Pagination controls** — Limit extraction by records and page count.
- **Market selection** — Use `location` to target United States, Mexico, or Brazil.
- **Clean dataset output** — Empty and null values are removed from records.
- **Review metrics included** — Product records include available review statistics.

## Use Cases

### Parts Catalog Research
Collect brake pads, filters, batteries, and other automotive categories at scale.  
Use consistent product fields for catalog mapping and enrichment.

### Competitive Monitoring
Track changes in product availability, assortment depth, and brand coverage.  
Run on schedule to maintain current benchmark datasets.

### Marketplace Intelligence
Analyze part numbers, fitment labels, and category structure for demand planning.  
Use extracted fields for downstream BI dashboards.

### Content and SEO Planning
Identify top product clusters and category patterns for editorial or campaign planning.  
Build long-tail keyword and category opportunity lists from real shelf data.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | String | No | `https://www.autozone.com/brakes-and-traction-control/brake-pads/ford` | AutoZone URL for URL-based extraction. |
| `keyword` | String | No | `brake pads ford` | Keyword for search-based extraction when URL is not used. |
| `location` | String | No | `United States` | Market hint (`United States`, `Mexico`, `Brazil`). |
| `results_wanted` | Integer | No | `20` | Maximum number of records to collect. |
| `max_pages` | Integer | No | `20` | Maximum result pages to process. |
| `proxyConfiguration` | Object | No | `{ "useApifyProxy": false }` | Proxy settings for network routing. |

---

## Output Data

Each dataset item can contain:

| Field | Type | Description |
|---|---|---|
| `sourceMode` | String | Extraction mode (`url` or `keyword`). |
| `sourceInput` | String | Original URL or keyword used for the run. |
| `country` | String | Market country code (for example `USA`). |
| `pageNumber` | Integer | Page index where the item was found. |
| `rankOverall` | Integer | Global rank in the run output. |
| `itemId` | String | Product SKU identifier. |
| `itemDescription` | String | Product title. |
| `brandName` | String | Product brand. |
| `partNumber` | String | Product part number. |
| `productDetailsPageUrl` | String | Product detail page path. |
| `productImageUrl` | String | Product image URL. |
| `partGroupName` | String | Part family/group name. |
| `taxonomyPath` | String | Category taxonomy path. |
| `reviewStatistics` | Object | Aggregated review metrics for the SKU. |

---

## Usage Examples

### URL Mode

```json
{
    "url": "https://www.autozone.com/brakes-and-traction-control/brake-pads/ford",
    "results_wanted": 50,
    "max_pages": 5
}
```

### Keyword Mode

```json
{
    "keyword": "duralast brake pads",
    "location": "United States",
    "results_wanted": 30,
    "max_pages": 3
}
```

### Mexico Market Search

```json
{
    "keyword": "balatas",
    "location": "Mexico",
    "results_wanted": 40,
    "max_pages": 4
}
```

---

## Sample Output

```json
{
    "sourceMode": "url",
    "sourceInput": "https://www.autozone.com/brakes-and-traction-control/brake-pads/ford",
    "country": "USA",
    "pageNumber": 1,
    "rankOverall": 1,
    "itemId": "905934",
    "itemDescription": "Duralast Ceramic Brake Pads D1212",
    "brandName": "Duralast",
    "partNumber": "D1212",
    "productDetailsPageUrl": "/p/duralast-brake-pads-d1212/905934",
    "productImageUrl": "https://contentassets.autozone.com/product_image/USA/1684/CFHH/D1212/D1212-01.jpg",
    "partGroupName": "Brake Pads",
    "taxonomyPath": "/brakes/brake-pads-wear-indicator-sensors/brake-pads",
    "reviewStatistics": {
        "skuNumber": "905934",
        "averageOverallRating": 4.6,
        "totalReviewCount": 258
    }
}
```

---

## Tips for Best Results

### Choose Specific Inputs
- Use direct category URLs for tighter results.
- Use precise keywords to reduce broad matches.

### Keep Test Runs Small First
- Start with `results_wanted: 20` to validate output quickly.
- Increase limits after confirming data quality.

### Use Market Hints Intentionally
- Set `location` to `United States`, `Mexico`, or `Brazil`.
- Keep market consistent across scheduled runs for stable comparisons.

---

## Integrations

Connect your dataset with:

- **Google Sheets** — Build live tracking sheets.
- **Airtable** — Create searchable product databases.
- **Make** — Trigger downstream automations.
- **Zapier** — Connect extraction runs with business workflows.
- **Webhooks** — Push run completion data to custom services.

### Export Formats

- **JSON** — Structured data processing.
- **CSV** — Spreadsheet and reporting workflows.
- **Excel** — Business-friendly analysis.
- **XML** — System-to-system integrations.

---

## Frequently Asked Questions

### Can I run with only a keyword?
Yes. Provide `keyword` and the actor will collect matching products.

### Can I run with only a URL?
Yes. Provide `url` for direct category-style extraction.

### What happens if both URL and keyword are provided?
URL mode is used unless the URL is a search-result URL.

### Does output include empty or null values?
No. Null and empty values are removed before records are saved.

### How many records can I collect?
Set `results_wanted` and `max_pages` based on your target volume and runtime limits.

---

## Support

For issues or feature requests, use the Apify Console issue/support channels.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Scheduling](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is intended for lawful data collection and analysis.  
Users are responsible for compliance with applicable laws and website terms.
