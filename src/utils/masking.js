/**
 * Data privacy masking helpers for sensitive identity numbers.
 */

function maskAadhaar(aadhaar) {
  if (!aadhaar) return '';
  const cleaned = aadhaar.toString().replace(/\D/g, '');
  if (cleaned.length < 4) return aadhaar;
  const last4 = cleaned.slice(-4);
  return `XXXX-XXXX-${last4}`;
}

function maskPan(pan) {
  if (!pan) return '';
  const str = pan.toString().trim().toUpperCase();
  if (str.length !== 10) return str;
  return `${str.slice(0, 5)}****${str.slice(-1)}`;
}

module.exports = {
  maskAadhaar,
  maskPan
};
