/*
 * Publications loader.
 *
 * Builds the publication list at runtime from external bibliographic sources:
 *   1. dblp (primary)      - queried through the public SPARQL endpoint (CORS enabled)
 *   2. OpenAlex (secondary) - adds DOI-registered works that dblp does not index
 * Small manual adjustments (exclusions, venue fixes) live in data/publications-config.json.
 * If both live sources are unreachable, data/bibliography.bib is used as an offline snapshot.
 *
 * Usage: PublicationsData.load().then(result => ...)
 *   result = { entries: [...], sources: { dblp, openalex }, fallback, profiles }
 *   entry  = { id, type, title, authors: [..], venue, year, url, doi, source }
 *   type   ∈ article | inproceedings | incollection | book | misc (pre-print)
 */
(function () {
    const CONFIG_URL = 'data/publications-config.json';
    const FALLBACK_URL = 'data/bibliography.bib';
    const DBLP_SPARQL = 'https://sparql.dblp.org/sparql';
    const OPENALEX_API = 'https://api.openalex.org/works';
    const CACHE_KEY = 'publications-cache-v2';
    const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
    const TYPE_ORDER = ['article', 'inproceedings', 'incollection', 'book', 'misc'];

    let pending = null;

    // ---------- helpers ----------

    function cleanTitle(title) {
        return (title || '').replace(/\s+/g, ' ').replace(/\.\s*$/, '').trim();
    }

    function cleanAuthorName(name) {
        // dblp disambiguates homonyms with a numeric suffix ("Xavier Franch 0001")
        return (name || '').replace(/\s+\d{4}$/, '').trim();
    }

    function normalizeDoi(doi) {
        return (doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
    }

    const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'for', 'in', 'on', 'and', 'to', 'with', 'from', 'by', 'using']);

    function titleTokens(title) {
        return new Set(
            (title || '').toLowerCase()
                .normalize('NFD').replace(/[̀-ͯ]/g, '')
                .replace(/[^a-z0-9]+/g, ' ')
                .split(' ')
                .map(t => t.replace(/(ies|es|s)$/, ''))
                .filter(t => t && !STOPWORDS.has(t))
        );
    }

    function similarTitles(a, b) {
        const ta = titleTokens(a), tb = titleTokens(b);
        if (!ta.size || !tb.size) return false;
        let common = 0;
        ta.forEach(t => { if (tb.has(t)) common++; });
        return common / (ta.size + tb.size - common) >= 0.6;
    }

    function readCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
            if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.result;
        } catch (e) { /* storage unavailable */ }
        return null;
    }

    function writeCache(result) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ time: Date.now(), result }));
        } catch (e) { /* storage unavailable */ }
    }

    function fetchJson(url, options) {
        return fetch(url, options).then(response => {
            if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
            return response.json();
        });
    }

    // ---------- dblp ----------

    function dblpQuery(pid) {
        return `
PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?p (SAMPLE(?title) AS ?t) (SAMPLE(?year) AS ?y) (SAMPLE(?bibType) AS ?bt)
       (SAMPLE(?venue) AS ?v) (SAMPLE(?parentTitle) AS ?pt) (SAMPLE(?doi) AS ?d) (SAMPLE(?ee) AS ?e)
       (GROUP_CONCAT(DISTINCT CONCAT(STR(?ord), "\\t", ?name); SEPARATOR="\\n") AS ?authors)
WHERE {
  ?p dblp:authoredBy <https://dblp.org/pid/${pid}> ;
     dblp:title ?title ; dblp:yearOfPublication ?year ; dblp:bibtexType ?bibType ;
     dblp:hasSignature ?sig .
  ?sig dblp:signatureOrdinal ?ord ; dblp:signatureDblpName ?name .
  OPTIONAL { ?p dblp:publishedIn ?venue }
  OPTIONAL { ?p dblp:publishedAsPartOf ?parent . ?parent dblp:title ?parentTitle }
  OPTIONAL { ?p dblp:doi ?doi }
  OPTIONAL { ?p dblp:primaryDocumentPage ?ee }
}
GROUP BY ?p`;
    }

    function loadDblp(pid) {
        const url = `${DBLP_SPARQL}?query=${encodeURIComponent(dblpQuery(pid))}`;
        return fetchJson(url, { headers: { Accept: 'application/sparql-results+json' } })
            .then(data => data.results.bindings.map(row => {
                const get = key => (row[key] ? row[key].value : '');
                const bibType = get('bt').split('#').pop().toLowerCase();
                const venueShort = get('v');
                const isCorr = bibType === 'article' && venueShort === 'CoRR';

                let type = bibType;
                if (isCorr) type = 'misc';
                else if (bibType === 'book') type = 'book';

                let venue = venueShort;
                if (isCorr) venue = 'arXiv';
                else if (bibType === 'inproceedings' || bibType === 'incollection') {
                    venue = cleanTitle(get('pt')) || venueShort;
                }

                const authors = get('authors').split('\n')
                    .map(line => line.split('\t'))
                    .sort((a, b) => Number(a[0]) - Number(b[0]))
                    .map(parts => cleanAuthorName(parts[1]));

                const doi = normalizeDoi(get('d'));
                return {
                    id: 'dblp:' + get('p').replace('https://dblp.org/rec/', ''),
                    rawType: bibType,
                    type,
                    title: cleanTitle(get('t')),
                    authors,
                    venue,
                    year: get('y'),
                    doi,
                    url: get('e') || (doi ? `https://doi.org/${doi}` : ''),
                    source: 'dblp'
                };
            }));
    }

    // ---------- OpenAlex ----------

    const OPENALEX_TYPES = {
        'article': 'article',
        'conference-paper': 'inproceedings',
        'book-chapter': 'incollection',
        'book': 'book',
        'preprint': 'misc',
        'review': 'misc'
    };

    function rawAuthorName(raw) {
        const name = (raw || '').replace(/\s+/g, ' ').trim();
        const parts = name.split(',');
        // "Last, First" -> "First Last"
        return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : name;
    }

    function loadOpenAlex(authorId) {
        const url = `${OPENALEX_API}?filter=author.id:${authorId}&per_page=200` +
            '&select=id,doi,title,publication_year,type,authorships,primary_location';
        return fetchJson(url).then(data => data.results.map(work => {
            const location = work.primary_location || {};
            const source = location.source || {};
            const isArxiv = /arxiv/i.test(source.display_name || '');
            let type = OPENALEX_TYPES[work.type] || null;
            if (isArxiv) type = 'misc';
            // Skip datasets, software, theses and deposits in generic repositories (Zenodo, Figshare, ...)
            if (source.type === 'repository' && !isArxiv) type = null;

            const doi = normalizeDoi(work.doi);
            return {
                id: 'openalex:' + (work.id || '').replace('https://openalex.org/', ''),
                rawType: work.type,
                type,
                title: cleanTitle(work.title),
                // Prefer the name as printed on the paper: OpenAlex's author disambiguation can
                // link an author to someone else's profile (and display that profile's name)
                authors: (work.authorships || []).map(a => rawAuthorName(a.raw_author_name) || (a.author && a.author.display_name)),
                venue: isArxiv ? 'arXiv' : (source.display_name || ''),
                year: String(work.publication_year || ''),
                doi,
                url: doi ? `https://doi.org/${doi}` : (location.landing_page_url || ''),
                source: 'openalex'
            };
        }).filter(entry => entry.type && entry.doi && entry.title));
    }

    // ---------- offline snapshot ----------

    function loadFallbackBib() {
        return fetch(FALLBACK_URL)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status} for ${FALLBACK_URL}`);
                return response.text();
            })
            .then(bibtex => {
                if (typeof bibtexParse === 'undefined') throw new Error('BibTeX parser not available');
                const raw = bibtex.split(/\n(?=@)/);
                const entries = [];
                raw.forEach(chunk => {
                    try {
                        const parsed = bibtexParse.toJSON(chunk);
                        if (parsed && parsed[0] && parsed[0].entryTags) entries.push(parsed[0]);
                    } catch (e) { /* skip malformed entry */ }
                });
                return entries.map(entry => {
                    const e = {};
                    Object.keys(entry.entryTags).forEach(k => { e[k.toLowerCase()] = entry.entryTags[k]; });
                    let type = entry.entryType.toLowerCase();
                    if (type === 'article' && (e.journal || '').toLowerCase() === 'corr') type = 'misc';
                    const strip = s => (s || '').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
                    const venue = type === 'article' ? e.journal
                        : (type === 'inproceedings' || type === 'incollection') ? e.booktitle
                        : type === 'book' ? e.publisher
                        : (e.howpublished || 'arXiv');
                    const doi = normalizeDoi(e.doi);
                    return {
                        id: 'bib:' + entry.citationKey,
                        type,
                        title: strip(e.title),
                        authors: strip(e.author).split(/\s+and\s+/),
                        venue: strip(venue),
                        year: e.year || '',
                        doi,
                        url: e.url || (doi ? `https://doi.org/${doi}` : ''),
                        source: 'snapshot'
                    };
                });
            });
    }

    // ---------- merge ----------

    function isExcluded(entry, exclude) {
        if ((exclude.types || []).includes(entry.rawType)) return true;
        if ((exclude.ids || []).includes(entry.id)) return true;
        if (entry.doi && (exclude.ids || []).includes('doi:' + entry.doi)) return true;
        return (exclude.titlePatterns || []).some(p => new RegExp(p, 'i').test(entry.title));
    }

    function applyOverrides(entry, overrides) {
        const patch = overrides[entry.id] || (entry.doi && overrides['doi:' + entry.doi]);
        return patch ? Object.assign({}, entry, patch) : entry;
    }

    function merge(dblpEntries, openAlexEntries, config) {
        const exclude = config.exclude || {};
        const overrides = config.overrides || {};
        let entries = dblpEntries.filter(e => !isExcluded(e, exclude));

        // Drop pre-prints that already have a peer-reviewed version
        const published = entries.filter(e => e.type !== 'misc');
        entries = entries.filter(e => e.type !== 'misc' || !published.some(p => similarTitles(p.title, e.title)));

        // Add OpenAlex works that dblp does not know about
        const knownDois = new Set(dblpEntries.map(e => e.doi).filter(Boolean));
        openAlexEntries.forEach(work => {
            if (isExcluded(work, exclude) || knownDois.has(work.doi)) return;
            const duplicate = dblpEntries.concat(entries).some(e => similarTitles(e.title, work.title));
            if (duplicate) return;
            entries.push(work);
            knownDois.add(work.doi);
        });

        return entries.map(e => applyOverrides(e, overrides));
    }

    function sortEntries(entries) {
        return entries.sort((a, b) =>
            (Number(b.year) || 0) - (Number(a.year) || 0) ||
            TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) ||
            a.title.localeCompare(b.title));
    }

    // ---------- public API ----------

    function load() {
        if (pending) return pending;

        const cached = readCache();
        if (cached) {
            pending = Promise.resolve(cached);
            return pending;
        }

        pending = fetchJson(CONFIG_URL)
            .catch(() => ({ profiles: {}, exclude: {}, overrides: {} }))
            .then(config => {
                const profiles = config.profiles || {};
                const sources = [
                    profiles.dblp ? loadDblp(profiles.dblp) : Promise.resolve(null),
                    profiles.openalex ? loadOpenAlex(profiles.openalex) : Promise.resolve(null)
                ].map(p => p.catch(error => { console.warn('Publication source failed', error); return null; }));

                return Promise.all(sources).then(([dblp, openalex]) => {
                    if (!dblp && !openalex) {
                        return loadFallbackBib().then(entries => ({
                            entries: sortEntries(entries),
                            sources: { dblp: false, openalex: false },
                            fallback: true,
                            profiles
                        }));
                    }
                    const result = {
                        entries: sortEntries(merge(dblp || [], openalex || [], config)),
                        sources: { dblp: !!dblp, openalex: !!openalex },
                        fallback: false,
                        profiles
                    };
                    if (dblp && openalex) writeCache(result);
                    return result;
                });
            })
            .catch(error => {
                pending = null;
                throw error;
            });

        return pending;
    }

    window.PublicationsData = { load };
})();
