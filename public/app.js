// Renders exactly what GET /api/v1/token/:chainId/:address returns.
// Token names and symbols are attacker-controlled, so nothing here uses innerHTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-6)}` : '');
  const plural = (n, one, many) => `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;
  const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
  const ago = (s) => (s == null ? null : s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 172800 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`);
  const TONE = { verified: 'ok', 'observed-emitter': 'ok', 'observed-platform': 'ok', 'protocol-verified': 'warn', 'code-match': 'warn', 'unverified-emitter': 'bad', discovered: 'warn', 'discovered-first': 'warn', 'discovered-silent': 'flat', 'bytecode-cluster': 'warn', none: 'flat' };
  const ROLE = { registry: ['Listed factory', 'ok'], companion: ['Listed contract', 'ok'], 'look-alike': ['Look-alike event', 'bad'], unlisted: ['Not in registry', 'warn'], helper: ['Per-launch contract', 'flat'], hook: ['Pool hook', 'flat'], infra: ['Shared plumbing', 'flat'] };

  let chains = [];
  let chainId = null;
  let explorer = null;

  const api = async (path) => {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.message || `Request failed (${res.status})`), { status: res.status });
    return body;
  };

  const hexLink = (addr, kind = 'address') => {
    const span = el('span', { class: 'hex', text: addr });
    return explorer ? el('a', { href: `${explorer}/${kind}/${addr}`, rel: 'noopener noreferrer', target: '_blank' }, span) : span;
  };

  const shortLink = (addr) => {
    const node = hexLink(addr);
    (node.firstChild ?? node).textContent = short(addr);
    node.title = addr;
    if (node.tagName !== 'A') node.textContent = short(addr);
    return node;
  };

  function field(dl, label, value, { big = false, note = null } = {}) {
    const dd = el('dd', big ? { class: 'big' } : {});
    dd.append(value);
    if (note) dd.append(el('small', { text: note }));
    dl.append(el('dt', { text: label }), dd);
  }

  function renderPlate(d) {
    const dl = $('fields');
    dl.replaceChildren();
    const MAKER = { discovered: 'Unlisted factory', 'discovered-first': 'New or one-off deployer', 'discovered-silent': 'Nobody announced it', 'unverified-emitter': 'Unverified', 'code-match': 'Unverified' };
    const maker = d.verdict.code === 'protocol-verified' ? `${d.launchpad?.name ?? 'Protocol'}, unlisted app` : d.launchpad?.name ?? (d.likelyLaunchpad ? `${d.likelyLaunchpad.name}?` : MAKER[d.verdict.code] ?? 'Unknown');
    field(dl, 'Maker', maker, {
      big: true,
      note: d.launchpad?.stack ?? (d.likelyLaunchpad ? `Template shared with ${num(d.likelyLaunchpad.tokens)} ${d.likelyLaunchpad.name} tokens. A template can be copied, so this is not proof.` : null),
    });
    if (d.factory) {
      const bits = [];
      if (d.factory.label) bits.push(d.factory.label);
      if (d.factory.platform?.integrator) bits.push(d.factory.platform.status === 'unlisted' ? `launched by unlisted app ${short(d.factory.platform.integrator)}` : `app ${short(d.factory.platform.integrator)}`);
      if (d.factory.event) bits.push(`event ${d.factory.event.split('(')[0]}`);
      if (d.factory.tokensAnnounced != null) bits.push(`${plural(d.factory.tokensAnnounced, 'token', 'tokens')} announced recently`);
      if (d.factory.firstSeenAgoSec != null) bits.push(`first seen ${ago(d.factory.firstSeenAgoSec)}`);
      if (d.factory.sharesSignatureWith?.length) bits.push(`same event signature as ${d.factory.sharesSignatureWith.join(', ')}`);
      field(dl, 'Factory', hexLink(d.factory.address), { note: bits.join(', ') });
    }
    const t = d.token;
    field(dl, 'Token', hexLink(t.address), { note: [t.name, t.symbol ? `(${t.symbol})` : null].filter(Boolean).join(' ') || 'No ERC-20 name' });
    if (d.birth) field(dl, 'Created in', hexLink(d.birth.tx, 'tx'), { note: `block ${num(d.birth.block)}` });
    const b = d.bytecode;
    const pattern = b.kind === 'minimal-proxy' ? `${b.size}-byte clone of ${short(b.implementation)}` : `${num(b.size)}-byte ${b.kind === 'eip1967-proxy' ? 'upgradeable proxy' : 'contract'}`;
    // the cluster counts this token too when it is indexed
    const others = Math.max(0, (b.cluster?.size ?? 0) - (d.indexedAt ? 1 : 0));
    const shared = others ? `Same template as ${plural(others, 'other indexed token', 'other indexed tokens')}` : 'No other indexed token uses this template';
    field(dl, 'Pattern', pattern, { note: [shared, b.note].filter(Boolean).join('. ') });

    const stamp = $('stamp');
    stamp.textContent = d.verdict.headline;
    stamp.className = `stamp tone-${TONE[d.verdict.code] ?? 'flat'}`;
    void stamp.offsetWidth; // restart the press
    stamp.classList.add('press');
    $('plate').hidden = false;
    $('detail').textContent = d.verdict.detail;
  }

  function table(node, heads, rows, empty) {
    node.replaceChildren();
    if (!rows.length) { node.append(el('caption', { class: 'empty', text: empty })); return; }
    node.append(el('thead', {}, el('tr', {}, ...heads.map((h) => el('th', { scope: 'col', text: h })))));
    node.append(el('tbody', {}, ...rows));
  }
  const tag = (text, tone) => el('span', { class: `tag tone-${tone}`, text });

  function renderAnnouncers(d) {
    const rows = d.announcers.map((a) => el('tr', {},
      el('td', {}, shortLink(a.emitter)),
      el('td', {}, tag(...(ROLE[a.role] ?? [a.role, 'flat'])), a.label ? el('div', { class: 'sub', text: a.label }) : null),
      el('td', { class: 'num', text: num(a.births) }),
      el('td', { class: 'num', text: a.purity == null ? '–' : `${Math.round(a.purity * 100)}%` }),
    ));
    table($('announcers'), ['Contract', 'Role', 'Tokens announced', 'One template'], rows, '');
    $('evidence').hidden = rows.length === 0;
  }

  function show(d) {
    renderPlate(d);
    renderAnnouncers(d);
    const path = `/api/v1/token/${d.chain.id}/${d.token.address}`;
    $('endpoint').textContent = `GET ${location.origin}${path}`;
    $('copy').onclick = () => navigator.clipboard?.writeText(location.origin + path).then(() => { $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy URL'), 1500); });
    $('json').textContent = JSON.stringify(d, null, 2);
    $('raw').hidden = false;
  }

  async function trace(address, { push = true } = {}) {
    const btn = document.querySelector('#trace button');
    const status = $('status');
    status.className = 'status';
    status.textContent = 'Tracing…';
    btn.disabled = true;
    try {
      const d = await api(`/api/v1/token/${chainId}/${address}`);
      show(d);
      status.textContent = d.knownContract ? `This address is ${d.knownContract.launchpad}'s ${d.knownContract.role ?? 'contract'}, not a token.` : '';
      if (push) history.pushState({}, '', `/t/${chainId}/${address}`);
      $('address').value = address;
    } catch (e) {
      status.className = 'status bad';
      status.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function lists() {
    const pick = (addr) => () => { trace(addr); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    const pickable = (tr, addr) => {
      tr.className = 'pick'; tr.tabIndex = 0; tr.setAttribute('role', 'button');
      tr.addEventListener('click', pick(addr));
      tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(addr)(); } });
      return tr;
    };
    try {
      const onlyUnlisted = $('unlisted-only')?.checked;
      const { tokens, unlisted } = await api(`/api/v1/recent/${chainId}?limit=25${onlyUnlisted ? '&attributed=false' : ''}`);
      const rowOf = (t) => { const tr = pickable(el('tr', {},
        el('td', {}, el('strong', { text: t.symbol || '(no symbol)' }), el('div', { class: 'hex', text: short(t.address) })),
        el('td', {}, t.launchpad ? tag(t.launchpad, TONE[t.confidence] ?? 'flat') : tag(t.confidence === 'discovered' ? 'Unlisted' : 'Unverified', t.confidence === 'discovered' ? 'warn' : 'bad')),
        el('td', { class: 'num', text: num(t.birthBlock) }),
        el('td', { text: t.bytecodeKind === 'minimal-proxy' ? `${t.codeSize}-byte clone` : `${num(t.codeSize)} bytes` }),
      ), t.address); if (t.unlisted) tr.classList.add('unlisted'); return tr; };
      table($('recent'), ['Token', 'Maker', 'Block', 'Pattern'], tokens.map(rowOf), onlyUnlisted ? 'No unlisted tokens in the latest births — every recent factory is in the registry.' : 'No births indexed yet. The indexer fills this within a minute of starting.');
      const noteEl = $('recent-note');
      if (noteEl) noteEl.textContent = onlyUnlisted ? `${tokens.length} unlisted (no known factory), newest first` : `${unlisted} of the newest ${tokens.length} are unlisted — highlighted below`;
      const { candidates } = await api(`/api/v1/candidates/${chainId}`);
      const note = (c) => [
        c.coEmitters?.length ? `works with ${plural(c.coEmitters.length, 'other contract', 'other contracts')}` : null,
        c.mechanism?.addresses > 1 ? `same creation event at ${c.mechanism.addresses} addresses: a factory that rotates` : null,
      ].filter(Boolean).join(', ');
      table($('candidates'), ['Contract', 'Tokens announced', 'One template', 'First seen'], candidates.slice(0, 40).map((c) => pickable(el('tr', {},
        el('td', {}, el('span', { class: 'hex', text: short(c.emitter) }), c.status === 'look-alike' ? el('div', {}, tag('Look-alike event', 'bad')) : null, note(c) ? el('div', { class: 'sub', text: note(c) }) : null),
        el('td', { class: 'num', text: num(c.tokensAnnounced) }),
        el('td', { class: 'num', text: c.templatePurity == null ? '–' : `${Math.round(c.templatePurity * 100)}%` }),
        el('td', { class: 'num', text: c.ageKnown ? ago(c.firstActivityAgoSec) ?? '–' : c.seenFromIndexStart ? 'before this index' : `${ago(c.firstSeenAgoSec) ?? '–'} (checking)` }),
      ), c.sampleTokens[0])), 'Every active factory is already in the registry.');
      return tokens;
    } catch {
      return [];
    }
  }

  async function boot() {
    try { chains = (await api('/api/v1/chains')).chains; } catch { $('status').className = 'status bad'; $('status').textContent = 'The API is not answering.'; return; }
    const sel = $('chain');
    for (const c of chains) sel.append(el('option', { value: String(c.id), text: c.name }));
    const m = location.pathname.match(/^\/t\/(\d+)\/(0x[0-9a-fA-F]{40})$/);
    chainId = m && chains.some((c) => String(c.id) === m[1]) ? Number(m[1]) : chains[0].id;
    sel.value = String(chainId);
    const setChain = () => { chainId = Number(sel.value); explorer = chains.find((c) => c.id === chainId)?.explorer ?? null; };
    setChain();
    sel.addEventListener('change', () => { setChain(); $('plate').hidden = true; $('evidence').hidden = true; $('raw').hidden = true; $('detail').textContent = ''; history.pushState({}, '', '/'); lists(); });
    $('trace').addEventListener('submit', (ev) => { ev.preventDefault(); trace($('address').value.trim()); });
    window.addEventListener('popstate', () => { const p = location.pathname.match(/^\/t\/(\d+)\/(0x[0-9a-fA-F]{40})$/); if (p) trace(p[2], { push: false }); });

    $('unlisted-only')?.addEventListener('change', () => lists());
    const tokens = await lists();
    if (m) trace(m[2], { push: false });
    else if (tokens[0]) trace(tokens[0].address, { push: false }); // open on a real, current example
    setInterval(lists, 15000);
  }
  boot();
})();
