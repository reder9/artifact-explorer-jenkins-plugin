/*
 * Artifact Explorer: searchable, lazily loaded tree of a build's archived artifacts.
 * Plain browser JavaScript, no build step and no inline styles (Jenkins CSP friendly).
 */
(function () {
  'use strict';

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
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
        const cleanUrl = url.trim();
        if (/^(https?:|mailto:|\/|\.\/|#)/i.test(cleanUrl)) {
          return `<a href="${cleanUrl}" target="_blank" rel="noopener" class="ae-md-link">${label}</a>`;
        }
        return label;
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
        const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
        html += `<th${align}>${inlineMarkdown(h)}</th>`;
      });
      html += '</tr></thead><tbody>';
      for (let i = 2; i < lines.length; i++) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
        html += '<tr>';
        cells.forEach((c, idx) => {
          const align = aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '';
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

  function sha256Pure(buffer) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    const bytes = new Uint8Array(buffer);
    const len = bytes.length;
    const bitLen = len * 8;

    const padLen = (len % 64 < 56) ? (56 - (len % 64)) : (120 - (len % 64));
    const totalLen = len + padLen + 8;
    const padded = new Uint8Array(totalLen);
    padded.set(bytes);
    padded[len] = 0x80;

    const view = new DataView(padded.buffer);
    view.setUint32(totalLen - 4, bitLen >>> 0, false);
    view.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false);

    const W = new Uint32Array(64);

    for (let i = 0; i < totalLen; i += 64) {
      for (let t = 0; t < 16; t++) {
        W[t] = view.getUint32(i + t * 4, false);
      }
      for (let t = 16; t < 64; t++) {
        const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^
                   ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^
                   (W[t - 15] >>> 3);
        const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^
                   ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^
                   (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }

      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];

      for (let t = 0; t < 64; t++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }

      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }

    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  async function computeSha256(buffer) {
    if (window.crypto && window.crypto.subtle && window.crypto.subtle.digest) {
      try {
        const hashBuf = await window.crypto.subtle.digest('SHA-256', buffer);
        return Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        // Fallback to pure JS below
      }
    }
    return sha256Pure(buffer);
  }

  function svgIcon(kind) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
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
      external: 'M6 3h7v7M13 3L6.5 9.5M10 8v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5',
      copy: 'M5 4h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm-2 8V3a1 1 0 0 1 1-1h7',
      check: 'M3.5 8.5l3 3 6-7',
      help: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.9-3.2c-.6.4-.9.8-.9 1.4h-1.5c0-1.2.6-1.8 1.4-2.3.5-.3.8-.7.8-1.2 0-.8-.7-1.4-1.7-1.4-.9 0-1.6.5-1.7 1.3H3.6C3.8 4.3 5 3.3 6.9 3.3c2 0 3.3 1.2 3.3 2.7 0 1-.6 1.7-1.3 2.1z',
      shield: 'M8 1.5l5.5 2.5v4c0 3.8-2.6 6.8-5.5 7.5-2.9-.7-5.5-3.7-5.5-7.5v-4L8 1.5z',
    };
    path.setAttribute('d', shapes[kind] || shapes.file);
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

  let toastContainer = null;
  let toastTimer = null;

  function showToast(message, iconKind) {
    if (!message) return;
    if (!toastContainer) {
      toastContainer = el('div', 'ae-toast-container');
      toastContainer.setAttribute('role', 'status');
      toastContainer.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastContainer);
    }
    toastContainer.replaceChildren();
    if (toastTimer) {
      window.clearTimeout(toastTimer);
      toastTimer = null;
    }

    const toast = el('div', 'ae-toast');
    const icon = el('span', 'ae-toast-icon');
    icon.appendChild(svgIcon(iconKind || 'check'));
    const text = el('span', 'ae-toast-msg', message);
    toast.append(icon, text);
    toast.addEventListener('click', () => {
      toast.classList.remove('ae-toast--visible');
      window.setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 200);
    });
    toastContainer.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('ae-toast--visible');
    });

    toastTimer = window.setTimeout(() => {
      toast.classList.remove('ae-toast--visible');
      window.setTimeout(() => {
        if (toast.parentNode) {
          toast.remove();
        }
      }, 250);
    }, 2400);
  }

  async function copyTextToClipboard(text) {
    if (!text) {
      return false;
    }
    // 1. Try modern Async Clipboard API first
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        // Fall back to hidden textarea execCommand
      }
    }
    // 2. Fallback via temporary DOM textarea
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
        showToast(customToastMsg || label('ToastLinkCopied', 'Link copied to clipboard'));
        window.setTimeout(() => {
          button.title = defaultLabel;
          button.setAttribute('aria-label', defaultLabel);
          button.replaceChildren(svgIcon('link'));
          button.classList.remove('ae-iconbutton--done');
        }, 1500);
      } else {
        showToast(label('CopyFailed', 'Could not copy to clipboard'), 'help');
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
        showToast(label('ToastContentsCopied', 'File contents copied to clipboard'));
        window.setTimeout(() => {
          button.title = defaultLabel;
          button.setAttribute('aria-label', defaultLabel);
          button.replaceChildren(svgIcon('copy'));
          button.classList.remove('ae-iconbutton--done');
        }, 1500);
      } else {
        showToast(label('CopyFailed', 'Could not copy to clipboard'), 'help');
      }
    });
    return button;
  }

  // ------------------------------------------------------------------ layout

  const toolbar = el('div', 'ae-toolbar');
  const searchInput = el('input', 'jenkins-input ae-search');
  searchInput.type = 'search';
  searchInput.placeholder = label('Search') + '  ( / )';
  searchInput.setAttribute('aria-label', label('Search'));
  searchInput.autocomplete = 'off';

  const expandAllButton = el('button', 'jenkins-button', label('ExpandAll'));
  expandAllButton.type = 'button';
  const collapseAllButton = el('button', 'jenkins-button', label('CollapseAll'));
  collapseAllButton.type = 'button';

  const zipLink = el('a', 'jenkins-button', label('DownloadZip'));
  zipLink.href = (basePath === '' ? fileUrl('') : fileUrl(basePath) + '/') + '*zip*/' +
    (basePath === '' ? 'archive' : baseName(basePath)) + '.zip';

  const helpButton = el('button', 'jenkins-button ae-help-btn', '?');
  helpButton.type = 'button';
  helpButton.title = label('KeyboardShortcuts') || 'Keyboard shortcuts (?)';
  helpButton.setAttribute('aria-label', label('KeyboardShortcuts') || 'Keyboard shortcuts');
  helpButton.addEventListener('click', toggleShortcutsModal);
  toolbar.append(searchInput, expandAllButton, collapseAllButton, zipLink, helpButton);

  const pillsBar = el('div', 'ae-pills-bar');
  pillsBar.setAttribute('role', 'toolbar');
  pillsBar.setAttribute('aria-label', label('ExtensionFilters', 'File extension filters'));
  pillsBar.hidden = true;

  const breadcrumb = el('nav', 'ae-breadcrumb');
  breadcrumb.setAttribute('aria-label', 'Path');
  (function buildBreadcrumb() {
    if (basePath === '') {
      breadcrumb.hidden = true;
      return;
    }
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

  const status = el('div', 'ae-status');
  status.setAttribute('role', 'status');

  const workspace = el('div', 'ae-workspace');
  const listColumn = el('div', 'ae-main');
  const treeContainer = el('div', 'ae-tree');
  const resultsContainer = el('div', 'ae-results');
  resultsContainer.hidden = true;
  listColumn.append(treeContainer, resultsContainer);

  const previewPane = el('aside', 'ae-preview');
  previewPane.setAttribute('aria-label', label('Preview'));
  previewPane.hidden = true;
  workspace.append(listColumn, previewPane);

  root.append(toolbar, pillsBar, breadcrumb, status, workspace);

  // -------------------------------------------------------- shortcuts modal

  const modalBackdrop = el('div', 'ae-modal-backdrop');
  modalBackdrop.hidden = true;
  modalBackdrop.setAttribute('role', 'dialog');
  modalBackdrop.setAttribute('aria-modal', 'true');
  modalBackdrop.setAttribute('aria-labelledby', 'ae-shortcuts-modal-title');

  const modalDialog = el('div', 'ae-modal');
  const modalHeader = el('div', 'ae-modal-header');
  const modalTitle = el('h3', 'ae-modal-title', label('KeyboardShortcuts') || 'Keyboard Shortcuts');
  modalTitle.id = 'ae-shortcuts-modal-title';
  const modalCloseBtn = iconButton('close', label('Close') || 'Close', closeShortcutsModal);
  modalHeader.append(modalTitle, modalCloseBtn);

  const modalBody = el('div', 'ae-modal-body');

  function shortcutRow(keys, desc) {
    const row = el('div', 'ae-shortcut-row');
    const descSpan = el('span', '', desc);
    const keysWrap = el('span', 'ae-shortcut-keys');
    keys.forEach((k) => {
      keysWrap.appendChild(el('kbd', 'ae-kbd', k));
    });
    row.append(descSpan, keysWrap);
    return row;
  }

  const navGroup = el('div', 'ae-shortcut-group');
  navGroup.appendChild(el('div', 'ae-shortcut-group-title', label('Navigation', 'Navigation')));
  navGroup.append(
    shortcutRow(['/'], label('ShortcutFocusSearch', 'Focus search filter')),
    shortcutRow(['j', 'k'], label('ShortcutNavRows', 'Navigate items down / up')),
    shortcutRow(['\u2190', '\u2192'], label('ShortcutExpandCollapse', 'Collapse / expand folder')),
    shortcutRow(['Enter', 'o'], label('ShortcutOpen', 'Open preview or toggle folder'))
  );

  const actGroup = el('div', 'ae-shortcut-group');
  actGroup.appendChild(el('div', 'ae-shortcut-group-title', label('Actions', 'Actions')));
  actGroup.append(
    shortcutRow(['c'], label('ShortcutCopyContent', 'Copy file contents')),
    shortcutRow(['l'], label('ShortcutCopyLink', 'Copy shareable deep link')),
    shortcutRow(['s'], label('ShortcutSha256', 'Compute SHA-256 checksum')),
    shortcutRow(['d'], label('ShortcutDownload', 'Download active file')),
    shortcutRow(['Esc'], label('ShortcutDismiss', 'Close preview / dismiss modal')),
    shortcutRow(['?'], label('ShortcutCheatsheet', 'Toggle shortcuts cheatsheet'))
  );

  modalBody.append(navGroup, actGroup);
  modalDialog.append(modalHeader, modalBody);
  modalBackdrop.appendChild(modalDialog);

  modalBackdrop.addEventListener('click', (e) => {
    if (e.target === modalBackdrop) {
      closeShortcutsModal();
    }
  });

  root.appendChild(modalBackdrop);

  let prevFocus = null;
  function openShortcutsModal() {
    prevFocus = document.activeElement;
    modalBackdrop.hidden = false;
    modalCloseBtn.focus();
  }

  function closeShortcutsModal() {
    modalBackdrop.hidden = true;
    if (prevFocus && typeof prevFocus.focus === 'function') {
      prevFocus.focus();
    }
  }

  function toggleShortcutsModal() {
    if (modalBackdrop.hidden) {
      openShortcutsModal();
    } else {
      closeShortcutsModal();
    }
  }

  function isModalOpen() {
    return !modalBackdrop.hidden;
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
        const resp = await fetch(fileUrl(mPath), { credentials: 'same-origin' });
        if (resp.ok) {
          const text = await resp.text();
          const lines = text.split(/\r?\n/);
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
        const res = await fetch(fileUrl(path), { credentials: 'same-origin' });
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        const buf = await res.arrayBuffer();
        if (seq !== previewSequence) {
          return;
        }
        calculatedHash = await computeSha256(buf);

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
            showToast(label('ToastHashCopied', 'SHA-256 hash copied to clipboard'));
            setTimeout(() => {
              copyBtn.title = label('CopyHash', 'Copy hash');
              copyBtn.setAttribute('aria-label', label('CopyHash', 'Copy hash'));
              copyBtn.replaceChildren(svgIcon('copy'));
              copyBtn.classList.remove('ae-iconbutton--done');
            }, 1500);
          } else {
            showToast(label('CopyFailed', 'Could not copy to clipboard'), 'help');
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
        event.preventDefault();
        closeShortcutsModal();
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
})();
