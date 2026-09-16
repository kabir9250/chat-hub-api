import { parseReferrerSearch } from './referrer-search.util';

describe('parseReferrerSearch', () => {
  it('parses a Google search referrer', () => {
    expect(
      parseReferrerSearch(
        'https://www.google.com/search?q=chat+widget+software&oq=chat',
      ),
    ).toEqual({ engine: 'google', terms: 'chat widget software' });
  });

  it('parses a Bing search referrer', () => {
    expect(
      parseReferrerSearch('https://www.bing.com/search?q=live+chat+app'),
    ).toEqual({ engine: 'bing', terms: 'live chat app' });
  });

  it('parses a Yahoo search referrer (p param)', () => {
    expect(
      parseReferrerSearch(
        'https://search.yahoo.com/search?p=customer+support+tool',
      ),
    ).toEqual({ engine: 'yahoo', terms: 'customer support tool' });
  });

  it('parses a DuckDuckGo search referrer', () => {
    expect(
      parseReferrerSearch('https://duckduckgo.com/?q=zendesk+alternative'),
    ).toEqual({ engine: 'duckduckgo', terms: 'zendesk alternative' });
  });

  it('recognizes a known engine hostname with no query terms present', () => {
    expect(parseReferrerSearch('https://www.google.com/')).toEqual({
      engine: 'google',
      terms: null,
    });
  });

  it('returns nulls for a non-search referrer (another site)', () => {
    expect(parseReferrerSearch('https://example.com/blog/post')).toEqual({
      engine: null,
      terms: null,
    });
  });

  it('returns nulls for a null/empty referrer (direct traffic)', () => {
    expect(parseReferrerSearch(null)).toEqual({ engine: null, terms: null });
    expect(parseReferrerSearch('')).toEqual({ engine: null, terms: null });
  });

  it('returns nulls for an unparseable referrer string rather than throwing', () => {
    expect(parseReferrerSearch('not a url')).toEqual({
      engine: null,
      terms: null,
    });
  });
});
