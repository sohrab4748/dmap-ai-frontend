(function () {

    function normalize(text) {
        return String(text || '').toLowerCase().trim();
    }

    function articleCard(article, currentSlug) {

        const active = article.slug === currentSlug;

        const classes = ['station-card'];

        if (active)
            classes.push('is-active');

        const label =
            `${article.title} ${article.summary} ${article.category}`;

        return `
        <a class="${classes.join(' ')}"
           href="/knowledge/${article.slug}/"
           data-article-card
           data-search="${label.replace(/"/g, '&quot;')}">

            <strong>${article.title}</strong>

            <span><strong>Summary:</strong> ${article.summary}</span>

            <span>📖 Reading time: ${article.readingTime}</span>

            <span>🎓 Level: ${article.difficulty}</span>
<span>

📂 ${article.category}

</span>
            <span class="station-status">
                ${article.featured ? 'Featured' : 'Article'}
            </span>

        </a>
        `;
    }

    function render(root, articles) {

        const currentSlug = root.getAttribute('data-current-slug') || '';

        root.innerHTML = `
            <div class="station-toolbar">

                <input
                    class="station-search"
                    type="search"
                    placeholder="Search articles..."
                    aria-label="Search articles">

                <span class="station-count-pill">
                    ${articles.length} Articles
                </span>

            </div>

            <div class="station-grid">

                ${articles.map(article =>
                    articleCard(article, currentSlug)
                ).join('')}

            </div>

            <div class="station-empty">
                No article matched your search.
            </div>
        `;

        const input =
            root.querySelector('.station-search');

        const cards =
            [...root.querySelectorAll('[data-article-card]')];

        const empty =
            root.querySelector('.station-empty');

        input.addEventListener('input', function () {

            const q = normalize(input.value);

            let visible = 0;

            cards.forEach(card => {

                const show =
                    !q ||
                    normalize(card.dataset.search).includes(q);

                card.style.display =
                    show ? '' : 'none';

                if (show)
                    visible++;

            });

            empty.classList.toggle(
                'is-visible',
                visible === 0
            );

        });

    }

    document.addEventListener('DOMContentLoaded', function () {

        const roots =
            [...document.querySelectorAll('[data-articles-nav]')];

        if (!roots.length)
            return;

        fetch('/knowledge/articles.json', {
            cache: 'no-cache'
        })
        .then(response => {

            if (!response.ok)
                throw new Error('Cannot load articles.json');

            return response.json();

        })
        .then(data => {

            if (!Array.isArray(data.articles))
                throw new Error('Invalid articles.json');

            roots.forEach(root =>
                render(root, data.articles)
            );

        })
        .catch(error => {

            console.error(error);

        });

    });

})();