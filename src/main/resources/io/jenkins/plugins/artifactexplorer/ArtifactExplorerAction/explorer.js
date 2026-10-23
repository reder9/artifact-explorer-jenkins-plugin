/*
 * Artifact Explorer: searchable, lazily loaded tree of a build's archived artifacts.
 * Plain browser JavaScript, no build step and no inline styles (Jenkins CSP friendly).
 */
(function () {
  'use strict';

  // Preserve deep-link hashes containing '/' or '.' while Jenkins's deferred app.js
  // runs dialogs_init(), which otherwise calls querySelector('.dialog-' + hash + '-hash').
  const initialHash = window.location.hash;
  if (initialHash && /[/.]/.test(initialHash)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function init() {
    if (initialHash && !window.location.hash) {
      history.replaceState(null, '', initialHash);
    }
    const root = document.getElementById('artifact-explorer');
    if (!root) {
      return;
    }

    const buildUrl = root.dataset.buildUrl;
    const basePath = root.dataset.initialPath || '';
    const MAX_SEARCH_RESULTS = 500;
    const EXPAND_ALL_BUDGET = 5000;
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|ico|bmp)$/i;

    const label = (key, fallback) => root.dataset['label' + key] || fallback || key;

    // ---------------------------------------------------------------- helpers

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) {
        node.className = className;
      }
      if (text !== undefined) {
        node.textContent = text;
      }
      return node;
    }

    function escapeHtml(str) {
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function inlineMarkdown(text) {
      return text
        .replace(/`([^`]+)`/g, '<code class="ae-md-inline-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        .replace(/_([^_]+)_/g, '<em>$1</em>')
        .replace(/~~([^~]+)~~/g, '<del>$1</del>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkLabel, url) => {
          const cleanUrl = url.trim();
          if (/^(https?:|mailto:|\/|\.\/|#)/i.test(cleanUrl)) {
            return `<a href="${cleanUrl}" target="_blank" rel="noopener" class="ae-md-link">${linkLabel}</a>`;
          }
          return linkLabel;
        });
    }

    function renderMarkdown(md) {
      let raw = escapeHtml(md || '');

      // Protect code blocks
      const codeBlocks = [];
      raw = raw.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        codeBlocks.push('<pre class="ae-md-pre"><code class="ae-md-code">' + code + '</code></pre>');
        return '%%CODEBLOCK_' + idx + '%%';
      });

      // Tables
      raw = raw.replace(/(?:^|\n)(\|.+?\|\n\|[-:| ]+?\|\n(?:\|.+?\|\n?)+)/g, (match, tableText) => {
        const lines = tableText.trim().split('\n').filter(Boolean);
        if (lines.length < 2) return match;
        const headers = lines[0].split('|').slice(1, -1).map((h) => h.trim());
        const aligns = lines[1].split('|').slice(1, -1).map((a) => {
          a = a.trim();
          if (a.startsWith(':') && a.endsWith(':')) return 'center';
          if (a.endsWith(':')) return 'right';
          return 'left';
        });
        let html = '<div class="ae-md-table-wrap"><table class="ae-md-table"><thead><tr>';
        headers.forEach((h, i) => {
          const align = aligns[i] ? ` class="ae-align-${aligns[i]}"` : '';
          html += `<th${align}>${inlineMarkdown(h)}</th>`;
        });
        html += '</tr></thead><tbody>';
        for (let i = 2; i < lines.length; i++) {
          const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
          html += '<tr>';
          cells.forEach((c, idx) => {
            const align = aligns[idx] ? ` class="ae-align-${aligns[idx]}"` : '';
            html += `<td${align}>${inlineMarkdown(c)}</td>`;
          });
          html += '</tr>';
        }
        html += '</tbody></table></div>';
        return '\n' + html + '\n';
      });

      // Blockquotes
      raw = raw.replace(/(?:^|\n)((?:&gt;[^\n]*\n?)+)/g, (_, block) => {
        const text = block.split('\n').map((l) => l.replace(/^&gt;\s?/, '')).join('\n');
        return '\n<blockquote class="ae-md-quote">' + renderMarkdown(text) + '</blockquote>\n';
      });

      // Lists & Task lists
      raw = raw.replace(/(?:^|\n)((?:[ \t]*(?:[-*+]|\d+\.)[ \t]+[^\n]*\n?)+)/g, (_, listBlock) => {
        const lines = listBlock.split('\n').filter(Boolean);
        const isOrdered = /^[ \t]*\d+\./.test(lines[0]);
        const tag = isOrdered ? 'ol' : 'ul';
        let html = `<${tag} class="ae-md-list">`;
        lines.forEach((line) => {
          let content = line.replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/, '');
          let taskCheck = '';
          if (/^\[ \]\s/.test(content)) {
            taskCheck = '<input type="checkbox" disabled class="ae-md-task"> ';
            content = content.substring(4);
          } else if (/^\[x\]\s/i.test(content)) {
            taskCheck = '<input type="checkbox" checked disabled class="ae-md-task"> ';
            content = content.substring(4);
          }
          html += `<li>${taskCheck}${inlineMarkdown(content)}</li>`;
        });
        html += `</${tag}>`;
        return '\n' + html + '\n';
      });

      // Headers
      raw = raw.replace(/^######\s+(.+)$/gm, '<h6 class="ae-md-h">$1</h6>')
               .replace(/^#####\s+(.+)$/gm, '<h5 class="ae-md-h">$1</h5>')
               .replace(/^####\s+(.+)$/gm, '<h4 class="ae-md-h">$1</h4>')
               .replace(/^###\s+(.+)$/gm, '<h3 class="ae-md-h">$1</h3>')
               .replace(/^##\s+(.+)$/gm, '<h2 class="ae-md-h">$1</h2>')
               .replace(/^#\s+(.+)$/gm, '<h1 class="ae-md-h">$1</h1>');

      // Horizontal rules
      raw = raw.replace(/^(?:---|\*\*\*|___)\s*$/gm, '<hr class="ae-md-hr"/>');

      // Paragraphs
      const paragraphs = raw.split(/\n\s*\n/).map((p) => {
        p = p.trim();
        if (!p) return '';
        if (/^<(h[1-6]|pre|div|table|blockquote|ul|ol|hr)/i.test(p) || p.startsWith('%%CODEBLOCK_')) {
          return p;
        }
        return '<p class="ae-md-p">' + inlineMarkdown(p.replace(/\n/g, '<br/>')) + '</p>';
      });

      let out = paragraphs.filter(Boolean).join('\n');
      out = out.replace(/%%CODEBLOCK_(\d+)%%/g, (_, idx) => codeBlocks[Number(idx)]);
      return out;
    }

    function parseCsvRow(rowStr, delimiter) {
      const res = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < rowStr.length; i++) {
        const ch = rowStr[i];
        if (ch === '"') {
          if (inQuotes && rowStr[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === delimiter && !inQuotes) {
          res.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      res.push(current);
      return res;
    }

    function renderCsv(csvText, delimiter = ',') {
      const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length === 0) return '<div class="ae-empty">Empty data</div>';
      let html = '<div class="ae-md-table-wrap"><table class="ae-md-table ae-csv-table"><thead><tr>';
      const headers = parseCsvRow(lines[0], delimiter);
      headers.forEach((h) => {
        html += `<th>${escapeHtml(h)}</th>`;
      });
      html += '</tr></thead><tbody>';
      for (let i = 1; i < lines.length; i++) {
        const row = parseCsvRow(lines[i], delimiter);
        html += '<tr>';
        row.forEach((c) => {
          html += `<td>${escapeHtml(c)}</td>`;
        });
        html += '</tr>';
      }
      html += '</tbody></table></div>';
      return html;
    }

    function highlightJson(jsonStr) {
      return jsonStr.replace(
        /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[&<>]/g,
        (match, str, isKey, boolOrNull) => {
          if (str) {
            if (isKey) {
              return '<span class="ae-tok-key">' + escapeHtml(str) + '</span>' + escapeHtml(isKey);
            }
            return '<span class="ae-tok-str">' + escapeHtml(str) + '</span>';
          }
          if (boolOrNull) {
            const cls = boolOrNull === 'null' ? 'ae-tok-null' : 'ae-tok-bool';
            return '<span class="' + cls + '">' + boolOrNull + '</span>';
          }
          if (match === '&' || match === '<' || match === '>') {
            return escapeHtml(match);
          }
          return '<span class="ae-tok-num">' + match + '</span>';
        }
      );
    }

    function highlightVal(valStr) {
      return valStr.replace(
        /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"|'[^']*')|\b(true|false|yes|no|on|off|null|None|nil)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[&<>]/gi,
        (match, str, boolOrNull) => {
          if (str) {
            return '<span class="ae-tok-str">' + escapeHtml(str) + '</span>';
          }
          if (boolOrNull) {
            const lower = boolOrNull.toLowerCase();
            const cls = (lower === 'null' || lower === 'none' || lower === 'nil') ? 'ae-tok-null' : 'ae-tok-bool';
            return '<span class="' + cls + '">' + escapeHtml(boolOrNull) + '</span>';
          }
          if (match === '&' || match === '<' || match === '>') {
            return escapeHtml(match);
          }
          return '<span class="ae-tok-num">' + match + '</span>';
        }
      );
    }

    function highlightConfig(text) {
      const lines = text.split('\n');
      return lines.map((line) => {
        let comment = '';
        const hashIdx = line.indexOf('#');
        let codePart = line;
        if (hashIdx !== -1) {
          const before = line.substring(0, hashIdx);
          const singleQuotes = (before.match(/'/g) || []).length;
          const doubleQuotes = (before.match(/"/g) || []).length;
          if (singleQuotes % 2 === 0 && doubleQuotes % 2 === 0) {
            codePart = before;
            comment = line.substring(hashIdx);
          }
        }

        const keyValMatch = codePart.match(/^(\s*)([a-zA-Z0-9_\-\.]+)(\s*[:=]\s*)(.*)$/);
        let formatted = '';
        if (keyValMatch) {
          const [, indent, key, delim, val] = keyValMatch;
          formatted = escapeHtml(indent) +
            '<span class="ae-tok-key">' + escapeHtml(key) + '</span>' +
            escapeHtml(delim) +
            highlightVal(val);
        } else {
          const listMatch = codePart.match(/^(\s*-\s+)(.*)$/);
          if (listMatch) {
            formatted = escapeHtml(listMatch[1]) + highlightVal(listMatch[2]);
          } else {
            formatted = escapeHtml(codePart);
          }
        }

        if (comment) {
          formatted += '<span class="ae-tok-comment">' + escapeHtml(comment) + '</span>';
        }
        return formatted;
      }).join('\n');
    }

    function highlightXml(xmlStr) {
      const escaped = escapeHtml(xmlStr);
      return escaped.replace(
        /(&lt;!--[\s\S]*?--&gt;)|(&lt;\/?)([a-zA-Z0-9_\-:]+)((?:\s+[a-zA-Z0-9_\-:]+(?:=&quot;[^&]*&quot;)?)*\s*)(\/?&gt;)/g,
        (match, comment, openTag, tagName, attrs, closeTag) => {
          if (comment) {
            return '<span class="ae-tok-comment">' + comment + '</span>';
          }
          const formattedAttrs = attrs.replace(
            /([a-zA-Z0-9_\-:]+)(=)(&quot;[^&]*&quot;)/g,
            '<span class="ae-tok-key">$1</span>$2<span class="ae-tok-str">$3</span>'
          );
          return openTag + '<span class="ae-tok-bool">' + tagName + '</span>' + formattedAttrs + closeTag;
        }
      );
    }

    function colorizeCode(rawText, path) {
      if (/\.json$/i.test(path)) {
        return highlightJson(rawText);
      }
      if (/\.(ya?ml|properties|env|ini|conf|sh|bash)$/i.test(path)) {
        return highlightConfig(rawText);
      }
      if (/\.(xml|pom|svg|html|htm|jelly)$/i.test(path)) {
        return highlightXml(rawText);
      }
      return escapeHtml(rawText);
    }

    const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
    const fileUrl = (p) => buildUrl + 'artifact/' + encodePath(p);
    const viewUrl = (p) => fileUrl(p) + '/*view*/';
    const dirUrl = (p) => (p === '' ? buildUrl + 'artifact/' : fileUrl(p) + '/');
    const baseName = (p) => p.substring(p.lastIndexOf('/') + 1);
    const absolute = (url) => new URL(url, window.location.href).href;

    function formatSize(bytes) {
      if (bytes < 1024) {
        return bytes + ' B';
      }
      const units = ['KB', 'MB', 'GB', 'TB'];
      let value = bytes / 1024;
      let i = 0;
      while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
      }
      return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[i];
    }

    function formatDate(ms) {
      return ms > 0 ? new Date(ms).toLocaleString() : '';
    }

    async function api(endpoint, params) {
      const query = params ? '?' + new URLSearchParams(params).toString() : '';
      const response = await fetch(buildUrl + 'artifact-explorer/' + endpoint + query, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const body = await response.json();
      if (body.status !== 'ok') {
        throw new Error(body.message || 'error');
      }
      return body.data;
    }

    function svgIcon(kind) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      // The "external" glyph is the ionicons "open" icon (512 unit grid), same as Jenkins' own external.svg
      svg.setAttribute('viewBox', kind === 'external' ? '0 0 512 512' : '0 0 16 16');
      svg.setAttribute('class', 'ae-icon ae-icon--' + kind);
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(ns, 'path');
      const shapes = {
        folder: 'M1.5 3A1.5 1.5 0 0 1 3 1.5h3l1.5 1.5H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z',
        file: 'M3.5 1.5h6l3 3v10h-9zM9 1.5v3.5h3.5',
        caret: 'M6 3.5l4.5 4.5L6 12.5',
        download: 'M8 2v8m0 0L5 7m3 3l3-3M3 13h10',
        link: 'M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8',
        reveal: 'M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
        preview: 'M2.5 3.5h11v9h-11zM5 6.5h6M5 9.5h4',
        close: 'M4 4l8 8M12 4l-8 8',
        external: 'M384 224v184a40 40 0 01-40 40H104a40 40 0 01-40-40V168a40 40 0 0140-40h167.48M336 64h112v112M224 288L440 72',
        copy: 'M5 4h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm-2 8V3a1 1 0 0 1 1-1h7',
        check: 'M3.5 8.5l3 3 6-7',
        shield: 'M8 1.5l5.5 2.5v4c0 3.8-2.6 6.8-5.5 7.5-2.9-.7-5.5-3.7-5.5-7.5v-4L8 1.5z',
      };
      path.setAttribute('d', shapes[kind] || shapes.file);
      if (kind === 'external') {
        path.setAttribute('stroke-width', '32');
      }
      svg.appendChild(path);
      return svg;
    }

    function iconButton(kind, title, onClick) {
      const button = el('button', 'ae-iconbutton');
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.appendChild(svgIcon(kind));
      button.addEventListener('click', onClick);
      return button;
    }

    function iconLink(kind, title, href, download) {
      const link = el('a', 'ae-iconbutton');
      link.href = href;
      link.title = title;
      link.setAttribute('aria-label', title);
      if (download) {
        link.setAttribute('download', '');
      }
      link.appendChild(svgIcon(kind));
      return link;
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

    function copyLinkButton(urlOrGetter, customToastMsg) {
      const defaultLabel = label('CopyLink', 'Copy link');
      const button = iconButton('link', defaultLabel, async () => {
        const raw = typeof urlOrGetter === 'function' ? urlOrGetter() : urlOrGetter;
        if (!raw) return;
        const urlToCopy = absolute(raw);
        const success = await copyTextToClipboard(urlToCopy);
        if (success) {
          const doneLabel = label('Copied', 'Copied!');
          button.title = doneLabel;
          button.setAttribute('aria-label', doneLabel);
          button.replaceChildren(svgIcon('check'));
          button.classList.add('ae-iconbutton--done');
          notify(customToastMsg || label('ToastLinkCopied', 'Link copied to clipboard'));
          window.setTimeout(() => {
            button.title = defaultLabel;
            button.setAttribute('aria-label', defaultLabel);
            button.replaceChildren(svgIcon('link'));
            button.classList.remove('ae-iconbutton--done');
          }, 1500);
        } else {
          notify(label('CopyFailed', 'Could not copy to clipboard'), true);
        }
      });
      return button;
    }

    function copyContentButton(getTextFn) {
      const defaultLabel = label('CopyContents', 'Copy file contents');
      const button = iconButton('copy', defaultLabel, async () => {
        const text = typeof getTextFn === 'function' ? getTextFn() : getTextFn;
        if (!text) {
          return;
        }
        const success = await copyTextToClipboard(text);
        if (success) {
          const doneLabel = label('Copied', 'Copied!');
          button.title = doneLabel;
          button.setAttribute('aria-label', doneLabel);
          button.replaceChildren(svgIcon('check'));
          button.classList.add('ae-iconbutton--done');
          notify(label('ToastContentsCopied', 'File contents copied to clipboard'));
          window.setTimeout(() => {
            button.title = defaultLabel;
            button.setAttribute('aria-label', defaultLabel);
            button.replaceChildren(svgIcon('copy'));
            button.classList.remove('ae-iconbutton--done');
          }, 1500);
        } else {
          notify(label('CopyFailed', 'Could not copy to clipboard'), true);
        }
      });
      return button;
    }

    // ------------------------------------------------------------------ layout

    const searchInput = document.getElementById('ae-searchinput');
    const expandAllButton = document.getElementById('ae-expandall');
    const collapseAllButton = document.getElementById('ae-collapseall');
    const zipLink = document.getElementById('ae-ziplink');
    const helpButton = document.getElementById('ae-helpbtn');
    const pillsBar = document.getElementById('ae-pills-bar');
    const breadcrumb = document.getElementById('ae-breadcrumb');
    const status = document.getElementById('ae-status');
    const workspace = document.getElementById('ae-workspace');
    const listColumn = document.getElementById('ae-main');
    const treeContainer = document.getElementById('ae-tree');
    const resultsContainer = document.getElementById('ae-results');
    const previewPane = document.getElementById('ae-preview');

    zipLink.href = (basePath === '' ? fileUrl('') : fileUrl(basePath) + '/') + '*zip*/' +
      (basePath === '' ? 'archive' : baseName(basePath)) + '.zip';

    (function buildBreadcrumb() {
      if (basePath === '') {
        breadcrumb.hidden = true;
        return;
      }
      breadcrumb.hidden = false;
      const rootLink = el('a', 'ae-breadcrumb-link', label('ArtifactsRoot', 'Artifacts'));
      rootLink.href = dirUrl('');
      breadcrumb.append(svgIcon('folder'), rootLink);
      let accumulated = '';
      basePath.split('/').filter(Boolean).forEach((segment) => {
        accumulated = accumulated === '' ? segment : accumulated + '/' + segment;
        breadcrumb.appendChild(el('span', 'ae-sep', '/'));
        const link = el('a', 'ae-breadcrumb-link', segment);
        link.href = dirUrl(accumulated);
        breadcrumb.appendChild(link);
      });
    })();

    // -------------------------------------------------------- shortcuts dialog

    function getOpenDialog() {
      return document.querySelector('dialog.jenkins-dialog[open]');
    }

    function isModalOpen() {
      return Boolean(getOpenDialog());
    }

    function toggleShortcutsModal() {
      const openDialog = getOpenDialog();
      if (openDialog) {
        openDialog.dispatchEvent(new Event('cancel'));
      } else if (helpButton) {
        helpButton.click();
      }
    }

    // ----------------------------------------------------------------- preview

    let activePreview = null;
    let activePreviewPath = null;
    let previewSequence = 0;
    let checksumManifestCache = null;

    async function fetchAndParseChecksumManifests() {
      if (checksumManifestCache !== null) {
        return checksumManifestCache;
      }
      const manifests = [];
      try {
        const files = await loadIndex();
        if (Array.isArray(files)) {
          files.forEach((f) => {
            if (/\.(sha256|sha512|md5)$/i.test(f) || /(^|\/)checksums\.[a-z0-9]+$/i.test(f)) {
              manifests.push(f);
            }
          });
        }
      } catch (e) {
        // ignore
      }

      const entries = [];
      for (const mPath of manifests) {
        try {
          const data = await api('preview', { path: mPath });
          if (data && !data.binary && typeof data.text === 'string') {
            const lines = data.text.split(/\r?\n/);
            lines.forEach((line) => {
              const match = line.trim().match(/^([a-f0-9]{32,128})\s+[\*]?(.*)$/i);
              if (match) {
                entries.push({
                  hash: match[1].toLowerCase(),
                  file: match[2].trim(),
                  manifestPath: mPath
                });
              }
            });
          }
        } catch (err) {
          // ignore
        }
      }
      checksumManifestCache = entries;
      return entries;
    }

    function closePreview() {
      activePreview = null;
      activePreviewPath = null;
      previewPane.hidden = true;
      previewPane.replaceChildren();
      workspace.classList.remove('ae-workspace--split');
      root.querySelectorAll('.ae-row--selected').forEach((r) => r.classList.remove('ae-row--selected'));
      if (window.location.hash) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }

    function highlightRowForPath(path) {
      root.querySelectorAll('.ae-row--selected').forEach((r) => r.classList.remove('ae-row--selected'));
      const node = nodesByPath.get(path);
      if (node && node.li.firstElementChild) {
        node.li.firstElementChild.classList.add('ae-row--selected');
      }
    }

    async function openPreview(path) {
      const seq = ++previewSequence;
      activePreviewPath = path;
      highlightRowForPath(path);
      workspace.classList.add('ae-workspace--split');
      previewPane.hidden = false;
      previewPane.replaceChildren();

      const relPath = (basePath && path.startsWith(basePath + '/')) ? path.substring(basePath.length + 1) : path;
      const targetHash = '#' + encodePath(relPath);
      if (window.location.hash !== targetHash) {
        history.replaceState(null, '', targetHash);
      }

      const isMd = /\.(md|markdown)$/i.test(path);
      const isHtml = /\.(html|htm)$/i.test(path);
      const isSvg = /\.svg$/i.test(path);
      const isCsv = /\.(csv|tsv)$/i.test(path);
      const isRenderable = isMd || isHtml || isSvg || isCsv;

      const header = el('div', 'ae-preview-header');
      const titleWrap = el('div', 'ae-preview-title');
      titleWrap.append(svgIcon('file'), el('span', 'ae-preview-name', baseName(path)));

      let previewBtn = null;
      let codeBtn = null;
      if (isRenderable) {
        const modeGroup = el('div', 'ae-preview-mode-group');
        previewBtn = el('button', 'ae-preview-toggle ae-preview-toggle--active', 'Preview');
        previewBtn.type = 'button';
        codeBtn = el('button', 'ae-preview-toggle', 'Code');
        codeBtn.type = 'button';
        modeGroup.append(previewBtn, codeBtn);
        titleWrap.appendChild(modeGroup);
      }

      const headerActions = el('div', 'ae-preview-actions');
      const rawLink = el('a', 'jenkins-button ae-btn-sm', label('Raw'));
      rawLink.href = fileUrl(path);
      rawLink.target = '_blank';
      rawLink.rel = 'noopener noreferrer';
      const dlLink = el('a', 'jenkins-button ae-btn-sm', label('Download'));
      dlLink.href = fileUrl(path);
      dlLink.setAttribute('download', '');

      const checksumBtn = iconButton('shield', (label('ComputeChecksum') || 'Compute SHA-256') + ' (s)', () => runChecksumComputation());

      const openInNewTab = iconLink('external', label('OpenInNewTab') || 'Open in new tab', viewUrl(path), false);
      openInNewTab.target = '_blank';
      openInNewTab.rel = 'noopener noreferrer';

      let currentPreviewText = '';
      const copyContentBtn = copyContentButton(() => currentPreviewText);
      copyContentBtn.hidden = true;

      const copyLinkBtn = copyLinkButton(() => window.location.href, label('ToastDeepLinkCopied', 'Shareable deep link copied to clipboard'));
      const closeBtn = iconButton('close', label('Close'), closePreview);
      headerActions.append(rawLink, dlLink, checksumBtn, openInNewTab, copyContentBtn, copyLinkBtn, closeBtn);
      header.append(titleWrap, headerActions);

      const meta = el('div', 'ae-preview-meta', path);
      const checksumBar = el('div', 'ae-checksum-bar');
      checksumBar.hidden = true;
      const body = el('div', 'ae-preview-body');
      body.textContent = label('Loading');
      previewPane.append(header, meta, checksumBar, body);

      let calculatedHash = null;
      let isComputing = false;

      async function runChecksumComputation() {
        if (isComputing) {
          return;
        }
        checksumBar.hidden = false;
        if (calculatedHash) {
          checksumBar.classList.add('ae-checksum-bar--flash');
          setTimeout(() => checksumBar.classList.remove('ae-checksum-bar--flash'), 600);
          return;
        }
        isComputing = true;
        checksumBtn.classList.add('ae-iconbutton--loading');
        checksumBar.replaceChildren();
        const loadingSpan = el('span', 'ae-checksum-loading', label('ComputingChecksum') || 'Computing SHA-256...');
        checksumBar.appendChild(loadingSpan);

        try {
          const hashData = await api('sha256', { path });
          if (seq !== previewSequence) {
            return;
          }
          calculatedHash = hashData.sha256;

          const manifests = await fetchAndParseChecksumManifests();
          if (seq !== previewSequence) {
            return;
          }

          let matchEntry = null;
          let mismatchEntry = null;

          for (const entry of manifests) {
            const fileMatches = (
              entry.file === path ||
              path.endsWith('/' + entry.file) ||
              entry.file === baseName(path)
            );
            if (fileMatches) {
              if (entry.hash.toLowerCase() === calculatedHash.toLowerCase()) {
                matchEntry = entry;
                break;
              } else {
                mismatchEntry = entry;
              }
            }
          }

          if (!matchEntry && !mismatchEntry) {
            matchEntry = manifests.find((e) => e.hash.toLowerCase() === calculatedHash.toLowerCase());
          }

          checksumBar.replaceChildren();

          let badge;
          if (matchEntry) {
            badge = el('span', 'ae-checksum-badge ae-checksum-badge--verified');
            badge.append(svgIcon('shield'), el('span', '', 'Verified Match (' + baseName(matchEntry.manifestPath) + ')'));
            badge.title = matchEntry.manifestPath;
          } else if (mismatchEntry) {
            badge = el('span', 'ae-checksum-badge ae-checksum-badge--mismatch');
            badge.append(svgIcon('shield'), el('span', '', 'Checksum Mismatch!'));
            badge.title = 'Expected: ' + mismatchEntry.hash + ' in ' + mismatchEntry.manifestPath;
          } else {
            badge = el('span', 'ae-checksum-badge');
            badge.append(svgIcon('shield'), el('span', '', 'SHA-256'));
          }

          const code = el('code', 'ae-checksum-code', calculatedHash);
          code.title = calculatedHash;

          const copyBtn = iconButton('copy', label('CopyHash', 'Copy hash'), async () => {
            const success = await copyTextToClipboard(calculatedHash);
            if (success) {
              const doneLabel = label('Copied', 'Copied!');
              copyBtn.title = doneLabel;
              copyBtn.setAttribute('aria-label', doneLabel);
              copyBtn.replaceChildren(svgIcon('check'));
              copyBtn.classList.add('ae-iconbutton--done');
              notify(label('ToastHashCopied', 'SHA-256 hash copied to clipboard'));
              setTimeout(() => {
                copyBtn.title = label('CopyHash', 'Copy hash');
                copyBtn.setAttribute('aria-label', label('CopyHash', 'Copy hash'));
                copyBtn.replaceChildren(svgIcon('copy'));
                copyBtn.classList.remove('ae-iconbutton--done');
              }, 1500);
            } else {
              notify(label('CopyFailed', 'Could not copy to clipboard'), true);
            }
          });

          checksumBar.append(badge, code, copyBtn);
        } catch (err) {
          if (seq === previewSequence) {
            checksumBar.replaceChildren();
            checksumBar.appendChild(el('span', 'ae-status--error', 'Failed to compute SHA-256 (' + err.message + ')'));
          }
        } finally {
          isComputing = false;
          checksumBtn.classList.remove('ae-iconbutton--loading');
        }
      }

      activePreview = {
        path,
        sequence: seq,
        copyContent: () => copyContentBtn.click(),
        copyLink: () => copyLinkBtn.click(),
        download: () => dlLink.click(),
        computeChecksum: () => runChecksumComputation(),
      };

      if (IMAGE_EXT.test(path)) {
        body.replaceChildren();
        const figure = el('div', 'ae-preview-image-wrap');
        const img = el('img', 'ae-preview-image');
        img.src = fileUrl(path);
        img.alt = baseName(path);
        figure.appendChild(img);
        body.appendChild(figure);
      }

      try {
        const data = await api('preview', { path });
        if (seq !== previewSequence) {
          return;
        }
        const metaParts = [data.path, formatSize(data.size)];
        if (data.lastModified > 0) {
          metaParts.push(formatDate(data.lastModified));
        }
        if (data.truncated) {
          metaParts.push(label('PreviewTruncated'));
        }
        meta.textContent = metaParts.join('  |  ');

        if (IMAGE_EXT.test(path)) {
          return;
        }
        body.replaceChildren();

        if (!data.binary && typeof data.text === 'string' && data.text.length > 0) {
          currentPreviewText = data.text;
          copyContentBtn.hidden = false;
        }

        if (isRenderable) {
          const renderedContainer = el('div', 'ae-preview-rendered');
          const codeContainer = el('div', 'ae-preview-code-wrap');
          codeContainer.hidden = true;

          const pre = el('pre', 'ae-preview-code');
          pre.innerHTML = colorizeCode(data.text || '', path);
          codeContainer.appendChild(pre);

          if (isMd) {
            renderedContainer.innerHTML = renderMarkdown(data.text || '');
          } else if (isHtml) {
            const frame = el('iframe', 'ae-preview-frame');
            frame.setAttribute('sandbox', 'allow-same-origin');
            frame.setAttribute('title', baseName(path));
            frame.src = fileUrl(path);
            renderedContainer.appendChild(frame);
          } else if (isSvg) {
            const figure = el('div', 'ae-preview-image-wrap');
            const img = el('img', 'ae-preview-image');
            img.src = fileUrl(path);
            img.alt = baseName(path);
            figure.appendChild(img);
            renderedContainer.appendChild(figure);
          } else if (isCsv) {
            renderedContainer.innerHTML = renderCsv(data.text || '', /\.tsv$/i.test(path) ? '\t' : ',');
          }

          body.append(renderedContainer, codeContainer);

          if (previewBtn && codeBtn) {
            previewBtn.addEventListener('click', () => {
              previewBtn.classList.add('ae-preview-toggle--active');
              codeBtn.classList.remove('ae-preview-toggle--active');
              renderedContainer.hidden = false;
              codeContainer.hidden = true;
            });
            codeBtn.addEventListener('click', () => {
              codeBtn.classList.add('ae-preview-toggle--active');
              previewBtn.classList.remove('ae-preview-toggle--active');
              renderedContainer.hidden = true;
              codeContainer.hidden = false;
            });
          }
          return;
        }

        if (data.binary) {
          body.appendChild(el('div', 'ae-empty', label('Binary') + ' (' + formatSize(data.size) + ')'));
          return;
        }
        const pre = el('pre', 'ae-preview-code');
        let text = data.text || '';
        if (/\.json$/i.test(path) && !data.truncated) {
          try {
            text = JSON.stringify(JSON.parse(text), null, 2);
            currentPreviewText = text;
          } catch (e) {
            // leave unformatted if invalid JSON
          }
        }
        pre.innerHTML = colorizeCode(text, path);
        body.appendChild(pre);
      } catch (e) {
        if (seq === previewSequence && !IMAGE_EXT.test(path)) {
          body.textContent = label('Error') + ' (' + e.message + ')';
        }
      }
    }

    // -------------------------------------------------------------------- tree

    const nodesByPath = new Map();

    function setStatus(message, isError) {
      status.textContent = message || '';
      status.classList.toggle('ae-status--error', Boolean(isError));
    }

    function createList(depth) {
      const list = el('ul', 'ae-list');
      list.setAttribute('role', depth === 0 ? 'tree' : 'group');
      return list;
    }

    async function loadChildren(node) {
      if (node.loaded || node.loading) {
        return node.loading;
      }
      node.loading = (async () => {
        node.li.classList.add('ae-node--loading');
        try {
          const data = await api('tree', { path: node.path });
          node.childrenList = createList(node.depth + 1);
          data.entries.forEach((entry) => node.childrenList.appendChild(renderNode(entry, node.depth + 1)));
          if (data.entries.length === 0) {
            node.childrenList.appendChild(el('li', 'ae-empty', label('Empty')));
          }
          if (data.truncated) {
            node.childrenList.appendChild(el('li', 'ae-empty', label('Truncated')));
          }
          node.li.appendChild(node.childrenList);
          node.loaded = true;
        } catch (e) {
          setStatus(label('Error') + ' (' + e.message + ')', true);
        } finally {
          node.li.classList.remove('ae-node--loading');
          node.loading = null;
        }
      })();
      return node.loading;
    }

    async function setExpanded(node, expanded) {
      if (expanded) {
        await loadChildren(node);
        if (!node.loaded) {
          return;
        }
      }
      node.expanded = expanded;
      node.li.setAttribute('aria-expanded', String(expanded));
      node.li.classList.toggle('ae-node--open', expanded);
      if (node.childrenList) {
        node.childrenList.hidden = !expanded;
      }
    }

    function renderNode(entry, depth) {
      const li = el('li', 'ae-node');
      li.style.setProperty('--depth', String(depth));
      li.dataset.path = entry.path;
      const node = { entry, path: entry.path, depth, li, loaded: false, expanded: false };
      nodesByPath.set(entry.path, node);

      const row = el('div', 'ae-row');
      row.tabIndex = 0;
      row.dataset.path = entry.path;

      if (entry.directory) {
        li.setAttribute('role', 'treeitem');
        li.setAttribute('aria-expanded', 'false');
        const toggle = iconButton('caret', entry.name, () => setExpanded(node, !node.expanded));
        toggle.classList.add('ae-toggle');
        row.appendChild(toggle);
        row.appendChild(svgIcon('folder'));
        const name = el('button', 'ae-name ae-name--dir', entry.name);
        name.type = 'button';
        name.addEventListener('click', () => setExpanded(node, !node.expanded));
        row.appendChild(name);
        row.appendChild(el('span', 'ae-size'));
        row.appendChild(el('span', 'ae-date'));
        const actions = el('span', 'ae-actions');
        actions.append(
          iconLink('download', label('DownloadFolderZip') || label('DownloadZip'), fileUrl(entry.path) + '/*zip*/' + encodeURIComponent(entry.name) + '.zip', false),
          copyLinkButton(dirUrl(entry.path), label('ToastFolderLinkCopied', 'Folder link copied to clipboard')));
        row.appendChild(actions);
      } else {
        li.setAttribute('role', 'treeitem');
        row.appendChild(el('span', 'ae-toggle ae-toggle--spacer'));
        row.appendChild(svgIcon('file'));
        const name = el('a', 'ae-name', entry.name);
        name.href = fileUrl(entry.path);
        name.addEventListener('click', (event) => {
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
            event.preventDefault();
            openPreview(entry.path);
          }
        });
        row.appendChild(name);
        row.appendChild(el('span', 'ae-size', formatSize(entry.size)));
        row.appendChild(el('span', 'ae-date', formatDate(entry.lastModified)));
        const actions = el('span', 'ae-actions');
        actions.append(
          iconButton('preview', label('Preview'), () => openPreview(entry.path)),
          iconLink('download', label('Download'), fileUrl(entry.path), true),
          copyLinkButton(fileUrl(entry.path), label('ToastLinkCopied', 'Link copied to clipboard')));
        row.appendChild(actions);
      }
      li.appendChild(row);
      return li;
    }

    const rootNode = {
      path: basePath,
      depth: -1,
      li: treeContainer,
      loaded: false,
      expanded: false,
    };

    async function initTree() {
      setStatus(label('Loading'));
      await loadChildren(rootNode);
      if (rootNode.loaded) {
        setStatus('');
        rootNode.childrenList.classList.add('ae-list--root');
        rootNode.childrenList.setAttribute('role', 'tree');
        initExtensionPills();
        await handleHashNavigation();
      }
    }

    async function expandAll() {
      let budget = EXPAND_ALL_BUDGET;
      async function walk(node) {
        if (budget <= 0) {
          return;
        }
        await setExpanded(node, true);
        if (!node.childrenList) {
          return;
        }
        for (const child of Array.from(node.childrenList.children)) {
          const childNode = nodesByPath.get(child.dataset.path);
          budget--;
          if (childNode && childNode.entry.directory) {
            await walk(childNode);
          }
        }
      }
      expandAllButton.disabled = true;
      try {
        for (const node of Array.from(nodesByPath.values())) {
          if (node.depth === 0 && node.entry.directory) {
            await walk(node);
          }
        }
      } finally {
        expandAllButton.disabled = false;
      }
    }

    async function collapseAll() {
      for (const node of Array.from(nodesByPath.values())) {
        if (node.entry.directory && node.expanded) {
          await setExpanded(node, false);
        }
      }
    }

    async function revealPath(path) {
      searchInput.value = '';
      setExtensionFilter(null);
      showResults(null);
      const relative = basePath === '' ? path : path.substring(basePath.length + 1);
      const segments = relative.split('/');
      let current = basePath;
      for (let i = 0; i < segments.length - 1; i++) {
        current = current === '' ? segments[i] : current + '/' + segments[i];
        const node = nodesByPath.get(current);
        if (!node) {
          return;
        }
        await setExpanded(node, true);
      }
      const target = nodesByPath.get(path);
      if (target) {
        const row = target.li.firstElementChild;
        row.scrollIntoView({ block: 'center' });
        row.classList.add('ae-row--flash');
        window.setTimeout(() => row.classList.remove('ae-row--flash'), 1600);
      }
    }

    let isNavigatingHash = false;
    async function handleHashNavigation() {
      if (isNavigatingHash) {
        return;
      }
      const rawHash = window.location.hash;
      if (!rawHash || rawHash.length <= 1) {
        if (activePreviewPath) {
          closePreview();
        }
        return;
      }
      isNavigatingHash = true;
      try {
        const subPath = decodeURIComponent(rawHash.substring(1)).replace(/^\/+/, '').replace(/\/+$/, '');
        if (!subPath) {
          return;
        }

        let fullPath = subPath;
        if (basePath && !subPath.startsWith(basePath + '/')) {
          fullPath = (basePath === '' ? '' : basePath + '/') + subPath;
        }

        await revealPath(fullPath);
        const targetNode = nodesByPath.get(fullPath);
        if (targetNode && targetNode.entry && targetNode.entry.directory) {
          await setExpanded(targetNode, true);
        } else {
          await openPreview(fullPath);
        }
      } catch (e) {
        // Ignore invalid target hash
      } finally {
        isNavigatingHash = false;
      }
    }

    window.addEventListener('hashchange', handleHashNavigation);

    // ------------------------------------------------------------------ search

    let indexPromise = null;
    let indexTruncated = false;

    function loadIndex() {
      if (!indexPromise) {
        indexPromise = api('searchIndex').then((data) => {
          indexTruncated = data.truncated;
          const prefix = basePath === '' ? '' : basePath + '/';
          return data.files.filter((f) => f.startsWith(prefix));
        });
        indexPromise.catch(() => {
          indexPromise = null;
        });
      }
      return indexPromise;
    }

    function escapeRegExp(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function highlight(text, terms) {
      const fragment = document.createDocumentFragment();
      if (terms.length === 0) {
        fragment.appendChild(document.createTextNode(text));
        return fragment;
      }
      const regex = new RegExp('(' + terms.map(escapeRegExp).join('|') + ')', 'ig');
      text.split(regex).forEach((part, index) => {
        if (part === '') {
          return;
        }
        if (index % 2 === 1) {
          fragment.appendChild(el('mark', '', part));
        } else {
          fragment.appendChild(document.createTextNode(part));
        }
      });
      return fragment;
    }

    function showResults(content) {
      resultsContainer.hidden = content === null;
      treeContainer.hidden = content !== null;
      expandAllButton.disabled = content !== null;
      collapseAllButton.disabled = content !== null;
      resultsContainer.replaceChildren();
      if (content) {
        resultsContainer.appendChild(content);
      }
    }

    function getExtension(path) {
      const name = baseName(path).toLowerCase();
      if (name.endsWith('.tar.gz')) return '.tar.gz';
      if (name.endsWith('.tar.bz2')) return '.tar.bz2';
      if (name.endsWith('.tar.xz')) return '.tar.xz';
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        return name.substring(dotIdx);
      }
      return null;
    }

    let activeExtensionFilter = null;

    function setExtensionFilter(ext) {
      activeExtensionFilter = ext;
      pillsBar.querySelectorAll('.ae-pill').forEach((p) => {
        const isTarget = ext === null ? !p.dataset.ext : p.dataset.ext === ext;
        p.classList.toggle('ae-pill--active', isTarget);
        p.setAttribute('aria-pressed', isTarget ? 'true' : 'false');
      });
      runSearch();
    }

    async function initExtensionPills() {
      try {
        const files = await loadIndex();
        if (!files || files.length === 0) {
          return;
        }

        const extCounts = new Map();
        files.forEach((f) => {
          const ext = getExtension(f);
          if (ext) {
            extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
          }
        });

        if (extCounts.size === 0) {
          return;
        }

        const sorted = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        pillsBar.replaceChildren();

        const allPill = el('button', 'ae-pill ae-pill--active');
        allPill.type = 'button';
        allPill.setAttribute('aria-pressed', 'true');
        const allLabel = el('span', 'ae-pill-label', label('All', 'All'));
        const allBadge = el('span', 'ae-pill-count', String(files.length));
        allPill.append(allLabel, allBadge);
        allPill.addEventListener('click', () => setExtensionFilter(null));
        pillsBar.appendChild(allPill);

        sorted.slice(0, 18).forEach(([ext, count]) => {
          const pill = el('button', 'ae-pill');
          pill.type = 'button';
          pill.dataset.ext = ext;
          pill.setAttribute('aria-pressed', 'false');
          const extLabel = el('span', 'ae-pill-label', ext);
          const countBadge = el('span', 'ae-pill-count', String(count));
          pill.append(extLabel, countBadge);
          pill.addEventListener('click', () => {
            if (activeExtensionFilter === ext) {
              setExtensionFilter(null);
            } else {
              setExtensionFilter(ext);
            }
          });
          pillsBar.appendChild(pill);
        });

        pillsBar.hidden = false;
      } catch (e) {
        // ignore
      }
    }

    let searchSequence = 0;
    async function runSearch() {
      const query = searchInput.value.trim().toLowerCase();
      const extFilter = activeExtensionFilter;
      const sequence = ++searchSequence;

      if (query === '' && extFilter === null) {
        showResults(null);
        setStatus('');
        return;
      }

      let files;
      try {
        files = await loadIndex();
      } catch (e) {
        setStatus(label('Error') + ' (' + e.message + ')', true);
        return;
      }
      if (sequence !== searchSequence) {
        return;
      }

      const terms = query.split(/\s+/).filter(Boolean);
      const matches = files.filter((f) => {
        const lower = f.toLowerCase();
        const matchesTerms = terms.length === 0 || terms.every((t) => lower.includes(t));
        const matchesExt = !extFilter || getExtension(f) === extFilter;
        return matchesTerms && matchesExt;
      });

      matches.sort((a, b) => {
        if (terms.length > 0) {
          const inNameA = terms.every((t) => baseName(a).toLowerCase().includes(t)) ? 0 : 1;
          const inNameB = terms.every((t) => baseName(b).toLowerCase().includes(t)) ? 0 : 1;
          if (inNameA !== inNameB) return inNameA - inNameB;
        }
        return a.length - b.length || a.localeCompare(b);
      });

      const list = el('ul', 'ae-list ae-list--results');
      matches.slice(0, MAX_SEARCH_RESULTS).forEach((path) => {
        const li = el('li', 'ae-node');
        li.style.setProperty('--depth', '0');
        const row = el('div', 'ae-row');
        row.tabIndex = 0;
        row.dataset.path = path;
        row.appendChild(svgIcon('file'));
        const link = el('a', 'ae-name');
        link.href = fileUrl(path);
        link.appendChild(highlight(path.substring(basePath === '' ? 0 : basePath.length + 1), terms));
        link.addEventListener('click', (event) => {
          if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) {
            event.preventDefault();
            openPreview(path);
          }
        });
        row.appendChild(link);
        row.appendChild(el('span', 'ae-size'));
        row.appendChild(el('span', 'ae-date'));
        const actions = el('span', 'ae-actions');
        actions.append(
          iconButton('preview', label('Preview'), () => openPreview(path)),
          iconButton('reveal', label('Reveal'), () => revealPath(path)),
          iconLink('download', label('Download'), fileUrl(path), true),
          copyLinkButton(fileUrl(path), label('ToastLinkCopied', 'Link copied to clipboard')));
        row.appendChild(actions);
        li.appendChild(row);
        list.appendChild(li);
      });

      let filterSuffix = extFilter ? ' (' + extFilter + ')' : '';
      let summary = matches.length + ' ' + label('Matches') + filterSuffix;
      if (matches.length > MAX_SEARCH_RESULTS) {
        summary += ' (' + MAX_SEARCH_RESULTS + ')';
      }
      if (indexTruncated) {
        summary += ' - ' + label('Truncated');
      }
      setStatus(matches.length === 0 ? label('NoMatches') : summary);
      showResults(matches.length === 0 ? document.createDocumentFragment() : list);
    }

    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(runSearch, 80);
    });

    // --------------------------------------------------------------- shortcuts

    function visibleRows() {
      const container = resultsContainer.hidden ? treeContainer : resultsContainer;
      return Array.from(container.querySelectorAll('.ae-row')).filter((r) => r.offsetParent !== null);
    }

    listColumn.addEventListener('keydown', async (event) => {
      const row = event.target.closest('.ae-row');
      if (!row) {
        return;
      }
      const rows = visibleRows();
      const idx = rows.indexOf(row);
      const node = nodesByPath.get(row.dataset.path);

      if (event.key === 'ArrowDown' && idx >= 0 && idx < rows.length - 1) {
        event.preventDefault();
        rows[idx + 1].focus();
      } else if (event.key === 'ArrowUp' && idx > 0) {
        event.preventDefault();
        rows[idx - 1].focus();
      } else if (event.key === 'ArrowRight' && node && node.entry.directory) {
        event.preventDefault();
        if (!node.expanded) {
          await setExpanded(node, true);
        } else {
          const next = visibleRows()[idx + 1];
          if (next) {
            next.focus();
          }
        }
      } else if (event.key === 'ArrowLeft' && node) {
        event.preventDefault();
        if (node.entry.directory && node.expanded) {
          await setExpanded(node, false);
        } else {
          const parentPath = node.path.substring(0, node.path.lastIndexOf('/'));
          const parentNode = nodesByPath.get(parentPath);
          if (parentNode && parentNode.li.firstElementChild) {
            parentNode.li.firstElementChild.focus();
          }
        }
      } else if (event.key === 'Enter' && event.target === row) {
        event.preventDefault();
        if (node && node.entry.directory) {
          await setExpanded(node, !node.expanded);
        } else if (row.dataset.path) {
          await openPreview(row.dataset.path);
        }
      }
    });

    expandAllButton.addEventListener('click', expandAll);
    collapseAllButton.addEventListener('click', collapseAll);

    document.addEventListener('keydown', (event) => {
      const typing = /^(input|textarea|select)$/i.test(event.target.tagName) || event.target.isContentEditable;

      if (event.key === 'Escape') {
        if (isModalOpen()) {
          return;
        }
        if (event.target === searchInput) {
          if (searchInput.value !== '' || activeExtensionFilter !== null) {
            event.preventDefault();
            searchInput.value = '';
            setExtensionFilter(null);
          }
          searchInput.blur();
          return;
        }
        if (activePreviewPath !== null) {
          event.preventDefault();
          closePreview();
          return;
        }
        if (activeExtensionFilter !== null || searchInput.value !== '') {
          event.preventDefault();
          searchInput.value = '';
          setExtensionFilter(null);
          return;
        }
        return;
      }

      if (typing || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (event.key === '?') {
        event.preventDefault();
        toggleShortcutsModal();
        return;
      }

      if (isModalOpen()) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }

      if (event.key === 'j' || event.key === 'k') {
        const rows = visibleRows();
        if (rows.length === 0) {
          return;
        }
        const currentFocusedRow = document.activeElement ? document.activeElement.closest('.ae-row') : null;
        let idx = currentFocusedRow ? rows.indexOf(currentFocusedRow) : -1;
        if (idx === -1) {
          const selected = root.querySelector('.ae-row--selected');
          if (selected) {
            idx = rows.indexOf(selected);
          }
        }
        if (event.key === 'j') {
          const nextIdx = idx === -1 ? 0 : Math.min(idx + 1, rows.length - 1);
          rows[nextIdx].focus();
        } else {
          const prevIdx = idx === -1 ? 0 : Math.max(idx - 1, 0);
          rows[prevIdx].focus();
        }
        event.preventDefault();
        return;
      }

      if (event.key === 'o' || (event.key === 'Enter' && !event.target.closest('.ae-row'))) {
        const focusedRow = document.activeElement ? document.activeElement.closest('.ae-row') : null;
        if (focusedRow) {
          const node = nodesByPath.get(focusedRow.dataset.path);
          if (node && node.entry.directory) {
            event.preventDefault();
            setExpanded(node, !node.expanded);
          } else if (focusedRow.dataset.path) {
            event.preventDefault();
            openPreview(focusedRow.dataset.path);
          }
        }
        return;
      }

      if (event.key === 's') {
        if (activePreview && typeof activePreview.computeChecksum === 'function') {
          event.preventDefault();
          activePreview.computeChecksum();
        }
        return;
      }

      if (event.key === 'c') {
        if (activePreview && typeof activePreview.copyContent === 'function') {
          event.preventDefault();
          activePreview.copyContent();
        }
        return;
      }

      if (event.key === 'l') {
        if (activePreview && typeof activePreview.copyLink === 'function') {
          event.preventDefault();
          activePreview.copyLink();
        } else {
          const focusedRow = document.activeElement ? document.activeElement.closest('.ae-row') : null;
          if (focusedRow && focusedRow.dataset.path) {
            event.preventDefault();
            const copyBtn = focusedRow.querySelector('.ae-iconbutton[title*="link" i], .ae-iconbutton[title*="Link" i]');
            if (copyBtn) {
              copyBtn.click();
            }
          }
        }
        return;
      }

      if (event.key === 'd') {
        if (activePreview && typeof activePreview.download === 'function') {
          event.preventDefault();
          activePreview.download();
        } else {
          const focusedRow = document.activeElement ? document.activeElement.closest('.ae-row') : null;
          if (focusedRow && focusedRow.dataset.path) {
            event.preventDefault();
            const dl = focusedRow.querySelector('a[download]');
            if (dl) {
              dl.click();
            }
          }
        }
        return;
      }
    });

    initTree();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
