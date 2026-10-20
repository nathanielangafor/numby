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

The decorative animation cycles through Muse, Grok Bot, Hermes, dot and
“your agent”, then types Muse again. Each complete name dwells for 1,800 ms; typing takes 100 ms per
character and deletion takes 45 ms per character. Each cycle lasts 13,495 ms
after font readiness. Natural text widths keep the cursor beside
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

## Search-console verification, October 19, 2026 (Pacific)

- Google and Bing ownership verified through the homepage tags, using the
  existing operator accounts. No DNS records were changed.
- Google processed `/sitemap.xml` successfully and discovered one page.
  URL Inspection reports the homepage is already indexed and served over HTTPS.
  A request to recrawl the new release failed twice with Search Console's
  submission error; the first attempt also reported inability to reach its
  reCAPTCHA service. No successful fresh recrawl request is claimed.
- Bing accepted the sitemap (processing) and confirmed the homepage URL was
  submitted for indexing. Its index report still says discovered but not crawled
  with a DNS fetch error. Its separate live inspection returned an inspection
  error. Indexing is not confirmed.
- Independent checks resolve the domain to `104.248.216.34` through the local,
  Google and Cloudflare resolvers. HTTPS returns the exact published homepage,
  CSS, JavaScript, robots and sitemap bytes. Revisit Bing's crawl report after
  processing; do not change healthy DNS solely from this report.

Release `6c7ba05` was checked at 320, 390 and 1440 px: no horizontal overflow,
zero vertical phone movement across the sequence, and the cursor remained next
to the text. Reduced motion, keyboard interruption and the setup dialog passed.
Live browser error logs were empty. GitHub About/homepage metadata was reviewed
and retained because it already accurately describes the gateway and runtime
support. This release changes presentation/discovery only; backend regression
suites were not rerun.

## Sharing assets

Share the canonical homepage https://numby.io/ or the public repository
https://github.com/nathanielangafor/numby. The 1200 × 630 PNG at
`website/assets/social.png` is the shared branded preview, about 42 KiB with a
solid background. It is also uploaded in GitHub Settings → Social preview;
updating a README image alone does not update that repository setting.

The website supplies absolute HTTPS Open Graph and Twitter image URLs, image
dimensions, descriptive alternative text and a large-image Twitter card. The
README image links to the website, with setup, support and self-hosting links
near the top. Preserve search verification tags when editing the head. Social
platforms cache previews independently; existing shares may retain older cards.
