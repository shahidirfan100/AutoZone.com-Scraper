import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

const AUTOZONE_BASE_URL = 'https://www.autozone.com';
const API_BASE_URL = 'https://external-api.autozone.com';

const API_ENDPOINTS = {
    PAGE_TYPES: `${API_BASE_URL}/sls/b2c/product-discovery-seo-data-bs/v2/page-types`,
    PRODUCT_SHELVES: `${API_BASE_URL}/sls/b2c/product-discovery-browse-search-data/v1/product-shelves`,
    PRODUCTS_SEARCH: `${API_BASE_URL}/sls/b2c/product-discovery-browse-search-data/v1/products/search`,
    REVIEW_STATISTICS: `${API_BASE_URL}/sls/product/product-reviews-integration-bs/v1/review-statistics`,
};

const MAX_PAGE_SIZE = 24;
const MAX_REDIRECT_HOPS = 5;
const MAX_REQUEST_RETRIES = 3;

const COMMON_HEADERS = {
    Accept: 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/json',
    Referer: AUTOZONE_BASE_URL,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0',
};

await Actor.main(run);

async function run() {
    const input = (await Actor.getInput()) || {};

    const rawUrl = firstNonEmpty(input.url, input.startUrl, input.start_url);

    const resultsWanted = toPositiveIntOrInfinity(
        firstDefined(input.results_wanted, input.resultsWanted, input.result_wanted, input.resultWanted)
    );
    const maxPages = toPositiveIntOrInfinity(firstDefined(input.max_pages, input.maxPages));

    const normalizedUrl = rawUrl ? normalizeAutoZoneUrl(rawUrl) : null;
    if (!normalizedUrl) {
        throw new Error('Provide `url`.');
    }

    const market = resolveMarket(normalizedUrl);
    const queryOptions = extractQueryOptions(normalizedUrl.searchParams);
    const proxyConfiguration = input.proxyConfiguration
        ? await Actor.createProxyConfiguration({ ...input.proxyConfiguration })
        : undefined;
    const urlContext = getUrlContext(normalizedUrl);
    const mode = urlContext.mode;

    log.info(`Mode: ${mode}. Country: ${market.country}. Target: ${normalizedUrl.href}`);

    const seen = new Set();
    const saved = mode === 'keyword'
        ? await scrapeByKeyword({
            keyword: urlContext.keyword,
            market,
            queryOptions,
            resultsWanted,
            maxPages,
            proxyConfiguration,
            seen,
            sourceUrl: normalizedUrl.href,
            sourceMode: 'url',
            sourceInput: normalizedUrl.href,
        })
        : await scrapeByUrl({
            normalizedUrl,
            market,
            queryOptions,
            resultsWanted,
            maxPages,
            proxyConfiguration,
            seen,
        });

    log.info(`Finished. Saved ${saved} items.`);
}

