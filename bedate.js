// bedate.js — Flatpickr wrapper that displays Buddhist Era (B.E.) years in date inputs.
// Must be loaded AFTER flatpickr.min.js and utils.js.

const BEDate = {
  _opts() {
    return {
      allowInput: true,
      dateFormat: 'd/m/Y',
      // Display with B.E. year (+543)
      formatDate(date) {
        const dd   = String(date.getDate()).padStart(2, '0');
        const mm   = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear() + 543;
        return `${dd}/${mm}/${yyyy}`;
      },
      // Parse "DD/MM/YYYY" B.E. back to CE Date; falls back to ISO strings for setDate() calls
      parseDate(str) {
        if (!str) return null;
        const p = String(str).split('/');
        if (p.length === 3) {
          const yearCE = parseInt(p[2]) - 543;
          if (!isNaN(yearCE) && yearCE >= 1900 && yearCE <= 2100) {
            const d = new Date(yearCE, parseInt(p[1]) - 1, parseInt(p[0]));
            if (!isNaN(d.getTime())) return d;
          }
        }
        // Fallback: let flatpickr parse ISO or other native formats (used by fp.setDate("YYYY-MM-DD"))
        const fb = new Date(str);
        return isNaN(fb.getTime()) ? null : fb;
      },
    };
  },

  /**
   * Attach flatpickr B.E. to a DOM element.
   * @param {HTMLElement} el
   * @param {Object} extra  Extra flatpickr options (e.g. { onChange, defaultDate })
   * @returns {Object} flatpickr instance
   */
  init(el, extra = {}) {
    if (!el) return null;
    if (el._flatpickr) el._flatpickr.destroy();
    return flatpickr(el, { ...this._opts(), ...extra });
  },

  /**
   * Attach by element ID. Returns the flatpickr instance.
   */
  byId(id, extra = {}) {
    return this.init(document.getElementById(id), extra);
  },

  /**
   * Attach to all elements matching a CSS selector.
   * Returns a map of { el.id → instance }.
   */
  all(selector, extra = {}) {
    const insts = {};
    document.querySelectorAll(selector).forEach(el => {
      insts[el.id || el.dataset.pid || ''] = this.init(el, extra);
    });
    return insts;
  },
};
