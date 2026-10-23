/*
 * Artifact Explorer: Progressive enhancement for Jenkins Job & Build summary pages.
 * Turns classic flat <table class="fileList"> into an interactive, searchable tree view.
 */
(function () {
  'use strict';

  // Do not run on the dedicated Artifact Explorer page itself or when legacy escape hatch is used
  if (document.getElementById('artifact-explorer') || window.location.search.includes('legacy=1')) {
    return;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgIcon(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    // The "external" glyph is the ionicons "open" icon (512 unit grid), same as Jenkins' own external.svg
    svg.setAttribute('viewBox', kind === 'external' ? '0 0 512 512' : '0 0 16 16');
    svg.setAttribute('class', 'ae-sum-icon ae-sum-icon--' + kind);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    const shapes = {
      folder: 'M1.5 3A1.5 1.5 0 0 1 3 1.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z',
      file: 'M3.5 1.5h6l3 3v10h-9zM9 1.5v3.5h3.5',
      caret: 'M6 3.5l4.5 4.5L6 12.5',
      tree: 'M8 1v14M8 4H4m4 4H3m5 4H4M8 3h4m-4 4h5m-5 4h4',
      flat: 'M3 3h10M3 7h10M3 11h10M3 15h6',
      external: 'M384 224v184a40 40 0 01-40 40H104a40 40 0 01-40-40V168a40 40 0 0140-40h167.48M336 64h112v112M224 288L440 72',
      download: 'M8 2v8m0 0L5 7m3 3l3-3M3 13h10',
      package: 'M8.186 1.113a.5.5 0 0 0-.372 0L1.846 3.5 8 5.961 14.154 3.5 8.186 1.113zM15 4.239l-6.5 2.6v7.922l6.5-2.6V4.24zM7.5 14.762V6.838L1 4.239v7.923l6.5 2.6z',
      copy: 'M5 4h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm-2 8V3a1 1 0 0 1 1-1h7',
      check: 'M3.5 8.5l3 3 6-7'
    };
    path.setAttribute('d', shapes[kind] || shapes.file);
    if (kind === 'external') {
      path.setAttribute('stroke-width', '32');
    }
    svg.appendChild(path);
    return svg;
  }

  function getExtension(path) {
    const name = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
    if (name.endsWith('.tar.gz')) return '.tar.gz';
    if (name.endsWith('.tar.bz2')) return '.tar.bz2';
    if (name.endsWith('.tar.xz')) return '.tar.xz';
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx > 0) {
      return name.substring(dotIdx);
    }
    return null;
  }

  function highlight(text, query) {
    const fragment = document.createDocumentFragment();
    if (!query) {
      fragment.appendChild(document.createTextNode(text));
      return fragment;
    }
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(' + escaped + ')', 'ig');
    text.split(regex).forEach((part, index) => {
      if (!part) return;
      if (index % 2 === 1) {
        const mark = el('mark', '', part);
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(document.createTextNode(part));
      }
    });
    return fragment;
  }

  function notify(message, isWarning) {
    if (!message) {
      return;
    }
    if (window.notificationBar && typeof window.notificationBar.show === 'function') {
      const type = isWarning ? window.notificationBar.WARNING : window.notificationBar.SUCCESS;
      window.notificationBar.show(message, type);
    }
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return false;
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // Fall back to hidden textarea execCommand
      }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.className = 'ae-clipboard-buffer';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, text.length);
      const successful = document.execCommand('copy');
      document.body.removeChild(ta);
      if (successful) {
        return true;
      }
    } catch (err) {
      // ignore
    }
    return false;
  }

  function enhanceFileListTable(table) {
    try {
      if (table.dataset.aeEnhanced === 'true') return;
      const fileRows = table.querySelectorAll('tr');
      if (!fileRows || fileRows.length === 0) return;

      // Check if table contains artifact links
      const firstLink = table.querySelector('a[href*="/artifact/"]');
      if (!firstLink) return;

      table.dataset.aeEnhanced = 'true';

    // Find main artifact directory URL for the full explorer link
    const artIdx = firstLink.href.indexOf('/artifact/');
    const artifactRootUrl = artIdx !== -1 ? firstLink.href.substring(0, artIdx + 10) : firstLink.href;
    const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

    // Parse files into hierarchical tree and flat list
    const rootNode = { name: '', path: '', isDirectory: true, children: new Map(), files: [] };
    const allFiles = [];
    let hasSubdirectories = false;

    fileRows.forEach((tr) => {
      const a = tr.querySelector('a[href*="/artifact/"]');
      if (!a) return;
      const href = a.getAttribute('href');
      const artIdx = href.indexOf('/artifact/');
      if (artIdx === -1) return;

      const rawRelPath = href.substring(artIdx + 10);
      let decodedRelPath = rawRelPath;
      try {
        decodedRelPath = decodeURIComponent(rawRelPath);
      } catch (e) {}

      // Strip query / hash / trailing view tokens
      decodedRelPath = decodedRelPath.replace(/(\/\*view\*|\/\*fingerprint\*).*$/, '');
      if (decodedRelPath.endsWith('/')) {
        decodedRelPath = decodedRelPath.substring(0, decodedRelPath.length - 1);
      }

      const sizeCell = tr.querySelector('.fileSize');
      const sizeText = sizeCell ? sizeCell.textContent.trim() : '';

      const viewLink = tr.querySelector('a[href*="/*view*/"]');
      const viewHref = viewLink ? viewLink.getAttribute('href') : null;

      const fpLink = tr.querySelector('a[href*="/*fingerprint*/"]');
      const fpHref = fpLink ? fpLink.getAttribute('href') : null;

      const segments = decodedRelPath.split('/').filter(Boolean);
      if (segments.length > 1) {
        hasSubdirectories = true;
      }

      let curr = rootNode;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (!curr.children.has(seg)) {
          const dirPath = segments.slice(0, i + 1).join('/');
          curr.children.set(seg, {
            name: seg,
            path: dirPath,
            isDirectory: true,
            children: new Map(),
            files: []
          });
        }
        curr = curr.children.get(seg);
      }

      const fileName = segments.length > 0 ? segments[segments.length - 1] : a.textContent.trim();
      const fileObj = {
        name: fileName,
        path: decodedRelPath,
        href: href,
        size: sizeText,
        viewHref: viewHref,
        fpHref: fpHref
      };
      curr.files.push(fileObj);
      allFiles.push(fileObj);
    });

    // Create enhancement UI container
    const wrapper = el('div', 'ae-sum-wrapper');
    const toolbar = el('div', 'ae-sum-toolbar');

    // View toggle buttons (Tree vs Flat)
    const toggleGroup = el('div', 'ae-sum-btn-group');
    const treeBtn = el('button', 'ae-sum-toggle ae-sum-toggle--active', ' Tree');
    treeBtn.type = 'button';
    treeBtn.prepend(svgIcon('tree'));
    const flatBtn = el('button', 'ae-sum-toggle', ' Flat');
    flatBtn.type = 'button';
    flatBtn.prepend(svgIcon('flat'));
    toggleGroup.append(treeBtn, flatBtn);

    // Search filter
    const searchWrap = el('div', 'ae-sum-search-wrap');
    const searchInput = el('input', 'ae-sum-search');
    searchInput.type = 'search';
    searchInput.placeholder = 'Filter artifacts...';
    searchWrap.appendChild(searchInput);

    // Link to full explorer
    const explorerLink = el('a', 'ae-sum-link', 'Full Explorer ');
    explorerLink.href = artifactRootUrl;
    explorerLink.title = 'Open in full Artifact Explorer';
    explorerLink.appendChild(svgIcon('external'));

    toolbar.append(toggleGroup, searchWrap, explorerLink);

    // Extension filter pills bar
    const sumPillsBar = el('div', 'ae-sum-pills');
    let activeSummaryExt = null;

    function setSummaryExt(ext) {
      activeSummaryExt = ext;
      sumPillsBar.querySelectorAll('.ae-sum-pill').forEach((p) => {
        const isTarget = ext === null ? !p.dataset.ext : p.dataset.ext === ext;
        p.classList.toggle('ae-sum-pill--active', isTarget);
      });
      applyFilter();
    }

    const extCounts = new Map();
    allFiles.forEach((f) => {
      const ext = getExtension(f.path);
      if (ext) {
        extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
      }
    });

    if (extCounts.size > 1) {
      const sortedExts = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const allPill = el('button', 'ae-sum-pill ae-sum-pill--active');
      allPill.type = 'button';
      allPill.append(el('span', '', 'All'), el('span', 'ae-sum-pill-count', String(allFiles.length)));
      allPill.addEventListener('click', () => setSummaryExt(null));
      sumPillsBar.appendChild(allPill);

      sortedExts.slice(0, 10).forEach(([ext, count]) => {
        const pill = el('button', 'ae-sum-pill');
        pill.type = 'button';
        pill.dataset.ext = ext;
        pill.append(el('span', '', ext), el('span', 'ae-sum-pill-count', String(count)));
        pill.addEventListener('click', () => {
          if (activeSummaryExt === ext) {
            setSummaryExt(null);
          } else {
            setSummaryExt(ext);
          }
        });
        sumPillsBar.appendChild(pill);
      });
    } else {
      sumPillsBar.hidden = true;
    }

    // Containers for Tree and Flat views
    const treeRootEl = el('div', 'ae-sum-tree');
    const flatRootEl = el('div', 'ae-sum-flat');
    flatRootEl.hidden = true;
    wrapper.append(toolbar, sumPillsBar, treeRootEl, flatRootEl);

    // Render tree function
    function renderTree(filterQuery) {
      treeRootEl.replaceChildren();
      const q = (filterQuery || '').trim().toLowerCase();

      function buildDirUl(dirNode, depth) {
        const ul = el('ul', 'ae-sum-list');
        if (depth > 0) ul.classList.add('ae-sum-list--nested');

        // Render subdirectories
        const sortedDirs = Array.from(dirNode.children.values()).sort((a, b) => a.name.localeCompare(b.name));
        sortedDirs.forEach((subDir) => {
          const matchingCount = countMatches(subDir, q);
          if (q && matchingCount === 0) return;

          const li = el('li', 'ae-sum-node ae-sum-node--dir');
          li.style.setProperty('--depth', depth);

          const row = el('div', 'ae-sum-row ae-sum-row--dir');
          const toggle = el('button', 'ae-sum-caret');
          toggle.type = 'button';
          toggle.appendChild(svgIcon('caret'));

          const folderIcon = svgIcon('folder');
          const nameSpan = el('span', 'ae-sum-name ae-sum-name--dir');
          nameSpan.appendChild(highlight(subDir.name, q));

          const countBadge = el('span', 'ae-sum-badge', subDir.files.length + subDir.children.size + ' items');

          const actions = el('span', 'ae-sum-actions');
          const zipLink = el('a', 'ae-sum-act-link', 'zip');
          zipLink.href = artifactRootUrl + encodePath(subDir.path) + '/*zip*/' + encodeURIComponent(subDir.name) + '.zip';
          zipLink.title = 'Download ' + subDir.name + ' as .zip';
          zipLink.setAttribute('aria-label', 'Download ' + subDir.name + ' as .zip');
          zipLink.addEventListener('click', (e) => e.stopPropagation());
          actions.appendChild(zipLink);

          row.append(toggle, folderIcon, nameSpan, countBadge, actions);
          li.appendChild(row);

          const childUl = buildDirUl(subDir, depth + 1);
          li.appendChild(childUl);

          // Folders open by default if depth < 2 or if searching
          let isOpen = depth < 2 || (q.length > 0 && matchingCount > 0);
          li.classList.toggle('ae-sum-node--open', isOpen);
          childUl.hidden = !isOpen;

          function toggleDir() {
            isOpen = !isOpen;
            li.classList.toggle('ae-sum-node--open', isOpen);
            childUl.hidden = !isOpen;
          }

          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleDir();
          });
          row.addEventListener('click', toggleDir);

          ul.appendChild(li);
        });

        // Render files
        const sortedFiles = dirNode.files.slice().sort((a, b) => a.name.localeCompare(b.name));
        sortedFiles.forEach((file) => {
          if (q && !file.path.toLowerCase().includes(q)) return;
          if (activeSummaryExt && getExtension(file.path) !== activeSummaryExt) return;

          const li = el('li', 'ae-sum-node ae-sum-node--file');
          li.style.setProperty('--depth', depth);

          const row = el('div', 'ae-sum-row ae-sum-row--file');
          const spacer = el('span', 'ae-sum-caret ae-sum-caret--spacer');
          const fileIcon = svgIcon('file');

          const link = el('a', 'ae-sum-name ae-sum-name--file');
          link.href = file.href;
          link.appendChild(highlight(file.name, q));

          const size = el('span', 'ae-sum-size', file.size);

          const actions = el('span', 'ae-sum-actions');
          if (file.viewHref) {
            const vLink = el('a', 'ae-sum-act-link', 'view');
            vLink.href = file.viewHref;
            actions.appendChild(vLink);
          }
          if (file.fpHref) {
            const fpLink = el('a', 'ae-sum-act-link', 'fingerprint');
            fpLink.href = file.fpHref;
            actions.appendChild(fpLink);
          }

          row.append(spacer, fileIcon, link, size, actions);
          li.appendChild(row);
          ul.appendChild(li);
        });

        return ul;
      }

      function countMatches(dirNode, query) {
        let count = dirNode.files.filter((f) => (!query || f.path.toLowerCase().includes(query)) && (!activeSummaryExt || getExtension(f.path) === activeSummaryExt)).length;
        dirNode.children.forEach((c) => {
          count += countMatches(c, query);
        });
        return count;
      }

      const treeDom = buildDirUl(rootNode, 0);
      if (treeDom.children.length === 0) {
        treeRootEl.appendChild(el('div', 'ae-sum-empty', 'No matching artifacts found.'));
      } else {
        treeRootEl.appendChild(treeDom);
      }
    }

    // Render modern consistent flat view function
    function renderFlat(filterQuery) {
      flatRootEl.replaceChildren();
      const q = (filterQuery || '').trim().toLowerCase();
      const sorted = allFiles.slice().sort((a, b) => a.path.localeCompare(b.path));
      const matches = sorted.filter((f) => (!q || f.path.toLowerCase().includes(q)) && (!activeSummaryExt || getExtension(f.path) === activeSummaryExt));

      if (matches.length === 0) {
        flatRootEl.appendChild(el('div', 'ae-sum-empty', 'No matching artifacts found.'));
        return;
      }

      const ul = el('ul', 'ae-sum-list');
      matches.forEach((file) => {
        const li = el('li', 'ae-sum-node ae-sum-node--file');
        const row = el('div', 'ae-sum-row ae-sum-row--file ae-sum-row--flat');
        const fileIcon = svgIcon('file');

        const link = el('a', 'ae-sum-name ae-sum-name--file');
        link.href = file.href;
        link.appendChild(highlight(file.path, q));

        const size = el('span', 'ae-sum-size', file.size);

        const actions = el('span', 'ae-sum-actions');
        if (file.viewHref) {
          const vLink = el('a', 'ae-sum-act-link', 'view');
          vLink.href = file.viewHref;
          actions.appendChild(vLink);
        }
        if (file.fpHref) {
          const fpLink = el('a', 'ae-sum-act-link', 'fingerprint');
          fpLink.href = file.fpHref;
          actions.appendChild(fpLink);
        }

        row.append(fileIcon, link, size, actions);
        li.appendChild(row);
        ul.appendChild(li);
      });
      flatRootEl.appendChild(ul);
    }

    // Toggle view handler
    function setView(mode) {
      if (mode === 'tree') {
        treeBtn.classList.add('ae-sum-toggle--active');
        flatBtn.classList.remove('ae-sum-toggle--active');
        treeRootEl.hidden = false;
        flatRootEl.hidden = true;
        renderTree(searchInput.value);
        try { localStorage.setItem('ae-sum-view-mode', 'tree'); } catch (e) {}
      } else {
        flatBtn.classList.add('ae-sum-toggle--active');
        treeBtn.classList.remove('ae-sum-toggle--active');
        treeRootEl.hidden = true;
        flatRootEl.hidden = false;
        renderFlat(searchInput.value);
        try { localStorage.setItem('ae-sum-view-mode', 'flat'); } catch (e) {}
      }
      table.style.display = 'none';
    }

    treeBtn.addEventListener('click', () => setView('tree'));
    flatBtn.addEventListener('click', () => setView('flat'));

    function applyFilter() {
      if (!treeRootEl.hidden) {
        renderTree(searchInput.value);
      } else {
        renderFlat(searchInput.value);
      }
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(applyFilter, 80);
    });

    // Insert wrapper right before the table
    table.parentNode.insertBefore(wrapper, table);

    // Respect saved preference (default to tree)
    const saved = (function () {
      try { return localStorage.getItem('ae-sum-view-mode'); } catch (e) { return null; }
    })();
    setView(saved === 'flat' ? 'flat' : 'tree');
    } catch (err) {
      console.warn('Artifact Explorer: could not enhance fileList table', err);
    }
  }

  function enhanceFingerprintPage() {
    try {
      const mainPanel = document.getElementById('main-panel');
      if (!mainPanel) return;
      const md5El = mainPanel.querySelector('.md5sum');
      const fpTable = mainPanel.querySelector('table.fingerprint-summary');
      if (!md5El && !fpTable) return;
      if (mainPanel.dataset.aeFpEnhanced === 'true') return;
      mainPanel.dataset.aeFpEnhanced = 'true';

    const h1 = mainPanel.querySelector('h1');
    const fileName = h1 ? h1.textContent.trim() : 'Artifact Fingerprint';

    // Extract MD5
    let md5Hash = '';
    if (md5El) {
      const match = md5El.textContent.match(/([a-fA-F0-9]{32})/);
      if (match) md5Hash = match[1];
    }

    // Extract Introduced info & origin build link
    let introducedHtml = '';
    let originBuildHref = '';
    const introDiv = md5El ? md5El.nextElementSibling : null;
    if (introDiv) {
      const originLink = introDiv.querySelector('a');
      if (originLink) {
        originBuildHref = originLink.getAttribute('href') || '';
      }
      introducedHtml = introDiv.innerHTML;
    }

    // Extract usage entries from table
    const usages = [];
    if (fpTable) {
      fpTable.querySelectorAll('tr').forEach((tr) => {
        const jobHeader = tr.querySelector('.fingerprint-summary-header');
        const jobLink = jobHeader ? jobHeader.querySelector('a') : null;
        const jobName = jobLink ? jobLink.textContent.trim() : (jobHeader ? jobHeader.textContent.trim() : '');
        const jobHref = jobLink ? jobLink.getAttribute('href') : '';

        const buildCells = Array.from(tr.querySelectorAll('td')).filter(
          (td) => !td.classList.contains('fingerprint-summary-header')
        );
        const builds = [];
        buildCells.forEach((cell) => {
          cell.querySelectorAll('a').forEach((a) => {
            builds.push({
              name: a.textContent.trim(),
              href: a.getAttribute('href')
            });
          });
        });
        if (jobName) {
          usages.push({ jobName, jobHref, builds });
        }
      });
    }

    // Hide original raw elements cleanly
    if (h1) h1.style.display = 'none';
    if (md5El) md5El.style.display = 'none';
    if (introDiv) introDiv.style.display = 'none';
    const h2 = mainPanel.querySelector('h2');
    if (h2) h2.style.display = 'none';
    const introP = mainPanel.querySelector('p');
    if (introP) introP.style.display = 'none';
    if (fpTable) fpTable.style.display = 'none';

    // Create modern container
    const fpRoot = el('div', 'ae-fp-container');

    // 1. Hero Card
    const heroCard = el('div', 'ae-fp-card ae-fp-hero');
    const heroHeader = el('div', 'ae-fp-hero-header');
    const iconWrap = el('div', 'ae-fp-icon-wrap');
    iconWrap.appendChild(svgIcon('package'));

    const titleGroup = el('div', 'ae-fp-title-group');
    const title = el('h1', 'ae-fp-title', fileName);
    const subtitle = el('div', 'ae-fp-subtitle', 'Artifact Fingerprint & Provenance');
    titleGroup.append(title, subtitle);
    heroHeader.append(iconWrap, titleGroup);

    // Hash Pill
    const hashRow = el('div', 'ae-fp-hash-row');
    const hashLabel = el('span', 'ae-fp-hash-label', 'MD5 CHECKSUM');
    const hashVal = el('code', 'ae-fp-hash-code', md5Hash || 'N/A');
    const copyBtn = el('button', 'ae-fp-btn', ' Copy');
    copyBtn.type = 'button';
    copyBtn.prepend(svgIcon('copy'));
    copyBtn.addEventListener('click', async () => {
      if (!md5Hash) return;
      const success = await copyTextToClipboard(md5Hash);
      if (success) {
        copyBtn.textContent = ' Copied!';
        copyBtn.prepend(svgIcon('check'));
        notify('MD5 checksum copied to clipboard');
        setTimeout(() => {
          copyBtn.textContent = ' Copy';
          copyBtn.prepend(svgIcon('copy'));
        }, 2000);
      } else {
        notify('Could not copy to clipboard', true);
      }
    });
    hashRow.append(hashLabel, hashVal, copyBtn);

    // Meta details
    const metaDetails = el('div', 'ae-fp-meta-details');
    if (originBuildHref) {
      const introSpan = el('div', 'ae-fp-meta-item');
      introSpan.innerHTML = introducedHtml;
      metaDetails.appendChild(introSpan);
    }

    // Hero Action Buttons
    const heroActions = el('div', 'ae-fp-actions');
    if (originBuildHref) {
      const explorerBtn = el('a', 'jenkins-button jenkins-button--primary ae-fp-action-btn', 'View in Artifact Explorer');
      explorerBtn.href = originBuildHref.endsWith('/') ? originBuildHref + 'artifact/' : originBuildHref + '/artifact/';
      explorerBtn.appendChild(svgIcon('external'));
      heroActions.appendChild(explorerBtn);
    }

    heroCard.append(heroHeader, hashRow, metaDetails, heroActions);

    // 2. Usage Table Card
    const usageCard = el('div', 'ae-fp-card ae-fp-usage-card');
    const usageHeader = el('div', 'ae-fp-card-header');
    const usageTitle = el('h2', 'ae-fp-card-title', 'Usage History & Lineage');
    const usageDesc = el('p', 'ae-fp-card-desc', 'All pipelines and builds recorded using or producing this artifact:');
    usageHeader.append(usageTitle, usageDesc);

    const tableWrap = el('div', 'ae-fp-table-wrap');
    const modernTable = el('table', 'ae-fp-table');
    const thead = el('thead');
    thead.innerHTML = '<tr><th>Pipeline / Job</th><th>Build</th><th>Action</th></tr>';
    modernTable.appendChild(thead);

    const tbody = el('tbody');
    if (usages.length === 0) {
      const emptyRow = el('tr');
      emptyRow.innerHTML = '<td colspan="3" class="ae-fp-empty">No usage records found.</td>';
      tbody.appendChild(emptyRow);
    } else {
      usages.forEach((u) => {
        u.builds.forEach((b) => {
          const tr = el('tr');
          const tdJob = el('td', 'ae-fp-cell-job');
          const jobLink = el('a', 'ae-fp-link', u.jobName);
          jobLink.href = u.jobHref;
          tdJob.appendChild(jobLink);

          const tdBuild = el('td', 'ae-fp-cell-build');
          const bLink = el('a', 'ae-fp-build-badge', b.name);
          bLink.href = b.href;
          tdBuild.appendChild(bLink);

          const tdAction = el('td', 'ae-fp-cell-action');
          const expLink = el('a', 'ae-fp-btn-link', 'Artifact Explorer ');
          expLink.appendChild(svgIcon('external'));
          expLink.href = b.href.endsWith('/') ? b.href + 'artifact/' : b.href + '/artifact/';
          tdAction.appendChild(expLink);

          tr.append(tdJob, tdBuild, tdAction);
          tbody.appendChild(tr);
        });
      });
    }
    modernTable.appendChild(tbody);
    tableWrap.appendChild(modernTable);
    usageCard.append(usageHeader, tableWrap);

    fpRoot.append(heroCard, usageCard);
    mainPanel.prepend(fpRoot);
    } catch (err) {
      console.warn('Artifact Explorer: could not enhance fingerprint page', err);
    }
  }

  function init() {
    document.querySelectorAll('table.fileList').forEach(enhanceFileListTable);
    enhanceFingerprintPage();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Also support dynamic/AJAX page updates
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches('table.fileList')) {
            enhanceFileListTable(node);
          } else if (node.querySelectorAll) {
            node.querySelectorAll('table.fileList').forEach(enhanceFileListTable);
          }
          if (node.matches && (node.matches('.md5sum') || node.matches('table.fingerprint-summary'))) {
            enhanceFingerprintPage();
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
