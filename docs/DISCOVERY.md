# Website discovery and presentation

The public homepage uses the canonical URL https://numby.io/. Nginx redirects
HTTP, www, index.html and homepage review query links to that canonical URL.
Title, description, Open Graph and Twitter previews describe the open-source
phone gateway without implying every pictured runtime has a working wake hook.
See [runtime support](RUNTIMES.md) for the integration boundaries.

The homepage includes WebSite JSON-LD with Numby's name and canonical URL.
The sitemap lists the public homepage only. robots.txt permits public assets and
excludes API and dashboard paths from crawling; robots rules are not access
control. The dashboard remains authenticated. Do not add private setup URLs,
credentials or user-specific content to a sitemap.

Google Search Console and Bing Webmaster Tools use the public homepage
verification tags. Preserve both tags in future releases. Submission and
ownership verification do not prove indexing or guarantee rankings.

## Headline motion

One decorative pass visits Muse, Grok Bot, Hermes and dot, then settles on
“your agent”. Each complete name dwells for 1,800 ms; typing takes 100 ms per
character and deletion takes 45 ms per character. Total duration is 10,945 ms
plus font readiness, with no repeat. Natural text widths keep the cursor beside
the current text. The accessible heading is always “Give your agent a Phone
Number”, without live announcements.

Reduced motion renders static “your agent”. Any key, pointer press, touch or
wheel action permanently ends the intro without consuming that action; hiding
the tab also ends it. There is no visible pause button or support row. This is
not a claim of a full WCAG conformance audit.

## Sources

- https://developers.google.com/search/docs/appearance/site-names
- https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl
- https://www.bing.com/webmasters/help/add-and-verify-site-12184f8b
- https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
