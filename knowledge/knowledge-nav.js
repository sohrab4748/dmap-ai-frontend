(function () {
  function normalize(text) {
    return String(text || '').toLowerCase().trim();
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function isAvailable(article) {
    return normalize(article.status || 'Available') === 'available';
  }

  function buildCategoryMap(categories) {
    return new Map(categories.map(category => [
      category.id,
      category.title || category.id
    ]));
  }

  function articleCard(article, currentSlug, categoryTitle) {
    const available = isAvailable(article);
    const active = article.slug === currentSlug;
    const status = article.status || 'Available';
    const classes = ['station-card'];
    if (active) classes.push('is-active');
    if (!available) classes.push('is-disabled');

    const label = [
      article.title,
      article.summary,
      categoryTitle,
      article.difficulty,
      status
    ].join(' ');
    const badge = active ? 'Current page' : status;
    const inner = `
      <strong>${escapeHtml(article.title || 'Untitled article')}</strong>
      <span>${escapeHtml(article.summary || '')}</span>
      <span>📂 ${escapeHtml(categoryTitle || 'Knowledge Center')}</span>
      <span>📖 ${escapeHtml(article.readingTime || '')}</span>
      <span>🎓 ${escapeHtml(article.difficulty || '')}</span>
      <span class="station-status">${escapeHtml(badge)}</span>
    `;

    if (available) {
      const href = article.url || `/knowledge/${article.slug}/`;
      return `<a class="${classes.join(' ')}" href="${escapeHtml(href)}" data-article-card data-category="${escapeHtml(article.category)}" data-search="${escapeHtml(label)}">${inner}</a>`;
    }

    return `<div class="${classes.join(' ')}" data-article-card data-category="${escapeHtml(article.category)}" data-search="${escapeHtml(label)}">${inner}</div>`;
  }

  function categorySection(category, articles, currentSlug, categoryMap) {
    const categoryArticles = articles.filter(article => article.category === category.id);
    if (!categoryArticles.length) return '';

    const availableCount = categoryArticles.filter(isAvailable).length;
    const countLabel = availableCount
      ? `${availableCount} available`
      : `Coming soon · ${categoryArticles.length} planned`;

    return `
      <section class="knowledge-category-group" data-category-group="${escapeHtml(category.id)}">
        <div class="knowledge-category-heading">
          <h3>${escapeHtml(category.icon || '')} ${escapeHtml(category.title || category.id)}</h3>
          <span class="station-count-pill">${escapeHtml(countLabel)}</span>
        </div>
        <div class="station-grid">
          ${categoryArticles.map(article =>
            articleCard(article, currentSlug, categoryMap.get(article.category))
          ).join('')}
        </div>
      </section>
    `;
  }

  function renderTopicCards(data) {
    const root = document.querySelector('[data-topic-grid]');
    if (!root) return;

    const categories = Array.isArray(data.categories) ? data.categories : [];
    const articles = Array.isArray(data.articles) ? data.articles : [];
    root.innerHTML = categories.map(category => {
      const categoryArticles = articles.filter(article => article.category === category.id);
      const availableCount = categoryArticles.filter(isAvailable).length;
      const countText = availableCount
        ? `${availableCount} article${availableCount === 1 ? '' : 's'} available`
        : `Coming soon · ${categoryArticles.length} planned`;

      return `
        <article class="topic-card">
          <h2>${escapeHtml(category.icon || '')} ${escapeHtml(category.title || category.id)}</h2>
          <p>${escapeHtml(category.description || '')}</p>
          <span class="topic-count">${escapeHtml(countText)}</span>
        </article>
      `;
    }).join('');
  }

  function renderArticleBrowser(root, data) {
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const categoryMap = buildCategoryMap(categories);
    const currentSlug = root.getAttribute('data-current-slug') || '';
    const availableCount = articles.filter(isAvailable).length;

    const categoryOptions = categories
      .filter(category => articles.some(article => article.category === category.id))
      .map(category =>
        `<option value="${escapeHtml(category.id)}">${escapeHtml(category.title || category.id)}</option>`
      ).join('');

    root.innerHTML = `
      <div class="station-toolbar">
        <input class="station-search" type="search" placeholder="Search articles, methods, datasets..." aria-label="Search Knowledge Center articles">
        <select class="station-search" data-category-filter aria-label="Filter articles by category">
          <option value="">All categories</option>
          ${categoryOptions}
        </select>
        <span class="station-count-pill">${availableCount} available / ${articles.length} total</span>
      </div>
      <div class="knowledge-scroll-panel">
        ${categories.map(category =>
          categorySection(category, articles, currentSlug, categoryMap)
        ).join('')}
      </div>
      <div class="station-empty" role="status">No article matched your search.</div>
    `;

    const input = root.querySelector('.station-search[type="search"]');
    const select = root.querySelector('[data-category-filter]');
    const cards = Array.from(root.querySelectorAll('[data-article-card]'));
    const groups = Array.from(root.querySelectorAll('[data-category-group]'));
    const empty = root.querySelector('.station-empty');

    function applyFilter() {
      const query = normalize(input.value);
      const category = select.value;
      let visibleCards = 0;

      cards.forEach(card => {
        const matchesText = !query || normalize(card.getAttribute('data-search')).includes(query);
        const matchesCategory = !category || card.getAttribute('data-category') === category;
        const show = matchesText && matchesCategory;
        card.style.display = show ? '' : 'none';
        if (show) visibleCards += 1;
      });

      groups.forEach(group => {
        const hasVisibleCard = Array.from(group.querySelectorAll('[data-article-card]'))
          .some(card => card.style.display !== 'none');
        group.style.display = hasVisibleCard ? '' : 'none';
      });

      empty.classList.toggle('is-visible', visibleCards === 0);
    }

    input.addEventListener('input', applyFilter);
    select.addEventListener('change', applyFilter);
  }

  function addBrowserStyles() {
    if (document.getElementById('knowledge-scroll-panel-style')) return;

    const style = document.createElement('style');
    style.id = 'knowledge-scroll-panel-style';
    style.textContent = `
      .knowledge-scroll-panel {
        max-height: 620px;
        overflow-y: auto;
        padding-right: 6px;
      }
      .knowledge-scroll-panel::-webkit-scrollbar { width: 10px; }
      .knowledge-scroll-panel::-webkit-scrollbar-thumb { background: #bfdbfe; border-radius: 999px; }
      .knowledge-scroll-panel::-webkit-scrollbar-track { background: #f8fafc; border-radius: 999px; }
      .knowledge-category-group + .knowledge-category-group { margin-top: 1.5rem; }
      .knowledge-category-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        margin-bottom: .75rem;
      }
      .knowledge-category-heading h3 { margin: 0; color: #0f172a; }
      .station-card.is-disabled { cursor: not-allowed; }
    `;
    document.head.appendChild(style);
  }

  document.addEventListener('DOMContentLoaded', function () {
    const roots = Array.from(document.querySelectorAll('[data-articles-nav], [data-stations-nav]'));
    const topicGrid = document.querySelector('[data-topic-grid]');
    if (!roots.length && !topicGrid) return;

    fetch('/knowledge/articles.json', { cache: 'no-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Article list not available');
        return response.json();
      })
      .then(data => {
        if (!Array.isArray(data.categories) || !Array.isArray(data.articles)) {
          throw new Error('articles.json must include categories and articles arrays');
        }

        addBrowserStyles();
        renderTopicCards(data);
        roots.forEach(root => renderArticleBrowser(root, data));
      })
      .catch(error => {
        console.error(error);
      });
  });
})();
