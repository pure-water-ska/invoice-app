// pricing-grouped-sync.js — pricing synced as ONE Firestore doc per product.
//
// WHY: the per-record model (pricing-sync.js → collection `pricing_v2`) stored
// one doc per (product+customer+shipping) rule → ~3,329 docs, read in full by
// every listener attach / session / device. Firestore bills 1 read per doc, so
// reads dominated quota. Grouping all of a product's rules into a single doc
// (`pricing_byproduct/{productId}`) cuts that to ~32 docs (one per product) —
// ~100× fewer reads — WITHOUT changing the local data shape: `wt_pricing` stays
// a flat array, so DB.getPricing()/getPrice()/pricing.html/invoice-create are
// untouched. A translation layer groups on write and flattens on read.
//
// Firestore doc shape:
//   pricing_byproduct/{productId} = {
//     productId,
//     rules: { "<ruleId>": <full rule object>, ... },   // map, key = rule.id (UUID → field-path safe)
//     _by, _byName, _ts
//   }
//
// Exposes window.PricingSync with the SAME interface the rest of the app expects
// (init / onLocalChange / diagnose / pullOnce), so db.js + nav.js wiring is
// identical to the old PricingSync — only the file loaded changes.
//
// ── Durable per-rule writes (v1.0.234) ──────────────────────────────────────
// Measured on live data: 67 prices no longer matched the last value saved for them
// on pricing.html — 41 saves never reached the server, 26 were overwritten later.
// Three causes, all fixed here:
//   1. A change made while sync wasn't ready waited in an in-memory array, and a
//      rejected commit (e.g. quota) was only logged — leaving the page lost it.
//      → Every change is now a queued op persisted via DB.setLocalOnly
//        ('wt_price_pending'; HDD-backed on desktop) and retried until the server
//        acknowledges it: on init, on 'online', on a snapshot, and from the
//        pending-upload bar's retry (sync.js).
//   2. A server snapshot replaced local rules wholesale, so an unsent change
//      silently flipped back to the old price.
//      → Queued ops are overlaid on every snapshot before it reaches local.
//   3. Every write was set({ rules: <ALL rules of the product> }, {merge:false}),
//      so a device holding stale prices reverted every OTHER customer's newer price
//      for that product whenever it saved any one of them.
//      → Only the rules that actually changed are written, with a field-level
//        merge ({ rules: { <id>: rule | FieldValue.delete() } }, {merge:true}).
// What changed is found by diffing local against a per-rule baseline of the server
// as last seen ('wt_price_baseline', rule id → [productId, content hash]) — never
// against db's "previous" array, which is the same mutated array (see CLAUDE.md).

