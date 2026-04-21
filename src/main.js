import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';

const AUTOZONE_BASE_URL = 'https://www.autozone.com';
const API_BASE_URL = 'https://external-api.autozone.com';

const API_ENDPOINTS = {
    PAGE_TYPES: `${API_BASE_URL}/sls/b2c/product-discovery-seo-data-bs/v2/page-types`,
    PRODUCT_SHELVES: `${API_BASE_URL}/sls/b2c/product-discovery-browse-search-data/v1/product-shelves`,
    PRODUCTS_SEARCH: `${API_BASE_URL}/sls/b2c/product-discovery-browse-search-data/v1/products/search`,
    SEARCH_PRODUCT: `${API_BASE_URL}/sls/pd/product-navigation-search/v1/search-product`,
    REVIEW_STATISTICS: `${API_BASE_URL}/sls/product/product-reviews-integration-bs/v1/review-statistics`,
};

const MAX_PAGE_SIZE = 24;
const MAX_REDIRECT_HOPS = 5;
const MAX_REQUEST_RETRIES = 3;
const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 20;

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

    const resultsWanted = toPositiveInt(
        firstDefined(input.results_wanted, input.resultsWanted, input.result_wanted, input.resultWanted),
        DEFAULT_RESULTS_WANTED
    );
    const maxPages = toPositiveInt(firstDefined(input.max_pages, input.maxPages), DEFAULT_MAX_PAGES);

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
    const { mode } = urlContext;

    log.info(`Mode: ${mode}. Country: ${market.country}. Target: ${normalizedUrl.href}. Results wanted: ${resultsWanted}. Max pages: ${maxPages}`);

    const seen = new Set();
    let saved;

    if (mode === 'keyword') {
        const redirectedUrl = await resolveKeywordRedirectUrl({
            keyword: urlContext.keyword,
            normalizedUrl,
            market,
            queryOptions,
            proxyConfiguration,
        });

        if (redirectedUrl) {
            log.info(`Keyword URL resolved to canonical shelf URL: ${redirectedUrl.href}`);
            saved = await scrapeByUrl({
                normalizedUrl: redirectedUrl,
                market,
                queryOptions,
                resultsWanted,
                maxPages,
                proxyConfiguration,
                seen,
            });
        } else {
            saved = await scrapeByKeyword({
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
            });
        }
    } else {
        saved = await scrapeByUrl({
            normalizedUrl,
            market,
            queryOptions,
            resultsWanted,
            maxPages,
            proxyConfiguration,
            seen,
        });
    }

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
    const originalCanonicalPath = normalizeCanonicalPath(normalizedUrl.pathname);
    const resolved = await resolvePageType({
        canonicalPath: originalCanonicalPath,
        country: market.country,
        proxyConfiguration,
    });
    const fallbackCanonicalPath = resolved.canonicalPath && resolved.canonicalPath !== '/'
        ? resolved.canonicalPath
        : originalCanonicalPath;

    const pageType = cleanString(firstDefined(resolved.result?.pageType, resolved.result?.subPageType));
    if (pageType !== 'ProductShelf') {
        const fallbackKeywords = buildFallbackKeywords({
            normalizedUrl,
            pageTypeResult: resolved.result,
            canonicalPath: fallbackCanonicalPath,
        });
        if (!fallbackKeywords.length) {
            throw new Error(
                `URL does not resolve to a product shelf page and no fallback keyword could be derived. Resolved pageType: ${pageType || 'unknown'} (path: ${resolved.canonicalPath})`
            );
        }

        log.warning(
            `URL resolved to ${pageType || 'unknown'} instead of ProductShelf. Falling back to keyword search with ${fallbackKeywords.length} candidate query(s).`
        );
        return scrapeByKeywordCandidates({
            keywords: fallbackKeywords,
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
        const recordsPerPage = MAX_PAGE_SIZE;

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
                const fallbackKeywords = buildFallbackKeywords({
                    normalizedUrl,
                    pageTypeResult: resolved.result,
                    canonicalPath: resolved.result?.canonicalPath || fallbackCanonicalPath,
                });
                log.warning(`URL mode returned no records. Falling back to keyword mode with ${fallbackKeywords.length} candidate query(s).`);
                return scrapeByKeywordCandidates({
                    keywords: fallbackKeywords,
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
        if (pageSaved === 0) break;
        if (records.length < recordsPerPage) break;
        pageNumber++;
    }

    return totalSaved;
}

async function scrapeByKeywordCandidates({
    keywords,
    market,
    queryOptions,
    resultsWanted,
    maxPages,
    proxyConfiguration,
    seen,
    sourceUrl,
    sourceMode,
    sourceInput,
}) {
    const candidates = unique(keywords.map(cleanSearchPhrase).filter(Boolean));
    if (!candidates.length) return 0;

    for (const keyword of candidates) {
        log.info(`Trying keyword fallback: "${keyword}"`);
        const saved = await scrapeByKeyword({
            keyword,
            market,
            queryOptions,
            resultsWanted,
            maxPages,
            proxyConfiguration,
            seen,
            sourceUrl,
            sourceMode,
            sourceInput,
        });
        if (saved > 0) return saved;
    }

    return 0;
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
        const recordsPerPage = MAX_PAGE_SIZE;

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
        if (pageSaved === 0) break;
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
    const baseUrl = getMarketBaseUrl(market);

    const batch = [];
    for (let i = 0; i < records.length; i++) {
        if (batch.length >= remaining) break;

        const record = records[i];
        const recordKey = getRecordKey(record);
        if (recordKey && seen.has(recordKey)) continue;
        if (recordKey) seen.add(recordKey);

        const skuId = extractSkuId(record);
        const reviewStats = skuId ? reviewMap.get(String(skuId)) : undefined;

        const compacted = compactObject(normalizeDatasetUrls({
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
        }, baseUrl));

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

async function resolveKeywordRedirectUrl({
    keyword,
    normalizedUrl,
    market,
    queryOptions,
    proxyConfiguration,
}) {
    const cleanedKeyword = cleanSearchPhrase(keyword);
    if (!cleanedKeyword) return null;

    const response = await requestJson({
        url: API_ENDPOINTS.SEARCH_PRODUCT,
        proxyConfiguration,
        searchParams: compactObject({
            country: market.country,
            customerType: 'B2C',
            salesChannel: 'ECOMM',
            preview: false,
            ignoreVehicleSpecificProductsCheck: false,
            searchedKeyword: cleanedKeyword,
            storeId: queryOptions.storeId,
        }),
    });

    const redirectUrl = cleanString(response?.redirectUrl);
    if (!redirectUrl || redirectUrl === '/') return null;

    const redirected = new URL(redirectUrl, normalizedUrl.origin);
    return normalizeAutoZoneUrl(redirected.href);
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
    let lastError;

    for (let attempt = 1; attempt <= MAX_REQUEST_RETRIES; attempt++) {
        try {
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

            return JSON.parse(response.body);
        } catch (error) {
            lastError = error;
            if (attempt < MAX_REQUEST_RETRIES) {
                log.warning(`Retrying request (${attempt}/${MAX_REQUEST_RETRIES}) for ${url}: ${error.message}`);
                await Actor.sleep(500 * attempt);
            }
        }
    }

    throw lastError;
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
            storeId: firstNonEmpty(
                searchParams.get('storeId'),
                searchParams.get('store'),
                searchParams.get('storeNumber'),
                searchParams.get('selectedStore')
            ),
        }) || {}
    );
}

function resolveMarket(url) {
    const hostname = cleanString(url?.hostname).toLowerCase();
    if (hostname.endsWith('.com.mx')) return { country: 'MEX', locale: 'es-MX' };
    if (hostname.endsWith('.com.br')) return { country: 'BRA', locale: 'pt-BR' };
    return { country: 'USA', locale: 'en-US' };
}

function getUrlContext(url) {
    const path = normalizeCanonicalPath(url.pathname).toLowerCase();
    if (path.startsWith('/searchresult')) {
        const searchKeyword = cleanString(
            firstNonEmpty(
                url.searchParams.get('searchText'),
                url.searchParams.get('q'),
                url.searchParams.get('query'),
                url.searchParams.get('keyword'),
                url.searchParams.get('searchTerm')
            )
        );
        const fallbackKeyword = buildKeywordFromPath(path) || 'autozone parts';
        return { mode: 'keyword', keyword: searchKeyword || fallbackKeyword };
    }

    return { mode: 'url', keyword: '' };
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

    return cleanString(fromPath);
}

function buildKeywordFromPath(pathname) {
    const tokens = normalizeCanonicalPath(pathname)
        .split('/')
        .filter(Boolean)
        .flatMap((part) => part.split('-'))
        .filter(Boolean)
        .filter((part) => !['searchresult', 's', 'c', 'tag', 'tags'].includes(part.toLowerCase()));

    return cleanString(tokens.join(' '));
}

function buildFallbackKeywords({ normalizedUrl, pageTypeResult, canonicalPath }) {
    const keywords = [];
    const normalizedPath = canonicalPath || normalizedUrl.pathname;
    const searchParamKeyword = firstNonEmpty(
        normalizedUrl.searchParams.get('searchText'),
        normalizedUrl.searchParams.get('q'),
        normalizedUrl.searchParams.get('query'),
        normalizedUrl.searchParams.get('keyword'),
        normalizedUrl.searchParams.get('searchTerm')
    );

    const fromPageType = buildKeywordFromPageType({
        catalogName: pageTypeResult?.catalogName,
        make: pageTypeResult?.make,
        model: pageTypeResult?.model,
        year: pageTypeResult?.year,
        canonicalPath: normalizedPath,
    });
    if (fromPageType) keywords.push(fromPageType);

    const pdpKeyword = buildPdpKeyword(normalizedUrl.pathname);
    if (pdpKeyword) keywords.push(pdpKeyword);

    if (searchParamKeyword && normalizeCanonicalPath(normalizedUrl.pathname).toLowerCase().startsWith('/searchresult')) {
        keywords.unshift(searchParamKeyword);
    } else if (searchParamKeyword) {
        keywords.push(searchParamKeyword);
    }

    const fromPath = buildKeywordFromPath(normalizedPath);
    if (fromPath) keywords.push(fromPath);

    return unique(keywords.map(cleanSearchPhrase).filter(Boolean));
}

function buildPdpKeyword(pathname) {
    const parts = normalizeCanonicalPath(pathname).split('/').filter(Boolean);
    if (parts[0]?.toLowerCase() !== 'p' || parts.length < 2) return '';

    const slug = cleanString(parts[1]).replace(/-/g, ' ');
    return cleanSearchPhrase(slug.replace(/\b\d{5,}\b/g, ' '));
}

function cleanSearchPhrase(value) {
    return cleanString(value)
        .replace(/[_/]+/g, ' ')
        .replace(/\b(true|false|null|undefined)\b/gi, ' ')
        .replace(/[^\w\s-]+/g, ' ')
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDatasetUrls(value, baseUrl, key = '') {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        if (shouldConvertToAbsoluteUrl(key, value)) {
            return toAbsoluteAutoZoneUrl(value, baseUrl);
        }
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => normalizeDatasetUrls(item, baseUrl, key));
    }

    if (typeof value === 'object') {
        const output = {};
        for (const [childKey, childValue] of Object.entries(value)) {
            output[childKey] = normalizeDatasetUrls(childValue, baseUrl, childKey);
        }
        return output;
    }

    return value;
}

function shouldConvertToAbsoluteUrl(key, value) {
    if (!value.startsWith('/')) return false;

    return key === 'canonicalPath'
        || key === 'taxonomyPath'
        || key.endsWith('Url')
        || key.endsWith('Path');
}

function toAbsoluteAutoZoneUrl(pathOrUrl, baseUrl) {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    if (!pathOrUrl.startsWith('/')) return pathOrUrl;
    return new URL(pathOrUrl, baseUrl).href;
}

function getMarketBaseUrl(market) {
    if (market?.country === 'MEX') return 'https://www.autozone.com.mx';
    if (market?.country === 'BRA') return 'https://www.autozone.com.br';
    return AUTOZONE_BASE_URL;
}

function normalizeAutoZoneUrl(raw) {
    const value = cleanString(raw)
        .replace(/^"+|"+$/g, '')
        .replace(/^'+|'+$/g, '');
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

    url.protocol = 'https:';
    url.hostname = url.hostname.toLowerCase();
    url.pathname = decodeURIComponent(url.pathname);
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    if (url.pathname !== '/') {
        url.pathname = url.pathname.replace(/\/+$/, '');
    }
    for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|gclid$|fbclid$|msockid$|cid$|cmpid$|campid$|intcmp$|source$)/i.test(key)) {
            url.searchParams.delete(key);
        }
    }
    url.hash = '';
    return url;
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
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
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
