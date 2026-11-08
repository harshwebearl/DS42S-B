/**
 * Currency utilities for exact integer paise calculations.
 * 1 Rupee = 100 Paise.
 * Eliminates IEEE 754 floating point arithmetic issues.
 */

// Converts Rupee amount (number or string, e.g. 1000 or "1000.50") to integer Paise (e.g. 100050)
function rupeesToPaise(rupees) {
  if (rupees === null || rupees === undefined || rupees === '') return 0;
  const num = typeof rupees === 'string' ? parseFloat(rupees) : rupees;
  if (isNaN(num)) return 0;
  return Math.round(num * 100);
}

// Converts integer Paise to Rupees (e.g. 100050 -> 1000.50)
function paiseToRupees(paise) {
  if (paise === null || paise === undefined) return 0;
  const p = parseInt(paise, 10);
  if (isNaN(p)) return 0;
  return p / 100;
}

// Formats integer Paise into Indian Rupee currency string, e.g. ₹1,00,000.00
function formatINR(paise) {
  const rs = paiseToRupees(paise);
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(rs);
}

module.exports = {
  rupeesToPaise,
  paiseToRupees,
  formatINR
};
