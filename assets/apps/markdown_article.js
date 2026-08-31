/**
 * markdown_article.js
 * =====================================================================
 * Generic engine that turns a <article data-md-src="..."> element into a
 * rendered article. This file is intentionally NOT specific to the IIR
 * filters article -- it doesn't know anything about biquads or RBJ
 * filters. If you write a second article later, you can reuse this same
 * script: just give its container element a different data-md-src.
 *
 * What it does, step by step (see renderArticle() below):
 *   1. Reads the data-md-src attribute off the article element to find
 *      the markdown file to fetch (e.g. "/articles/iir_filters/article.md").
 *   2. Fetches that file as plain text.
 *   3. Pulls out any custom demo tags (lines like "<RBJ Example>") BEFORE
 *      handing the text to the markdown parser (see extractDemoTags()).
 *   4. Pulls math ($...$ and $$...$$) out of the remaining raw text,
 *      also before the markdown parser sees it (see extractMath() for why).
 *   5. Runs the remaining text through marked.parse() to get HTML.
 *   6. Puts the math back in, rendered as KaTeX HTML (renderMathIntoHtml()).
 *   7. Injects the final HTML into the article element.
 *   8. Syntax-highlights every fenced code block with highlight.js
 *      (highlightCodeBlocks()).
 *   9. Fixes up any relative image/link URLs so they resolve against the
 *      markdown file's folder, not the page's own URL (resolveRelativeUrls()).
 *  10. Replaces each demo tag's placeholder with a mount <div> a demo
 *      script can hydrate (insertDemoMounts()).
 *  11. Fires a custom "article:rendered" event on `document`, so any
 *      demo script (e.g. rbj_demo.js) knows the article HTML now exists
 *      and it's safe to look for its mount point(s).
 *
 * TO REUSE THIS FOR A NEW ARTICLE: add
 *   <article data-md-src="/articles/your-article/article.md">...</article>
 * to a new page, and load this script the same way iir_filters.html does.
 * No changes needed here unless your new article needs different markdown
 * features than this file already supports.
 *
 * TO ADD A NEW DEMO TO AN ARTICLE'S MARKDOWN: write a tag by itself on its
 * own line, with a blank line above and below it, e.g.:
 *
 *   Some paragraph of text.
 *
 *   <My Cool Demo>
 *
 *   More text after the demo.
 *
 * This gets turned into <div class="demo-mount" data-demo="my-cool-demo"
 * id="demo-mount-0"></div> in the rendered page (see extractDemoTags() and
 * insertDemoMounts() below for exactly how the tag text becomes the
 * "my-cool-demo" slug). Your demo's JS file should then do:
 *
 *   document.addEventListener('article:rendered', function () {
 *       document.querySelectorAll('[data-demo="my-cool-demo"]').forEach(function (mount) {
 *           initMyDemo(mount);
 *       });
 *   });
 *
 * See rbj_demo.js for a full worked example (its DEMO_SLUG constant and the
 * "<RBJ Example>" tag in articles/iir_filters/article.md).
 */