async function scrapeByUrl({
    normalizedUrl,
    market,
    queryOptions,
    resultsWanted,
    maxPages,
    proxyConfiguration,
    seen,
}) {
    const canonicalPath = normalizeCanonicalPath(normalizedUrl.pathname);
    const resolved = await resolvePageType({
        canonicalPath,
        country: market.country,
        proxyConfiguration,
    });

    const pageType = cleanString(firstDefined(resolved.result?.pageType, resolved.result?.subPageType));
    if (pageType !== 'ProductShelf') {
        throw new Error(
            `URL does not resolve to a product shelf page. Resolved pageType: ${pageType || 'unknown'} (path: ${resolved.canonicalPath})`
        );
    }

    const partGroupId = cleanString(resolved.result?.catalogId);
    if (!partGroupId) {
        throw new Error('Could not resolve `catalogId` from page type response.');
    }
    log.info(
        `Resolved shelf metadata: partGroupId=${partGroupId}, canonicalPath=${resolved.result?.canonicalPath || resolved.canonicalPath}, makeModelYearPath=${resolved.result?.makeModelYearPath || ''}`
    );

    let pageNumber = 1;
    let totalSaved = 0;

    while (pageNumber <= maxPages && totalSaved < resultsWanted) {
        const remaining = resultsWanted - totalSaved;
        const recordsPerPage = Math.min(MAX_PAGE_SIZE, remaining);

        const response = await requestJson({
            url: API_ENDPOINTS.PRODUCT_SHELVES,
            proxyConfiguration,
            searchParams: compactObject({
                country: market.country,
                customerType: 'B2C',
                salesChannel: 'ECOMM',
                partGroupId,
                pageNumber,
                recordsPerPage,
                preview: false,
                canonicalPath: resolved.result?.canonicalPath || resolved.canonicalPath,
                makeModelYearPath: resolved.result?.makeModelYearPath,
                botEnabledFacetPath: resolved.result?.botEnabledFacetPath,
                storeId: queryOptions.storeId,
                sort: queryOptions.sort,
                facet: queryOptions.facet,
                minPrice: queryOptions.minPrice,
                maxPrice: queryOptions.maxPrice,
                partNumberSearch: queryOptions.partNumberSearch,
            }),
        });

        const shelf = response?.productShelfResults || {};
        const records = Array.isArray(shelf.skuRecords) ? shelf.skuRecords : [];
        log.info(
            `URL mode page ${pageNumber}: fetched ${records.length} records (total=${shelf.totalNumberOfRecords ?? 'n/a'})`
        );
        if (!records.length) {
            if (pageNumber === 1) {
                const fallbackKeyword = buildKeywordFromPageType({
                    catalogName: resolved.result?.catalogName,
                    make: resolved.result?.make,
                    model: resolved.result?.model,
                    year: resolved.result?.year,
                    canonicalPath: resolved.result?.canonicalPath || resolved.canonicalPath,
                });
                log.warning(`URL mode returned no records. Falling back to keyword mode with: "${fallbackKeyword}"`);
                return scrapeByKeyword({
                    keyword: fallbackKeyword,
                    market,
                    queryOptions,
                    resultsWanted,
                    maxPages,
                    proxyConfiguration,
                    seen,
                    sourceUrl: normalizedUrl.href,
                    sourceMode: 'url',
                    sourceInput: normalizedUrl.href,
                });
            }
        }
        if (!records.length) break;

        const pageSaved = await savePageRecords({
            records,
            sourceMode: 'url',
            sourceInput: normalizedUrl.href,
            canonicalPath: resolved.result?.canonicalPath || resolved.canonicalPath,
            market,
            pageNumber,
            startRank: totalSaved + 1,
            remaining,
            proxyConfiguration,
            seen,
        });

        totalSaved += pageSaved;
        log.info(`URL mode page ${pageNumber}: saved ${pageSaved} records`);
        if (records.length < recordsPerPage) break;
        pageNumber++;
    }

    return totalSaved;
}

async function scrapeByKeyword({
    keyword,
    market,
    queryOptions,
    resultsWanted,
    maxPages,
    proxyConfiguration,
    seen,
    sourceUrl,
    sourceMode = 'keyword',
    sourceInput = '',
}) {
    let pageNumber = 1;
    let totalSaved = 0;

    while (pageNumber <= maxPages && totalSaved < resultsWanted) {
        const remaining = resultsWanted - totalSaved;
        const recordsPerPage = Math.min(MAX_PAGE_SIZE, remaining);

        const response = await requestJson({
            method: 'POST',
            url: API_ENDPOINTS.PRODUCTS_SEARCH,
            proxyConfiguration,
            jsonBody: compactObject({
                country: market.country,
                customerType: 'B2C',
                salesChannel: 'ECOMM',
                preview: false,
                searchText: keyword,
                pageNumber,
                recordsPerPage,
                storeId: queryOptions.storeId,
                sort: queryOptions.sort,
                facet: queryOptions.facet,
                minPrice: queryOptions.minPrice,
                maxPrice: queryOptions.maxPrice,
                partNumberSearch: queryOptions.partNumberSearch,
            }),
        });

        const searchResults = response?.searchResults || {};
        const records = Array.isArray(searchResults.skuRecords) ? searchResults.skuRecords : [];
        log.info(`Keyword mode page ${pageNumber}: fetched ${records.length} records`);
        if (!records.length) break;

        const pageSaved = await savePageRecords({
            records,
            sourceMode,
            sourceInput: sourceInput || keyword,
            canonicalPath: undefined,
            market,
            pageNumber,
            startRank: totalSaved + 1,
            remaining,
            proxyConfiguration,
            seen,
            sourceUrl,
        });

        totalSaved += pageSaved;
        log.info(`Keyword mode page ${pageNumber}: saved ${pageSaved} records`);
        if (records.length < recordsPerPage) break;
        pageNumber++;
    }

    return totalSaved;
}

