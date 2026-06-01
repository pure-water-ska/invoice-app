// user-sync.js — user accounts synced via the single-source-of-truth model.
// Thin instance of CollectionSync (see collection-sync.js). Replaces the old
// whole-array DOCUMENT sync for wt_users (removed from sync.js DOCUMENTS), which
// shared the in-place-mutation diff bug (DB.addUser mutates the cached array) —
// the likely reason a newly created user didn't reach the other device.
//
// Login safety: the login page calls UserSync.pullOnce() (additive, never removes
// local accounts) so server-only accounts are available before login, and local
// accounts always remain even if the server collection is empty.
if (!window.UserSync && window.CollectionSync) {
  window.UserSync = CollectionSync.create({
    name:        'UserSync',
    col:         'users_v2',
    lsKey:       'wt_users',
    toastType:   'users_cfg',
    unackedKey:  'wt_user_unacked',
    migratedKey: 'wt_users_v2_migrated',
    getLocal:    () => DB.getUsers(),
    setLocal:    (arr) => DB.setLocalOnly(DB.K.USERS, arr),
    dedupKey:    (u) => (u && u.username != null ? String(u.username) : null),
    bootstrapMigrate: true,
  });
}
