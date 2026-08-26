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
 *   3. Pulls math ($...$ and $$...$$) out of the raw text BEFORE handing
 *      it to the markdown parser (see extractMath() for why).
 *   4. Runs the remaining text through marked.parse() to get HTML.
 *   5. Puts the math back in, rendered as KaTeX HTML (renderMathIntoHtml()).
 *   6. Injects the final HTML into the article element.
 *   7. Fixes up any relative image/link URLs so they resolve against the
 *      markdown file's folder, not the page's own URL (resolveRelativeUrls()).
 *   8. Replaces a lone "EXAMPLE HERE" paragraph with a mount point a
 *      demo script can hydrate (insertDemoMounts()).
 *   9. Fires a custom "article:rendered" event on `document`, so any
 *      demo script (e.g. rbj_demo.js) knows the article HTML now exists
 *      and it's safe to look for its mount point.
 *
 * TO REUSE THIS FOR A NEW ARTICLE: add
 *   <article data-md-src="/articles/your-article/article.md">...</article>
 * to a new page, and load this script the same way iir_filters.html does.
 * No changes needed here unless your new article needs different markdown
 * features than this file already supports.
 */
(function () {
    'use strict';

    // Placeholder tokens used to "hide" math from the markdown parser (see
    // extractMath()/renderMathIntoHtml() below). These are deliberately
    // plain alphanumeric text with no markdown-special characters, so
    // marked.js will never mangle them (no underscores/asterisks/etc. that
    // could be misread as emphasis, lists, etc.). If you ever see literal
    // text like "zzMATHBLOCKzz3zzENDzz" show up on the page, it means a
    // placeholder failed to get swapped back out -- see renderMathIntoHtml().
    var MATH_BLOCK_TAG = 'zzMATHBLOCKzz';
    var MATH_INLINE_TAG = 'zzMATHINLINEzz';
    var MATH_END_TAG = 'zzENDzz';

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
            return '\n\n' + MATH_BLOCK_TAG + idx + MATH_END_TAG + '\n\n';
        });

        // $ ... $ (single line only -- the [^\n$] means "no newlines, no
        // more dollar signs", so this can't accidentally gobble up two
        // separate inline-math spans as one).
        text = text.replace(/\$([^\n$]+?)\$/g, function (match, tex) {
            var idx = store.length;
            store.push({ tex: tex.trim(), display: false });
            return MATH_INLINE_TAG + idx + MATH_END_TAG;
        });

        return { text: text, store: store };
    }

    /**
     * After marked.js has turned the (placeholder-containing) markdown into
     * HTML, find every placeholder token in that HTML and replace it with
     * real KaTeX-rendered math, using the `store` array built by
     * extractMath() to look up which LaTeX source each placeholder stands
     * for.
     *
     * `display: true` entries (from $$...$$) render as centered block math;
     * `display: false` entries (from $...$) render inline with the text.
     */
    function renderMathIntoHtml(html, store) {
        var pattern = new RegExp('(' + MATH_BLOCK_TAG + '|' + MATH_INLINE_TAG + ')(\\d+)' + MATH_END_TAG, 'g');
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
     * Find a paragraph or heading whose ENTIRE text content is "EXAMPLE
     * HERE" (case-insensitive, ignoring any bold/italic markup around it --
     * e.g. the article's "***EXAMPLE HERE***" renders as
     * <p><em><strong>EXAMPLE HERE</strong></em></p>, and el.textContent
     * flattens that to just "EXAMPLE HERE" regardless of the nested tags)
     * and swap it out for an empty <div id="rbj-demo-mount">.
     *
     * rbj_demo.js listens for the "article:rendered" event (fired at the
     * end of renderArticle() below) and then looks for
     * document.getElementById('rbj-demo-mount') to hydrate.
     *
     * TO MOVE THE DEMO TO A DIFFERENT SPOT IN THE ARTICLE: just move the
     * "***EXAMPLE HERE***" line to wherever you want it in article.md --
     * this function will find it wherever it ends up.
     *
     * TO ADD A DIFFERENT DEMO TO A DIFFERENT ARTICLE: this function is
     * currently hardcoded to look for the exact text "EXAMPLE HERE" and to
     * create a mount point with id "rbj-demo-mount". If you want a
     * differently-named placeholder/mount for a future article, you'd
     * either generalize this function (e.g. read the desired placeholder
     * text and mount id from a data-* attribute) or copy this whole file
     * and adjust it for the new article.
     */
    function insertDemoMounts(container) {
        var placeholderPattern = /^example here$/i;
        var nodes = container.querySelectorAll('p, h1, h2, h3, h4, h5, h6');
        nodes.forEach(function (el) {
            if (placeholderPattern.test(el.textContent.trim())) {
                var mount = document.createElement('div');
                mount.id = 'rbj-demo-mount';
                mount.className = 'demo-mount'; // styled in article_style.css (just a min-height placeholder)
                el.replaceWith(mount);
            }
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

                var extracted = extractMath(raw);

                // gfm: true enables GitHub-flavored markdown extras (tables,
                // strikethrough, autolinking bare URLs, etc.). breaks: false
                // means a single newline in the markdown does NOT become a
                // <br> -- you need a blank line for a new paragraph, which is
                // standard markdown behavior and matches how article.md is written.
                window.marked.setOptions({ gfm: true, breaks: false });
                var html = window.marked.parse(extracted.text);
                html = renderMathIntoHtml(html, extracted.store);

                container.innerHTML = html;
                resolveRelativeUrls(container, baseDir);
                insertDemoMounts(container);

                // Let any demo script know the article HTML (and its mount
                // point, if any) now exists in the DOM.
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