async function savePageRecords({
    records,
    sourceMode,
    sourceInput,
    canonicalPath,
    market,
    pageNumber,
    startRank,
    remaining,
    proxyConfiguration,
    seen,
    sourceUrl,
}) {
    const skuIds = unique(records.map(extractSkuId).filter(Boolean));
    const reviewMap = await fetchReviewStatisticsMap({ skuIds, proxyConfiguration });

    const batch = [];
    for (let i = 0; i < records.length; i++) {
        if (batch.length >= remaining) break;

        const record = records[i];
        const recordKey = getRecordKey(record);
        if (recordKey && seen.has(recordKey)) continue;
        if (recordKey) seen.add(recordKey);

        const skuId = extractSkuId(record);
        const reviewStats = skuId ? reviewMap.get(String(skuId)) : undefined;

        const compacted = compactObject({
            sourceMode,
            sourceInput,
            sourceUrl,
            canonicalPath,
            country: market.country,
            locale: market.locale,
            pageNumber,
            rankOnPage: i + 1,
            rankOverall: startRank + batch.length,
            ...record,
            reviewStatistics: reviewStats,
        });

        if (compacted && Object.keys(compacted).length) {
            batch.push(compacted);
        }
    }

    if (batch.length) {
        await Dataset.pushData(batch);
    }

    return batch.length;
}

async function fetchReviewStatisticsMap({ skuIds, proxyConfiguration }) {
    if (!skuIds.length) return new Map();

    const response = await requestJson({
        url: API_ENDPOINTS.REVIEW_STATISTICS,
        proxyConfiguration,
        searchParams: { skuNumbers: skuIds.join(',') },
    });

    const map = new Map();
    const rows = Array.isArray(response) ? response : [];
    for (const row of rows) {
        const sku = cleanString(row?.skuNumber);
        if (!sku) continue;
        map.set(sku, compactObject(row));
    }
    return map;
}

async function resolvePageType({ canonicalPath, country, proxyConfiguration }) {
    let currentPath = normalizeCanonicalPath(canonicalPath);
    const redirects = [];

    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
        const response = await requestJson({
            url: API_ENDPOINTS.PAGE_TYPES,
            proxyConfiguration,
            searchParams: {
                canonicalPath: currentPath,
                preview: false,
                country,
            },
        });

        const redirectUrl = cleanString(response?.redirectUrl);
        if (redirectUrl) {
            const normalizedRedirect = normalizeAutoZoneUrl(redirectUrl);
            const redirectPath = normalizeCanonicalPath(normalizedRedirect.pathname);
            if (redirectPath === currentPath) {
                return {
                    canonicalPath: currentPath,
                    redirects,
                    result: response?.acesPageTypeResult || response?.pageTypeResult || {},
                };
            }
            redirects.push(redirectPath);
            currentPath = redirectPath;
            continue;
        }

        return {
            canonicalPath: currentPath,
            redirects,
            result: response?.acesPageTypeResult || response?.pageTypeResult || {},
        };
    }

    throw new Error(`Page type resolution exceeded ${MAX_REDIRECT_HOPS} redirects for path: ${canonicalPath}`);
}

