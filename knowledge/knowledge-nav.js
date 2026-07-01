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

  function articleCard(article, currentSlug) {
    const status = article.status || 'Available';
    const available = normalize(status) === 'available';
    const active = article.slug === currentSlug;
    const classes = ['station-card'];
    if (active) classes.push('is-active');
    if (!available) classes.push('is-disabled');

    const label = `${article.title || ''} ${article.summary || ''} ${article.category || ''} ${article.difficulty || ''} ${status}`;
    const badge = active ? 'Current page' : status;
    const inner = `
      <strong>${escapeHtml(article.title || 'Untitled article')}</strong>
      <span>${escapeHtml(article.summary || '')}</span>
      <span>📂 ${escapeHtml(article.category || 'Knowledge Center')}</span>
      <span>📖 ${escapeHtml(article.readingTime || '')}</span>
      <span>🎓 ${escapeHtml(article.difficulty || '')}</span>
      <span class="station-status">${escapeHtml(badge)}</span>
    `;

    if (available) {
      const href = article.url || `/knowledge/${article.slug}/`;
      return `<a class="${classes.join(' ')}" href="${href}" data-article-card data-search="${escapeHtml(label)}">${inner}</a>`;
    }

    return `<div class="${classes.join(' ')}" data-article-card data-search="${escapeHtml(label)}">${inner}</div>`;
  }

  function render(root, data) {
    const articles = Array.isArray(data.articles) ? data.articles : [];
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const currentSlug = root.getAttribute('data-current-slug') || '';
    const availableCount = articles.filter(a => normalize(a.status || 'Available') === 'available').length;

    const categoryOptions = categories.map(category => {
      const title = category.title || category.id;
      return `<option value="${escapeHtml(title)}">${escapeHtml(title)}</option>`;
    }).join('');

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
        <div class="station-grid">
          ${articles.map(article => articleCard(article, currentSlug)).join('')}
        </div>
      </div>
      <div class="station-empty" role="status">No article matched your search.</div>
    `;

    if (!document.getElementById('knowledge-scroll-panel-style')) {
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
        .station-card.is-disabled { cursor: not-allowed; }
      `;
      document.head.appendChild(style);
    }

    const input = root.querySelector('.station-search[type="search"]');
    const select = root.querySelector('[data-category-filter]');
    const cards = Array.from(root.querySelectorAll('[data-article-card]'));
    const empty = root.querySelector('.station-empty');

    function applyFilter() {
      const q = normalize(input.value);
      const category = normalize(select.value);
      let visible = 0;

      cards.forEach(card => {
        const text = normalize(card.getAttribute('data-search'));
        const matchesText = !q || text.includes(q);
        const matchesCategory = !category || text.includes(category);
        const show = matchesText && matchesCategory;
        card.style.display = show ? '' : 'none';
        if (show) visible += 1;
      });

      empty.classList.toggle('is-visible', visible === 0);
    }

    input.addEventListener('input', applyFilter);
    select.addEventListener('change', applyFilter);
  }

  document.addEventListener('DOMContentLoaded', function () {
    const roots = Array.from(document.querySelectorAll('[data-articles-nav], [data-stations-nav]'));
    if (!roots.length) return;

    fetch('/knowledge/articles.json', { cache: 'no-cache' })
      .then(response => {
        if (!response.ok) throw new Error('Article list not available');
        return response.json();
      })
      .then(data => {
        if (!Array.isArray(data.articles)) throw new Error('articles.json must include an articles array');
        roots.forEach(root => render(root, data));
      })
      .catch(error => {
        console.error(error);
      });
  });
})();
