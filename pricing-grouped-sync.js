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

(function () {
  'use strict';

  // ── Pure helpers (also exported for the node round-trip test) ───────────────
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

  // Export pure helpers for the offline test harness, then bail in node.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { groupByProduct, flattenDocs, fpRules, stripMeta };
    return;
  }

  if (window.PricingSync) return;  // guard against double-load

  const PricingSync = {
    cfg: { name: 'PricingSync', col: 'pricing_byproduct', lsKey: 'wt_pricing',
           toastType: 'pricing', unackedKey: 'wt_price_unacked',
           migratedKey: 'wt_price_grouped_migrated' },
    _ready: false, _seeded: false, _migrated: false, _unsub: null,
    _pending: [], _unacked: null,
    _serverFp: new Map(),          // Map<productId, fpRules(...)>  — for write diffing
    _log: [], _db: null, _deviceId: null,

    _col() { return Sync._orgRef().collection(this.cfg.col); },
    _local() { try { return (DB.getPricing() || []); } catch { return []; } },
    _setLocal(arr) { DB.setLocalOnly(DB.K.PRICING, arr); },

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
      L.push('PricingSync._ready  : ' + this._ready + '   (grouped: 1 doc/product)');
      L.push('Sync.ready          : ' + (window.Sync && Sync.ready));
      L.push('migrated            : ' + this._isMigrated());
      L.push('un-acked products   : ' + [...this._loadUnacked()].length);
      L.push('local rules         : ' + this._local().length);
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
      this._ready = true;
      this._logLine('init: ready (orgId=' + Sync._orgId + ')');
      this._attach();
      const q = this._pending.splice(0);
      q.forEach(n => this._pushLocal(n).catch(e => console.warn('[PricingSync] queued push', e)));
    },

    _attach() {
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

        // Clear un-acked product ids the server has now acknowledged.
        let unackedChanged = false;
        for (const d of docs) {
          if (!d.pending && unacked.delete(d.id)) unackedChanged = true;
        }
        if (!fromCache) {
          snap.docChanges().forEach(ch => { if (ch.type === 'removed' && unacked.delete(ch.doc.id)) unackedChanged = true; });
        }
        if (unackedChanged) this._saveUnacked();

        // Rebuild the write-diff fingerprint from the authoritative SERVER state.
        if (!fromCache) {
          const fp = new Map();
          for (const d of docs) fp.set(d.id, fpRules((d.data || {}).rules || {}));
          this._serverFp = fp;
          this._markMigrated();
        }

        // Retain rules for products written locally but not yet on the server.
        let finalArr = serverRules;
        if (unacked.size) {
          const extra = this._local().filter(r => r && r.id && r.productId &&
            unacked.has(r.productId) && !serverPids.has(r.productId));
          if (extra.length) finalArr = serverRules.concat(extra);
        }

        this._setLocal(finalArr);
        this._logLine('applied: serverRules=' + serverRules.length + ' final=' + finalArr.length + ' → local=' + this._local().length);
        this._emit();

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

    // db.js hook: DB._set(wt_pricing) → PricingSync.onLocalChange(prev, next)
    onLocalChange(prev, next) {
      this._logLine('onLocalChange next=' + (Array.isArray(next) ? next.length : 0) + ' ready=' + this._ready);
      this._pushLocal(next).catch(e => this._logLine('push REJECTED: ' + (e.code || '') + ' ' + (e.message || e)));
    },

    async _pushLocal(next) {
      if (!this._ready) { this._pending.push(next); this._logLine('not ready → queued'); return; }
      const groups = groupByProduct(Array.isArray(next) ? next : []);
      const localFp = new Map();
      for (const [pid, rulesObj] of groups) localFp.set(pid, fpRules(rulesObj));

      const upsertPids = [...localFp.keys()].filter(pid => this._serverFp.get(pid) !== localFp.get(pid));
      const deletePids = [...this._serverFp.keys()].filter(pid => !groups.has(pid));
      if (!upsertPids.length && !deletePids.length) return;

      const unacked = this._loadUnacked();
      upsertPids.forEach(pid => unacked.add(pid));
      deletePids.forEach(pid => unacked.delete(pid));
      this._saveUnacked();

      await this._commitProductDocs(groups, upsertPids, deletePids);
    },

    // Commit a full rule array (bootstrap helper) — writes every product it spans.
    async _commitProducts(arr) {
      const groups = groupByProduct(arr);
      await this._commitProductDocs(groups, [...groups.keys()], []);
    },

    async _commitProductDocs(groups, upsertPids, deletePids) {
      if (!upsertPids.length && !deletePids.length) return;
      const col = this._col();
      const meta = () => ({ _by: this._deviceId, _byName: Sync._deviceName(),
                            _ts: firebase.firestore.FieldValue.serverTimestamp() });
      let batch = this._db.batch(), ops = 0;
      const flush = async () => { await batch.commit(); batch = this._db.batch(); ops = 0; };
      for (const pid of upsertPids) {
        batch.set(col.doc(pid), { productId: pid, rules: groups.get(pid) || {}, ...meta() }, { merge: false });
        if (++ops >= 450) await flush();
      }
      for (const pid of deletePids) {
        batch.delete(col.doc(pid));
        if (++ops >= 450) await flush();
      }
      if (ops > 0) {
        this._logLine('committing ' + upsertPids.length + ' product upsert, ' + deletePids.length + ' delete …');
        await batch.commit();
        this._logLine('commit OK');
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
        this._setLocal(serverRules.concat(local.filter(r => r && r.id && !serverIds.has(r.id))));
        const fp = new Map();
        for (const d of docs) fp.set(d.id, fpRules((d.data || {}).rules || {}));
        this._serverFp = fp;
        if (docs.length) this._markMigrated();
        return serverRules.length;
      } catch (e) { console.warn('[PricingSync] pullOnce', e); return -1; }
    },
  };

  window.PricingSync = PricingSync;
  window.addEventListener('sync:ready', () => { try { PricingSync.init(); } catch (e) { console.warn('[PricingSync] init', e); } });
  if (typeof Sync !== 'undefined' && Sync.ready) { try { PricingSync.init(); } catch {} }
})();
