// pricing-sync.js — pricing rules synced via the single-source-of-truth model.
// Thin instance of CollectionSync (see collection-sync.js). Replaces the old
// whole-array DOCUMENT sync for wt_pricing (removed from sync.js DOCUMENTS).
// Pricing rows have no name; duplicates are collapsed by their composite key
// (productId + customerId + shippingMethod), matching DB.upsertPrice's identity.
if (!window.PricingSync && window.CollectionSync) {
  window.PricingSync = CollectionSync.create({
    name:        'PricingSync',
    col:         'pricing_v2',
    lsKey:       'wt_pricing',
    toastType:   'pricing',
    unackedKey:  'wt_price_unacked',
    migratedKey: 'wt_price_v2_migrated',
    getLocal:    () => DB.getPricing(),
    setLocal:    (arr) => DB.setLocalOnly(DB.K.PRICING, arr),
    dedupKey:    (r) => r ? ((r.productId || '') + '|' + (r.customerId || '') + '|' + (r.shippingMethod || '')) : null,
    bootstrapMigrate: true,
  });
}