async function requestJson({ method = 'GET', url, searchParams, jsonBody, proxyConfiguration }) {
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;

    const response = await gotScraping({
        method,
        url,
        searchParams,
        json: jsonBody,
        proxyUrl,
        timeout: { request: 60000 },
        headers: COMMON_HEADERS,
        throwHttpErrors: false,
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
        const preview = cleanString(response.body)?.slice(0, 220) || '';
        throw new Error(`Request failed ${response.statusCode} for ${url}. ${preview}`);
    }

    try {
        return JSON.parse(response.body);
    } catch {
        throw new Error(`Expected JSON response from ${url} but received non-JSON body.`);
    }
}

function extractQueryOptions(searchParams) {
    const facets = searchParams.getAll('facet').filter(Boolean);

    return (
        compactObject({
            sort: cleanString(searchParams.get('sort')),
            facet: facets.length ? facets.join(',') : cleanString(searchParams.get('facet')),
            minPrice: toNullableNumber(searchParams.get('minPrice')),
            maxPrice: toNullableNumber(searchParams.get('maxPrice')),
            partNumberSearch: toNullableBoolean(searchParams.get('partNumberSearch')),
        }) || {}
    );
}

function resolveMarket(location) {
    const normalized = cleanString(location).toLowerCase();
    if (/\b(mx|mex|mexico)\b/.test(normalized)) return { country: 'MEX', locale: 'es-MX' };
    if (/\b(br|bra|brazil|brasil)\b/.test(normalized)) return { country: 'BRA', locale: 'pt-BR' };
    return { country: 'USA', locale: 'en-US' };
}

function parseStoreIdFromLocation(location) {
    const digits = cleanString(location).replace(/\D+/g, '');
    if (!digits) return undefined;
    return digits.length <= 5 ? digits : undefined;
}

function buildKeywordFromPageType({ catalogName, make, model, year, canonicalPath }) {
    const pieces = [catalogName, make, model, year].map(cleanString).filter(Boolean);
    if (pieces.length) return pieces.join(' ');

    const fromPath = normalizeCanonicalPath(canonicalPath)
        .split('/')
        .filter(Boolean)
        .slice(-4)
        .map((part) => part.replace(/-/g, ' '))
        .join(' ');

    return cleanString(fromPath) || 'autozone parts';
}

function normalizeAutoZoneUrl(raw) {
    const value = cleanString(raw);
    let normalized = value;

    if (!/^https?:\/\//i.test(normalized)) {
        normalized = normalized.startsWith('/') ? normalized : `/${normalized}`;
        normalized = `${AUTOZONE_BASE_URL}${normalized}`;
    }

    const url = new URL(normalized);
    const isAutoZoneHost = /(^|\.)autozone\.com(\.mx|\.br)?$/i.test(url.hostname);
    if (!isAutoZoneHost) {
        throw new Error(`Unsupported domain "${url.hostname}". Use an AutoZone URL.`);
    }

    url.hash = '';
    return url;
}

function getSearchKeywordFromUrl(url) {
    const path = normalizeCanonicalPath(url.pathname).toLowerCase();
    if (!path.startsWith('/searchresult')) return '';
    return cleanString(firstNonEmpty(url.searchParams.get('searchText'), url.searchParams.get('q')));
}

function normalizeCanonicalPath(pathname) {
    const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
    const normalizedSlashes = withLeadingSlash.replace(/\/{2,}/g, '/');
    if (normalizedSlashes.length === 1) return normalizedSlashes;
    return normalizedSlashes.replace(/\/+$/, '');
}

function extractSkuId(record) {
    const sku = firstDefined(record?.itemId, record?.skuNumber, record?.skuId);
    if (sku === null || sku === undefined) return '';
    return String(sku);
}

function getRecordKey(record) {
    const candidate = firstNonEmpty(
        record?.uniqueId,
        record?.documentId,
        record?.itemId,
        record?.skuNumber,
        record?.productDetailsPageCanonicalUrl,
        record?.productDetailsPageUrl
    );
    return cleanString(candidate);
}

function compactObject(value) {
    if (value === null || value === undefined) return undefined;

    if (typeof value === 'string') {
        return value.trim() === '' ? undefined : value;
    }

    if (Array.isArray(value)) {
        const compacted = value.map(compactObject).filter((item) => item !== undefined);
        return compacted.length ? compacted : undefined;
    }

    if (typeof value === 'object') {
        const output = {};
        for (const [key, val] of Object.entries(value)) {
            const compacted = compactObject(val);
            if (compacted !== undefined) output[key] = compacted;
        }
        return Object.keys(output).length ? output : undefined;
    }

    return value;
}

function cleanString(value) {
    if (value === null || value === undefined) return '';
    return String(value).trim();
}

function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined) return value;
    }
    return undefined;
}

function firstNonEmpty(...values) {
    for (const value of values) {
        const cleaned = cleanString(value);
        if (cleaned) return cleaned;
    }
    return '';
}

function toPositiveInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.floor(parsed);
}

function toNullableNumber(value) {
    if (value === null || value === undefined || String(value).trim() === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function toNullableBoolean(value) {
    if (value === null || value === undefined) return undefined;
    const normalized = String(value).toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
}

function unique(items) {
    return [...new Set(items)];
}