(function () {
  'use strict';

  // ── Pure helpers (also exported for the node tests) ─────────────────────────
  function stripMeta(r) { if (!r || typeof r !== 'object') return r; const { _by, _byName, _ts, ...rec } = r; return rec; }

  // flat array of rule objects → Map<productId, { ruleId: rule }>
  function groupByProduct(arr) {
    const m = new Map();
    for (const r of (arr || [])) {
      if (!r || !r.id) continue;
      const pid = r.productId || '_noprod';
      if (!m.has(pid)) m.set(pid, {});
      m.get(pid)[r.id] = r;
    }
    return m;
  }

  // [{ id:productId, data:{ rules:{...} } }] → flat array of rule objects
  function flattenDocs(docs) {
    const out = [];
    for (const d of (docs || [])) {
      const rules = (d && d.data && d.data.rules) || {};
      for (const k in rules) {
        const r = rules[k];
        if (r && typeof r === 'object') out.push(r);
      }
    }
    return out;
  }

  // Stable fingerprint of one product's rule set (order-independent, meta-stripped).
  function fpRules(rulesObj) {
    const keys = Object.keys(rulesObj || {}).sort();
    return JSON.stringify(keys.map(k => stripMeta(rulesObj[k])));
  }

  // Key-order-independent serialisation — a rule read back from Firestore may list its
  // fields in a different order than the object the page built.
  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined)
        .map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function hashRule(r) {
    const s = canon(stripMeta(r));
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + '.' + s.length.toString(36);
  }

  const pidOf = r => (r && r.productId) || '_noprod';
  const opKey = (ruleId, pid) => ruleId + '@' + pid;

  // rule array → baseline { ruleId: [productId, hash] } (plain object: cheap to persist)
  function baselineFromRules(arr) {
    const b = {};
    for (const r of (arr || [])) if (r && r.id) b[r.id] = [pidOf(r), hashRule(r)];
    return b;
  }

  // Local array vs baseline → the complete set of differences as ops
  // { ruleId, pid, rule } — rule === null means "delete this rule from pid's doc".
  // A rule moved to another product yields a delete (old doc) plus an upsert (new doc).
  function diffRules(baseline, localArr) {
    const ops = [], seen = new Set(), base = baseline || {};
    for (const r of (localArr || [])) {
      if (!r || !r.id || seen.has(r.id)) continue;
      seen.add(r.id);
      const pid = pidOf(r), b = base[r.id];
      if (b && b[0] !== pid) ops.push({ ruleId: r.id, pid: b[0], rule: null });
      if (!b || b[0] !== pid || b[1] !== hashRule(r)) ops.push({ ruleId: r.id, pid, rule: stripMeta(r) });
    }
    for (const id in base) if (!seen.has(id)) ops.push({ ruleId: id, pid: base[id][0], rule: null });
    return ops;
  }

  // The queue is REPLACED by the current diff, so a rule edited and then edited back
  // drops out instead of uploading a stale value. An op whose content is unchanged is
  // kept as-is (same `at`, so an in-flight flush can still retire it); a changed op
  // keeps when it FIRST started waiting.
  function reconcileQueue(queue, ops, now, reason) {
    const q = {}, old = queue || {};
    for (const op of ops) {
      const k = opKey(op.ruleId, op.pid), prev = old[k];
      const same = !!prev && ((prev.rule === null && op.rule === null) ||
                              (!!prev.rule && !!op.rule && hashRule(prev.rule) === hashRule(op.rule)));
      q[k] = same ? prev : {
        ruleId: op.ruleId, pid: op.pid, rule: op.rule, at: now,
        since: prev ? prev.since : now,
        attempts: prev ? (prev.attempts || 0) : 0,
        reason: reason || (prev ? prev.reason || null : null),
      };
    }
    return q;
  }

  // Server rules + queued ops → what the device should show (unsent changes win).
  function applyQueue(serverArr, queue) {
    const m = new Map();
    for (const r of (serverArr || [])) if (r && r.id) m.set(opKey(r.id, pidOf(r)), r);
    for (const k in (queue || {})) {
      const op = queue[k];
      if (op.rule) m.set(k, op.rule); else m.delete(k);
    }
    return [...m.values()];
  }

  // queue → Map<productId, { ruleId: rule | null }> — one merge-write per product doc
  function queueToPayloads(queue) {
    const m = new Map();
    for (const k in (queue || {})) {
      const op = queue[k];
      if (!m.has(op.pid)) m.set(op.pid, {});
      m.get(op.pid)[op.ruleId] = op.rule;
    }
    return m;
  }

  // Export pure helpers for the offline test harness, then bail in node.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { groupByProduct, flattenDocs, fpRules, stripMeta, canon, hashRule,
                       baselineFromRules, diffRules, reconcileQueue, applyQueue, queueToPayloads };
    return;
  }

  if (window.PricingSync) return;  // guard against double-load

  const PricingSync = {
    cfg: { name: 'PricingSync', col: 'pricing_byproduct', lsKey: 'wt_pricing',
           toastType: 'pricing', unackedKey: 'wt_price_unacked',
           migratedKey: 'wt_price_grouped_migrated',
           queueKey: 'wt_price_pending', baseKey: 'wt_price_baseline' },
    _ready: false, _seeded: false, _migrated: false, _unsub: null,
    _unacked: null, _flushing: false,
    _log: [], _db: null, _deviceId: null,

    _col() { return Sync._orgRef().collection(this.cfg.col); },
    _local() { try { return (DB.getPricing() || []); } catch { return []; } },
    _setLocal(arr) { DB.setLocalOnly(DB.K.PRICING, arr); },

    // ── Time-boxed trust window ─────────────────────────────────────────────
    // See the identical block in collection-sync.js for the full rationale. Within
    // the window this page skips re-attaching the listener; write diffs no longer
    // depend on it, because they use the durable baseline below.
    _TRUST_MS: 60000,
    _trustKey() { return 'wt_cs_trust_' + this.cfg.col; },
    _markAttachTime() { try { sessionStorage.setItem(this._trustKey(), String(Date.now())); } catch {} },
    _withinTrustWindow() {
      try {
        const t = parseInt(sessionStorage.getItem(this._trustKey()) || '0', 10);
        return !!t && (Date.now() - t) < this._TRUST_MS;
      } catch { return false; }
    },

    // ── Durable baseline (server as last seen) and queue ─────────────────────
    _loadBaseline() {
      try { const b = DB._getObj(this.cfg.baseKey, null); return (b && typeof b === 'object' && !Array.isArray(b)) ? b : null; }
      catch { return null; }
    },
    _saveBaseline(b) {
      try { DB.setLocalOnly(this.cfg.baseKey, b); }
      catch (e) { this._logLine('baseline save failed: ' + (e.message || e)); }
    },
    // First run of this version on a device: no stored baseline yet. Local wt_pricing is
    // what the listener last wrote — the server as last seen — so it is the right
    // baseline; an EMPTY one would re-upload every rule from a possibly stale device,
    // the exact clobber this version removes. `from` lets onLocalChange pass the
    // pre-edit array when it is a distinct object.
    _ensureBaseline(from) {
      let b = this._loadBaseline();
      if (!b) {
        b = baselineFromRules(Array.isArray(from) ? from : this._local());
        this._saveBaseline(b);
        this._logLine('baseline initialised from local (' + Object.keys(b).length + ' rules)');
      }
      return b;
    },
    _loadQueue() {
      try { const q = DB._getObj(this.cfg.queueKey, null); return (q && typeof q === 'object' && !Array.isArray(q)) ? q : {}; }
      catch { return {}; }
    },
    _saveQueue(q) {
      try { DB.setLocalOnly(this.cfg.queueKey, q); }
      catch (e) { this._logLine('queue save failed: ' + (e.message || e)); }
    },

    pendingCount() { return Object.keys(this._loadQueue()).length; },

    // One entry for sync.js's pending-upload bar, shaped like a wt_sync_pending entry.
    pendingSummary() {
      const ops = Object.values(this._loadQueue());
      if (!ops.length) return null;
      let since = Infinity, reason = null, attempts = 0;
      for (const op of ops) {
        if ((op.since || Infinity) < since) since = op.since;
        if (op.reason && (!reason || (op.reason.at || '') > (reason.at || ''))) reason = op.reason;
        attempts = Math.max(attempts, op.attempts || 0);
      }
      return { key: this.cfg.lsKey, val: null, ts: since, since, reason, attempts,
               count: ops.length, flushing: this._flushing };
    },
    _emitUpload() { try { if (window.Sync && typeof Sync._emitUploadState === 'function') Sync._emitUploadState(); } catch {} },

    _logLine(msg) {
      const t = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      this._log.push(t + '  ' + msg);
      if (this._log.length > 40) this._log.shift();
      console.log('[PricingSync]', msg);
    },

    _loadUnacked() {
      if (this._unacked) return this._unacked;
      try { this._unacked = new Set(JSON.parse(sessionStorage.getItem(this.cfg.unackedKey) || '[]')); }
      catch { this._unacked = new Set(); }
      return this._unacked;
    },
    _saveUnacked() { try { sessionStorage.setItem(this.cfg.unackedKey, JSON.stringify([...this._loadUnacked()])); } catch {} },

    _isMigrated() {
      if (this._migrated) return true;
      try { if (DB._getObj(this.cfg.migratedKey, false) === true) this._migrated = true; } catch {}
      return this._migrated;
    },
    _markMigrated() { if (this._migrated) return; this._migrated = true; try { DB._set(this.cfg.migratedKey, true); } catch {} },

    _emit() {
      window.dispatchEvent(new CustomEvent('sync:updated', { detail: { key: this.cfg.lsKey } }));
      window.dispatchEvent(new CustomEvent('sync:pulled'));
    },

    async diagnose() {
      const L = [];
      L.push('PricingSync._ready  : ' + this._ready + '   (grouped: 1 doc/product, per-rule writes)');
      L.push('Sync.ready          : ' + (window.Sync && Sync.ready));
      L.push('migrated            : ' + this._isMigrated());
      L.push('pending (queued)    : ' + this.pendingCount() + ' rule change(s)' + (this._flushing ? ' — uploading' : ''));
      L.push('baseline            : ' + Object.keys(this._loadBaseline() || {}).length + ' rules');
      L.push('local rules         : ' + this._local().length);
      L.push('listener attached   : ' + !!this._unsub + (this._unsub ? '' : (this._withinTrustWindow() ? ' (trust window active)' : '')));
      try {
        const snap = await this._col().get();
        let ruleCount = 0; snap.forEach(d => { ruleCount += Object.keys((d.data() || {}).rules || {}).length; });
        L.push('SERVER docs         : ' + snap.size + ' product doc(s), ' + ruleCount + ' rules  (' + this.cfg.col + ')');
      } catch (e) { L.push('SERVER get ERROR    : ' + (e.code || '') + ' ' + (e.message || e)); }
      L.push('— recent activity —');
      L.push(...(this._log.length ? this._log.slice(-18) : ['(no activity logged)']));
      return L.join('\n');
    },

    init() {
      if (this._ready) return;
      if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db || !window.firebase) return;
      this._db = Sync._db; this._deviceId = Sync._deviceId;
      this._loadUnacked(); this._isMigrated();
      this._ensureBaseline();
      this._ready = true;
      this._logLine('init: ready (orgId=' + Sync._orgId + ') pending=' + this.pendingCount());
      if (this._withinTrustWindow()) this._logLine('init: within trust window — skip re-attach');
      else this._attach();
      this._flushPending().catch(() => {});
    },

    _attach() {
      this._markAttachTime();
      this._unsub = this._col().onSnapshot({ includeMetadataChanges: true }, (snap) => {
        const unacked = this._loadUnacked();
        const fromCache = snap.metadata.fromCache;
        this._logLine('snapshot: docs=' + snap.size + ' empty=' + snap.empty + ' fromCache=' + fromCache);

        if (snap.empty) {
          if (!fromCache) {
            // Server genuinely empty. First-run bootstrap: push local up (grouped)
            // rather than wiping local. Mark un-acked so local survives until a
            // non-empty SERVER snapshot confirms the data landed.
            if (!this._isMigrated()) {
              const local = this._local().filter(r => r && r.id);
              if (local.length) {
                const pids = [...groupByProduct(local).keys()];
                this._logLine('bootstrap: migrating ' + local.length + ' rules → ' + pids.length + ' product docs');
                pids.forEach(pid => unacked.add(pid)); this._saveUnacked();
                this._commitProducts(local).catch(e => console.warn('[PricingSync] migrate', e));
              }
            }
            // else: server empty + migrated → keep local-only rules already present (no wipe)
          }
          this._seeded = true; return;
        }

        // Server has product docs → flatten to a rule array.
        const docs = snap.docs.map(d => ({ id: d.id, data: d.data(), pending: d.metadata.hasPendingWrites }));
        const serverRules = flattenDocs(docs);
        const serverPids  = new Set(docs.map(d => d.id));

        // Clear un-acked product ids the server has now acknowledged (bootstrap only).
        let unackedChanged = false;
        for (const d of docs) {
          if (!d.pending && unacked.delete(d.id)) unackedChanged = true;
        }
        if (!fromCache) {
          snap.docChanges().forEach(ch => { if (ch.type === 'removed' && unacked.delete(ch.doc.id)) unackedChanged = true; });
        }
        if (unackedChanged) this._saveUnacked();

        // Rebuild the baseline from the authoritative SERVER state. A doc still carrying
        // this device's own un-acked write keeps its previous baseline entries, so a
        // write the server later rejects is still seen as a difference.
        if (!fromCache) {
          const prevBase = this._loadBaseline() || {};
          const base = baselineFromRules(flattenDocs(docs.filter(d => !d.pending)));
          const pendingPids = new Set(docs.filter(d => d.pending).map(d => d.id));
          for (const id in prevBase) if (pendingPids.has(prevBase[id][0])) base[id] = prevBase[id];
          this._saveBaseline(base);
          this._markMigrated();
        }

        // Retain rules for products written locally but not yet on the server (bootstrap).
        let finalArr = serverRules;
        if (unacked.size) {
          const extra = this._local().filter(r => r && r.id && r.productId &&
            unacked.has(r.productId) && !serverPids.has(r.productId));
          if (extra.length) finalArr = serverRules.concat(extra);
        }
        // Unsent changes win over the server's older copy — this is what stopped a saved
        // price from silently flipping back to the old one.
        const queue = this._loadQueue();
        const queued = Object.keys(queue).length;
        if (queued) finalArr = applyQueue(finalArr, queue);

        this._setLocal(finalArr);
        this._logLine('applied: serverRules=' + serverRules.length + ' queued=' + queued + ' → local=' + this._local().length);
        this._emit();
        if (!fromCache && queued) this._flushPending().catch(() => {});

        if (!this._seeded) { this._seeded = true; return; }
        let shown = 0;
        for (const ch of snap.docChanges()) {
          if (shown >= 3) break;
          const data = ch.doc.data();
          if (!data || data._by === this._deviceId) continue;
          if (ch.doc.metadata.hasPendingWrites) continue;
          if (Sync._activityToast) Sync._activityToast({ typeKey: this.cfg.toastType, action: 'edit', name: 'ราคา', byName: data._byName });
          shown++;
        }
      }, (err) => console.warn('[PricingSync] listener error:', err.code, err.message));
    },

    // db.js hook: DB._set(wt_pricing) → PricingSync.onLocalChange(prev, next).
    // Works whether or not sync is ready: the change is persisted first, then sent.
    onLocalChange(prev, next) {
      try {
        const nextArr = Array.isArray(next) ? next : [];
        const base = this._ensureBaseline((Array.isArray(prev) && prev !== next) ? prev : undefined);
        let ops = diffRules(base, nextArr);
        // v1.0.239: a device whose local wt_pricing came up seeded/incomplete would
        // otherwise queue a delete for every baseline rule it is missing and wipe the
        // collection. Proportional guard — the ราคากลาง retirement (59 of ~3,280) still
        // passes; losing nearly everything does not. Upserts are kept either way.
        const dels = ops.filter(o => o.rule === null).length;
        if (typeof Sync !== 'undefined' && Sync.massDeleteBlocked &&
            Sync.massDeleteBlocked('pricing_byproduct', dels, Object.keys(base || {}).length)) {
          this._logLine('BLOCKED ' + dels + ' rule delete(s) — local looks incomplete');
          ops = ops.filter(o => o.rule !== null);
        }
        const before = this._loadQueue();
        if (!ops.length && !Object.keys(before).length) return;
        const online = !(window.Sync && Sync._online === false);
        const why = !online ? { kind: 'offline' } : (!this._ready ? { kind: 'not-ready' } : null);
        const reason = why ? Object.assign({ at: new Date(Date.now()).toISOString() }, why) : null;
        this._saveQueue(reconcileQueue(before, ops, Date.now(), reason));
        this._logLine('onLocalChange: ' + ops.length + ' changed rule(s) pending' + (why ? ' (' + why.kind + ')' : ''));
        this._emitUpload();
        this._flushPending().catch(() => {});
      } catch (e) { this._logLine('onLocalChange ERROR: ' + (e.message || e)); }
    },

    _meta() {
      return { _by: this._deviceId, _byName: (Sync._deviceName ? Sync._deviceName() : ''),
               _ts: firebase.firestore.FieldValue.serverTimestamp() };
    },

    // Send every queued op — one field-level merge per product doc — and retire only
    // what the server acknowledged. An op re-edited while the commit was in flight has
    // a new `at` and stays queued for the next round.
    async _flushPending() {
      if (!this._ready || this._flushing) return;
      if (window.Sync && Sync._online === false) return;
      const q0 = this._loadQueue();
      const sent = Object.keys(q0).map(k => q0[k]);
      if (!sent.length) return;
      this._flushing = true; this._emitUpload();
      let failed = false;
      try {
        const byPid = new Map();
        for (const op of sent) { if (!byPid.has(op.pid)) byPid.set(op.pid, []); byPid.get(op.pid).push(op); }
        const col = this._col();
        const del = firebase.firestore.FieldValue.delete();
        const pids = [...byPid.keys()];
        for (let i = 0; i < pids.length; i += 400) {
          const chunk = pids.slice(i, i + 400);
          const batch = this._db.batch();
          for (const pid of chunk) {
            const rules = {};
            for (const op of byPid.get(pid)) rules[op.ruleId] = op.rule ? op.rule : del;
            batch.set(col.doc(pid), { productId: pid, rules, ...this._meta() }, { merge: true });
          }
          try { await batch.commit(); }
          catch (e) { failed = true; this._noteFailure(chunk.flatMap(pid => byPid.get(pid)), e); throw e; }
          const cur = this._loadQueue(), base = this._ensureBaseline();
          for (const pid of chunk) for (const op of byPid.get(pid)) {
            if (op.rule) base[op.ruleId] = [op.pid, hashRule(op.rule)];
            else if (base[op.ruleId] && base[op.ruleId][0] === op.pid) delete base[op.ruleId];
            const k = opKey(op.ruleId, op.pid);
            if (cur[k] && cur[k].at === op.at) delete cur[k];
          }
          this._saveBaseline(base);
          this._saveQueue(cur);
          this._logLine('uploaded ' + chunk.length + ' product doc(s)');
        }
      } finally {
        this._flushing = false;
        this._emitUpload();
        if (!failed && this.pendingCount()) setTimeout(() => { this._flushPending().catch(() => {}); }, 0);
      }
    },

    _noteFailure(ops, e) {
      const r = (window.Sync && typeof Sync._reasonFromError === 'function') ? Sync._reasonFromError(e)
        : { kind: 'error', code: String((e && e.code) || ''), message: String((e && e.message) || e || ''), at: new Date(Date.now()).toISOString() };
      const cur = this._loadQueue();
      for (const op of ops) {
        const k = opKey(op.ruleId, op.pid);
        if (cur[k]) { cur[k].reason = r; cur[k].attempts = (cur[k].attempts || 0) + 1; }
      }
      this._saveQueue(cur);
      this._logLine('upload FAILED: ' + (r.code || '') + ' ' + (r.message || ''));
      try {
        if (typeof DB !== 'undefined' && DB.logError) {
          DB.logError('PRICE-SYNC-FAIL', ops.length + ' price change(s) not uploaded: ' + (r.code || '') + ' ' + (r.message || ''), { products: [...new Set(ops.map(o => o.pid))] });
        }
      } catch {}
    },

    // Bootstrap only (server collection empty on first run): write every product whole.
    async _commitProducts(arr) {
      const groups = groupByProduct(arr);
      const col = this._col();
      let batch = this._db.batch(), ops = 0;
      for (const pid of groups.keys()) {
        batch.set(col.doc(pid), { productId: pid, rules: groups.get(pid) || {}, ...this._meta() }, { merge: false });
        if (++ops >= 450) { await batch.commit(); batch = this._db.batch(); ops = 0; }
      }
      if (ops > 0) {
        this._logLine('bootstrap: committing ' + groups.size + ' product doc(s) …');
        await batch.commit();
        this._logLine('bootstrap: commit OK');
      }
    },

    // One-shot additive pull (parity with CollectionSync.pullOnce; not used on the
    // login page for pricing, but kept for diagnose/manual flows).
    async pullOnce() {
      try {
        if (typeof Sync === 'undefined' || !Sync.ready || !Sync._db) return 0;
        if (!this._db) { this._db = Sync._db; this._deviceId = Sync._deviceId; }
        const snap = await this._col().get();
        if (snap.empty) return 0;
        const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
        const serverRules = flattenDocs(docs);
        const serverIds = new Set(serverRules.filter(r => r && r.id).map(r => r.id));
        const local = this._local();
        const merged = serverRules.concat(local.filter(r => r && r.id && !serverIds.has(r.id)));
        this._setLocal(applyQueue(merged, this._loadQueue()));
        this._saveBaseline(baselineFromRules(serverRules));
        if (docs.length) this._markMigrated();
        return serverRules.length;
      } catch (e) { console.warn('[PricingSync] pullOnce', e); return -1; }
    },
  };

  window.PricingSync = PricingSync;
  window.addEventListener('sync:ready', () => { try { PricingSync.init(); } catch (e) { console.warn('[PricingSync] init', e); } });
  window.addEventListener('online', () => { PricingSync._flushPending().catch(() => {}); });
  // Record the baseline as soon as local data is loaded — before the user can edit —
  // so a device's first edit on this version is diffed against the pre-edit state.
  try { if (typeof DB !== 'undefined' && DB.ready && DB.ready.then) DB.ready.then(() => { try { PricingSync._ensureBaseline(); } catch {} }); } catch {}
  if (typeof Sync !== 'undefined' && Sync.ready) { try { PricingSync.init(); } catch {} }
})();
