// product-sync.js — products synced via the single-source-of-truth model.
// Thin instance of CollectionSync (see collection-sync.js). Replaces the old
// whole-array DOCUMENT sync for wt_products (removed from sync.js DOCUMENTS).
if (!window.ProductSync && window.CollectionSync) {
  window.ProductSync = CollectionSync.create({
    name:        'ProductSync',
    col:         'products_v2',
    lsKey:       'wt_products',
    toastType:   'products',
    unackedKey:  'wt_prod_unacked',
    migratedKey: 'wt_prod_v2_migrated',
    getLocal:    () => DB.getProducts(),
    setLocal:    (arr) => DB.setLocalOnly(DB.K.PRODUCTS, arr),
    dedupKey:    (r) => (r && r.name != null ? String(r.name) : null),
    bootstrapMigrate: true,   // existing products live in the old doc → seed products_v2 on first run
  });
}