(function () {
    'use strict';

    // Placeholder tokens used to "hide" math AND demo tags from the markdown
    // parser (see extractMath()/extractDemoTags()/renderMathIntoHtml() below).
    // These are deliberately plain alphanumeric text with no markdown-special
    // characters, so marked.js will never mangle them (no underscores/
    // asterisks/etc. that could be misread as emphasis, lists, etc.). If you
    // ever see literal text like "zzMATHBLOCKzz3zzENDzz" or
    // "zzDEMOTAGzz0zzENDzz" show up on the page, it means a placeholder
    // failed to get swapped back out -- see renderMathIntoHtml() and
    // insertDemoMounts().
    var MATH_BLOCK_TAG = 'zzMATHBLOCKzz';
    var MATH_INLINE_TAG = 'zzMATHINLINEzz';
    var DEMO_TAG_TAG = 'zzDEMOTAGzz';
    var PLACEHOLDER_END_TAG = 'zzENDzz';

    /**
     * Pull $$...$$ (block/display math) and $...$ (inline math) spans out
     * of the raw markdown BEFORE marked.js ever sees them, replacing each
     * with a plain-text placeholder. Returns { text, store } where `text`
     * is the markdown with placeholders substituted in, and `store` is an
     * array of { tex, display } objects indexed by the number embedded in
     * each placeholder.
     *
     * WHY: LaTeX is full of characters markdown treats specially --
     * underscores (subscripts, e.g. $a_1$), asterisks, backslashes. If you
     * fed LaTeX straight into marked.js, it would try to interpret those as
     * emphasis/lists/etc. and mangle the math. Swapping math out for inert
     * placeholders first, running marked, then swapping the *rendered*
     * KaTeX HTML back in afterwards, sidesteps that entirely.
     *
     * Order matters: block math ($$...$$) is extracted first so that its
     * count(s) of `$` characters don't get accidentally matched by the
     * inline-math regex afterwards.
     */
    function extractMath(source) {
        var store = [];

        // $$ ... $$ (can span multiple lines). Wrapped in blank lines so
        // marked treats the placeholder as its own paragraph (otherwise it
        // might get glued onto adjacent text).
        var text = source.replace(/\$\$([\s\S]+?)\$\$/g, function (match, tex) {
            var idx = store.length;
            store.push({ tex: tex.trim(), display: true });
            return '\n\n' + MATH_BLOCK_TAG + idx + PLACEHOLDER_END_TAG + '\n\n';
        });

        // $ ... $ (single line only -- the [^\n$] means "no newlines, no
        // more dollar signs", so this can't accidentally gobble up two
        // separate inline-math spans as one).
        text = text.replace(/\$([^\n$]+?)\$/g, function (match, tex) {
            var idx = store.length;
            store.push({ tex: tex.trim(), display: false });
            return MATH_INLINE_TAG + idx + PLACEHOLDER_END_TAG;
        });

        return { text: text, store: store };
    }

    /**
     * After marked.js has turned the (placeholder-containing) markdown into
     * HTML, find every math placeholder token in that HTML and replace it
     * with real KaTeX-rendered math, using the `store` array built by
     * extractMath() to look up which LaTeX source each placeholder stands
     * for.
     *
     * `display: true` entries (from $$...$$) render as centered block math;
     * `display: false` entries (from $...$) render inline with the text.
     */
    function renderMathIntoHtml(html, store) {
        var pattern = new RegExp('(' + MATH_BLOCK_TAG + '|' + MATH_INLINE_TAG + ')(\\d+)' + PLACEHOLDER_END_TAG, 'g');
        return html.replace(pattern, function (match, prefix, idxStr) {
            var entry = store[Number(idxStr)];
            if (!entry) return match; // shouldn't happen, but don't crash if it does
            if (typeof window.katex === 'undefined') return entry.tex; // KaTeX failed to load: show raw LaTeX rather than nothing
            try {
                return window.katex.renderToString(entry.tex, {
                    throwOnError: false, // render what it can instead of throwing on a typo'd formula
                    displayMode: entry.display
                });
            } catch (err) {
                // Only reachable if KaTeX throws something throwOnError:false doesn't
                // catch on its own; fall back to showing the raw LaTeX in a <code> tag
                // so a single bad formula doesn't take down the rest of the article.
                console.error('KaTeX render error for "' + entry.tex + '":', err);
                return '<code>' + entry.tex + '</code>';
            }
        });
    }

    /**
     * Syntax-highlight every fenced code block in the rendered article using
     * highlight.js (loaded from a CDN in the article's HTML page -- see
     * iir_filters.html's <head>/script tags). marked.js already renders a
     * fenced block like:
     *
     *   ```cpp
     *   int x = 1;
     *   ```
     *
     * as <pre><code class="language-cpp">int x = 1;</code></pre> -- the
     * "language-cpp" class is exactly what highlight.js looks for to pick a
     * language, so there's nothing to configure here beyond calling it on
     * each block. Blocks with no language on the fence (plain ```) get
     * highlight.js's best-guess auto-detection instead of nothing.
     *
     * If the highlight.js CDN script failed to load (offline, ad blocker,
     * CDN outage), this silently no-ops and the code just renders unstyled
     * -- same fallback philosophy as the KaTeX/marked missing-library checks
     * elsewhere in this file.
     */
    function highlightCodeBlocks(container) {
        if (typeof window.hljs === 'undefined') return;
        container.querySelectorAll('pre code').forEach(function (block) {
            window.hljs.highlightElement(block);
        });
    }

    // True for URLs that are neither absolute (http://, //cdn.example.com/...),
    // root-relative (/foo/bar), nor anchor links (#section) -- i.e. the kind
    // of path that's meant to be resolved relative to *some* base directory.
    function isRelativeUrl(url) {
        return !!url && !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url) &&
            url.charAt(0) !== '/' && url.charAt(0) !== '#';
    }

    /**
     * The markdown file can live in its own folder (e.g.
     * /articles/iir_filters/article.md) while the HTML page that renders it
     * lives one level up (/articles/iir_filters.html). If article.md has an
     * image reference like ![caption](diagram.svg), that path is meant to
     * be relative to article.md's own folder -- NOT relative to the page's
     * URL. Without this fix-up, the browser would try (and fail) to load
     * /articles/diagram.svg instead of /articles/iir_filters/diagram.svg.
     *
     * `container` is the <article> element after marked's HTML has been
     * injected into it; `baseDir` is the markdown file's directory (computed
     * in renderArticle() below from data-md-src).
     *
     * TO ADD AN IMAGE TO THE ARTICLE: just drop the image file in the same
     * folder as article.md (articles/iir_filters/) and reference it in the
     * markdown as ![alt text](your-image.svg) -- this function handles the
     * rest automatically. Absolute paths (starting with / or http://) are
     * left untouched, so you can also link to images elsewhere on the site
     * (e.g. /assets/images/foo.png) or off-site.
     */
    function resolveRelativeUrls(container, baseDir) {
        var base = baseDir.replace(/\/$/, ''); // strip any trailing slash

        container.querySelectorAll('img[src], source[src]').forEach(function (el) {
            var src = el.getAttribute('src');
            if (isRelativeUrl(src)) {
                el.setAttribute('src', base + '/' + src);
            }
        });

        container.querySelectorAll('a[href]').forEach(function (el) {
            var href = el.getAttribute('href');
            if (isRelativeUrl(href) && href.indexOf('mailto:') !== 0) {
                el.setAttribute('href', base + '/' + href);
            }
        });
    }

    /**
     * Find lines that are just a bare "<Some Demo Name>" tag -- alone on
     * their own line, with nothing else on that line -- and pull them out
     * of the raw markdown BEFORE marked.js sees them, the same way
     * extractMath() pulls out LaTeX. Each match is replaced with an inert
     * placeholder (so marked doesn't try to interpret "<...>" as an HTML
     * tag) and recorded in `store` as { slug }, where `slug` is the tag
     * text lowercased with spaces/underscores turned into hyphens (e.g.
     * "<RBJ Example>" -> "rbj-example", "<My Cool Demo>" -> "my-cool-demo").
     *
     * This is intentionally generic -- it doesn't know what "RBJ Example"
     * or any other demo actually is. It just recognizes the tag syntax and
     * hands the slug to insertDemoMounts() below, which creates a mount
     * point a demo script can find later via document.querySelectorAll
     * ('[data-demo="rbj-example"]') (see the module doc-comment at the top
     * of this file for the full how-to).
     *
     * WRITING A TAG IN YOUR MARKDOWN: put it on its own line, with a blank
     * line above and below (so it parses as its own paragraph), e.g.:
     *
     *   <RBJ Example>
     *
     * The regex requires the whole line to be just "<Name>" (only letters,
     * digits, spaces, hyphens, underscores inside the brackets) -- it will
     * NOT match things like "<div>" mixed into other text, ordinary HTML
     * you might paste into the markdown, or a tag with extra words after it
     * on the same line.
     */
    function extractDemoTags(source) {
        var store = [];
        var text = source.replace(/^[ \t]*<([A-Za-z][A-Za-z0-9 _-]*)>[ \t]*$/gm, function (match, name) {
            var idx = store.length;
            var slug = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
            store.push({ slug: slug });
            return '\n\n' + DEMO_TAG_TAG + idx + PLACEHOLDER_END_TAG + '\n\n';
        });
        return { text: text, store: store };
    }

    /**
     * After marked.js has turned the (placeholder-containing) markdown into
     * HTML, find the paragraph/heading holding each demo-tag placeholder
     * and swap it out for an empty mount <div>, e.g.
     * <div class="demo-mount" data-demo="rbj-example" id="demo-mount-0">.
     *
     * A demo script listens for the "article:rendered" event (fired at the
     * end of renderArticle() below) and then looks for
     * document.querySelectorAll('[data-demo="its-own-slug"]') to hydrate
     * every mount matching its slug -- see rbj_demo.js for a worked example.
     * Using data-demo (instead of one hardcoded id, like the old
     * "#rbj-demo-mount" approach) means this same mechanism supports any
     * number of differently-named demos, and even more than one instance of
     * the same demo, on a single page.
     *
     * `store` is the array returned by extractDemoTags() above.
     */
    function insertDemoMounts(container, store) {
        var pattern = new RegExp('^' + DEMO_TAG_TAG + '(\\d+)' + PLACEHOLDER_END_TAG + '$');
        var nodes = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
        var mountCount = 0;
        nodes.forEach(function (el) {
            var match = pattern.exec(el.textContent.trim());
            if (!match) return;
            var entry = store[Number(match[1])];
            if (!entry) return;
            var mount = document.createElement('div');
            mount.id = 'demo-mount-' + mountCount++;
            mount.className = 'demo-mount'; // styled in article_style.css (just a min-height placeholder)
            mount.setAttribute('data-demo', entry.slug);
            el.replaceWith(mount);
        });
    }

    /**
     * The main entry point: fetches, renders, and injects the article for
     * a single <article data-md-src="..."> container element.
     */
    function renderArticle(container) {
        var mdSrc = container.getAttribute('data-md-src');
        if (!mdSrc) return; // no data-md-src attribute -- nothing to do

        // e.g. "/articles/iir_filters/article.md" -> "/articles/iir_filters"
        var baseDir = mdSrc.substring(0, mdSrc.lastIndexOf('/')) || '/';

        fetch(mdSrc)
            .then(function (res) {
                if (!res.ok) throw new Error('Failed to fetch ' + mdSrc + ' (' + res.status + ')');
                return res.text();
            })
            .then(function (raw) {
                if (typeof window.marked === 'undefined') {
                    // marked.js didn't load (CDN down, ad blocker, etc.) -- bail out
                    // with a clear error rather than silently showing nothing.
                    throw new Error('marked library did not load');
                }

                // Demo tags are extracted first, then math, so a demo tag
                // sharing a line-shape with math (unlikely, but not
                // impossible) can't confuse either extractor.
                var demoExtracted = extractDemoTags(raw);
                var mathExtracted = extractMath(demoExtracted.text);

                // gfm: true enables GitHub-flavored markdown extras (tables,
                // strikethrough, autolinking bare URLs, etc.). breaks: false
                // means a single newline in the markdown does NOT become a
                // <br> -- you need a blank line for a new paragraph, which is
                // standard markdown behavior and matches how article.md is written.
                window.marked.setOptions({ gfm: true, breaks: false });
                var html = window.marked.parse(mathExtracted.text);
                html = renderMathIntoHtml(html, mathExtracted.store);

                container.innerHTML = html;
                highlightCodeBlocks(container);
                resolveRelativeUrls(container, baseDir);
                insertDemoMounts(container, demoExtracted.store);

                // Let any demo script know the article HTML (and its mount
                // point(s), if any) now exist in the DOM.
                document.dispatchEvent(new CustomEvent('article:rendered', {
                    detail: { container: container }
                }));
            })
            .catch(function (err) {
                // Covers: network failure, 404, marked/katex missing, or any
                // unexpected error above. Whatever happens, show *something*
                // readable instead of leaving "Loading article…" up forever.
                console.error(err);
                container.innerHTML = '<p class="article-error">Sorry, something went wrong loading this article' +
                    (err && err.message ? ' (' + err.message + ')' : '') + '.</p>';
            });
    }

    // Kick things off once the page's HTML has finished parsing. Supports
    // multiple articles per page in theory (querySelectorAll + forEach would
    // be needed for that) but right now just grabs the first element with a
    // data-md-src attribute, since each article page only has one.
    document.addEventListener('DOMContentLoaded', function () {
        var container = document.querySelector('[data-md-src]');
        if (container) renderArticle(container);
    });
})();
